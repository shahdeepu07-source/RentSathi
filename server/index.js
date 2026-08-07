import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import authRoutes from './auth.js';
import notificationRoutes from './notifications.js';
import { verifyToken } from './middleware.js';
import { createUser } from './auth.js';
import { resolveDataDir } from './paths.js';
import { getUsers, saveUsers, getOwnership, saveOwnership, readTenants, writeTenants, listHouseIds, houseExists, renameHouse, deleteHousePermanent, getNotifs, saveNotifs, getUpgradeRequests, saveUpgradeRequests, getPayments, savePayments } from './db.js';
import { computeAmount, paymentForm, paymentEndpoint, verifyResponseData, checkTransactionStatus } from './esewa.js';
import { seedDemoData } from './seed-demo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

const DATA_DIR = await resolveDataDir();
const RATE = 15;
const app = express();

app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());

// ─── Public eSewa callbacks (eSewa redirects the browser here with NO
// bearer token, so these must be registered before the auth middleware) ──
app.get('/api/subscription/esewa/success', async (req, res) => {
    const { data } = req.query;
    try {
        const cb = verifyResponseData(data);
        const pid = (cb && cb.transaction_uuid) || req.query.pid;
        if (!pid) return res.redirect('/payment-result.html?status=missing');
        const payments = await getPayments();
        const p = payments.find(x => x.pid === pid);
        if (!p) return res.redirect('/payment-result.html?status=missing');
        if (cb && parseInt(cb.total_amount, 10) !== p.amount) {
            p.status = 'failed';
            await savePayments(payments);
            return res.redirect('/payment-result.html?status=amount_mismatch');
        }

        const st = await checkTransactionStatus({ transaction_uuid: pid, total_amount: String(p.amount) });
        if (!st || st.status !== 'COMPLETE' || parseInt(st.total_amount, 10) !== p.amount) {
            p.status = 'failed';
            await savePayments(payments);
            return res.redirect('/payment-result.html?status=failed');
        }

        const refId = cb.transaction_code || st.ref_id || null;
        p.status = 'paid';
        p.refId = refId;
        p.verifiedAt = new Date().toISOString();
        await savePayments(payments);

        const reqs = await getUpgradeRequests();
        const rq = reqs.find(r => r.pid === pid);
        if (rq) {
            rq.status = 'approved';
            rq.paid = true;
            rq.refId = refId;
            rq.respondedAt = new Date().toISOString();
            await saveUpgradeRequests(reqs);
        }

        const users = await getUsers();
        const u = users.find(x => String(x.id) === String(p.userId));
        if (u) {
            u.subscription_status = 'paid';
            u.subscription_plan = p.plan;
            u.billing_cycle = p.cycle;
            u.subscription_tenants = p.tenants;
            u.last_payment = { amount: p.amount, refId, cycle: p.cycle, paidAt: p.verifiedAt };
            await saveUsers(users);
        }
        res.redirect('/payment-result.html?status=success');
    } catch (err) {
        console.error('eSewa success callback error:', err);
        res.redirect('/payment-result.html?status=error');
    }
});

app.get('/api/subscription/esewa/failure', async (req, res) => {
    const { data } = req.query;
    try {
        const cb = verifyResponseData(data);
        const pid = (cb && cb.transaction_uuid) || req.query.pid;
        if (pid) {
            const payments = await getPayments();
            const p = payments.find(x => x.pid === pid);
            if (p) { p.status = 'failed'; await savePayments(payments); }
        }
    } catch (err) { console.error('eSewa failure callback error:', err); }
    res.redirect('/payment-result.html?status=failed');
});

app.use('/api/auth', authRoutes);
app.use('/api', verifyToken);
app.use('/api', notificationRoutes);

await fs.mkdir(DATA_DIR, { recursive: true });

async function getUserById(userId) {
    const users = await getUsers(true);
    return users.find(u => u.id == userId) || null;
}

// ─── Subscription gate ────────────────────────────────────────
// Owners with an expired/inactive/cancelled plan may log in and read, but
// write actions (bills, tenants, houses, payments) are blocked until they
// subscribe again. Other roles pass through unchanged.
const BLOCKED_STATUSES = ['expired', 'inactive', 'cancelled'];
async function requireSubscription(req, res) {
    if (req.user.role !== 'owner') return true;
    const users = await getUsers(false);
    const u = users.find(x => String(x.id) === String(req.user.userId));
    if (!u) return true;
    if (u.subscription_status === 'trial' && u.trial_end && new Date() > new Date(u.trial_end)) {
        u.subscription_status = 'expired';
        await saveUsers(users);
    }
    if (BLOCKED_STATUSES.includes(u.subscription_status)) {
        res.status(403).json({
            code: 'SUBSCRIPTION_REQUIRED',
            error: 'Your subscription has ended. Get a subscription to continue using SajiloRent.'
        });
        return false;
    }
    return true;
}

// Houses the current user may access.
//  - superadmin  → all active houses
//  - admin       → all active houses; M_house is exclusive to the `admin`
//                  account (admin/5545)
//  - owner       → houses they own
async function accessibleHouses(user, includeDeleted = false) {
    const ownership = await getOwnership();
    const allHouses = await listHouseIds();
    if (user.role === 'superadmin') {
        return allHouses.filter(h => includeDeleted || !ownership[h]?.deleted);
    }
    if (user.role === 'admin') {
        const list = user.username === 'admin' ? allHouses.slice() : allHouses.filter(h => h !== 'M_house');
        return list.filter(h => includeDeleted || !ownership[h]?.deleted);
    }
    return allHouses.filter(h => {
        const owner = ownership[h];
        return owner && owner.owner_id == user.userId && (includeDeleted || !owner.deleted);
    });
}

async function canAccessMHouse(user) {
    if (!user) return false;
    if (user.role === 'superadmin') return true;
    return user.role === 'admin' && user.username === 'admin';
}

async function checkOwnership(houseId, user) {
    if (user.role === 'superadmin') return true;
    if (houseId === 'M_house' && !(await canAccessMHouse(user))) return false;
    if (user.role === 'admin') {
        const houses = await accessibleHouses(user);
        return houses.includes(houseId);
    }
    const ownership = await getOwnership();
    const owner = ownership[houseId];
    return owner && owner.owner_id == user.userId && !owner.deleted;
}

async function initOwnership() {
    const existing = await getOwnership();
    if (existing && Object.keys(existing).length) {
        console.log('Ownership data loaded');
        return;
    }
    await saveOwnership({
        "M_house": {
            owner_id: 1,
            created_by: 1,
            created_at: new Date().toISOString(),
            deleted: false,
            deleted_at: null
        }
    });
    console.log('Ownership initialised with default M_house (owner: admin)');
}
await initOwnership();
await initNotifFile();

// ─── Houses ──────────────────────────────────────────────────
app.get('/api/houses', async (req, res) => {
    try {
        const visibleHouses = await accessibleHouses(req.user);
        res.json(visibleHouses);
    } catch (err) {
        console.error('Error loading houses:', err);
        res.status(500).json({ error: 'Failed to load houses' });
    }
});

app.get('/api/houses/ownership', async (req, res) => {
    try {
        const ownership = await getOwnership();
        const access = await accessibleHouses(req.user);
        const active = {};
        for (const [key, val] of Object.entries(ownership)) {
            if (!val.deleted && access.includes(key)) active[key] = val;
        }
        res.json(active);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load ownership' });
    }
});

app.post('/api/houses', async (req, res) => {
    if (!(await requireSubscription(req, res))) return;
    try {
        const { name, address, owner_id } = req.body;
        const userId = req.user.userId;
        const userRole = req.user.role;
        const user = req.user;
        if (name === 'M_house' && !(await canAccessMHouse(user))) {
            return res.status(403).json({ error: 'You do not have permission to manage M_house' });
        }
        if (!name) return res.status(400).json({ error: 'House name required' });
        let finalOwnerId = userId;
        if (['admin', 'superadmin'].includes(userRole) && owner_id) finalOwnerId = owner_id;
        if (await houseExists(name)) {
            return res.status(400).json({ error: 'House already exists' });
        }
        await writeTenants(name, []);
        const ownership = await getOwnership();
        ownership[name] = {
            owner_id: finalOwnerId,
            created_by: userId,
            created_at: new Date().toISOString(),
            deleted: false,
            deleted_at: null
        };
        await saveOwnership(ownership);
        res.status(201).json({ id: name, name, address: address || '', owner_id: finalOwnerId });
    } catch (err) {
        console.error('Error creating house:', err);
        res.status(500).json({ error: 'Failed to create house' });
    }
});

app.put('/api/houses/:id', async (req, res) => {
    if (!(await requireSubscription(req, res))) return;
    try {
        let houseId = req.params.id;
        const userRole = req.user.role;
        const user = req.user;
        if (houseId === 'M_house' && !(await canAccessMHouse(user))) {
            return res.status(403).json({ error: 'You do not have permission to manage M_house' });
        }
        if (!['admin', 'superadmin'].includes(userRole)) {
            return res.status(403).json({ error: 'Admin or SuperAdmin access required' });
        }
        if (!(await checkOwnership(houseId, req.user))) {
            return res.status(403).json({ error: 'You do not have access to this house' });
        }
        const { name, address, owner_id } = req.body;
        const ownership = await getOwnership();
        if (!ownership[houseId]) {
            return res.status(404).json({ error: 'House not found' });
        }
        if (name && name !== houseId) {
            if (await houseExists(name)) {
                return res.status(400).json({ error: 'A house with that name already exists' });
            }
            await renameHouse(houseId, name);
            const oldEntry = ownership[houseId];
            delete ownership[houseId];
            ownership[name] = oldEntry;
            houseId = name;
        }
        if (address !== undefined) ownership[houseId].address = address;
        if (owner_id !== undefined) ownership[houseId].owner_id = owner_id;
        await saveOwnership(ownership);
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating house:', err);
        res.status(500).json({ error: 'Failed to update house' });
    }
});

app.post('/api/houses/:id/delete', async (req, res) => {
    if (!(await requireSubscription(req, res))) return;
    try {
        const houseId = req.params.id;
        const userRole = req.user.role;
        const user = req.user;
        if (houseId === 'M_house' && !(await canAccessMHouse(user))) {
            return res.status(403).json({ error: 'You do not have permission to manage M_house' });
        }
        if (!['admin', 'superadmin'].includes(userRole)) {
            return res.status(403).json({ error: 'Only admin can delete houses' });
        }
        if (!(await checkOwnership(houseId, req.user))) {
            return res.status(403).json({ error: 'You do not have access to this house' });
        }
        const ownership = await getOwnership();
        if (!ownership[houseId]) {
            // Orphan house: store file exists but no ownership record
            // (e.g. left behind by an old failed delete). Auto-register it
            // under the requester so it can be trashed and removed normally.
            if (await houseExists(houseId)) {
                ownership[houseId] = {
                    owner_id: req.user.userId,
                    created_by: req.user.userId,
                    created_at: new Date().toISOString(),
                    deleted: true,
                    deleted_at: new Date().toISOString()
                };
                await saveOwnership(ownership);
                return res.json({ success: true });
            }
            return res.status(404).json({ error: 'House not found' });
        }
        if (ownership[houseId].deleted) {
            return res.status(400).json({ error: 'House already deleted' });
        }
        ownership[houseId].deleted = true;
        ownership[houseId].deleted_at = new Date().toISOString();
        await saveOwnership(ownership);
        console.log(`House "${houseId}" moved to trash`);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting house:', err);
        res.status(500).json({ error: 'Failed to delete house' });
    }
});

app.get('/api/admin/trash/houses', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const ownership = await getOwnership();
    const access = await accessibleHouses(req.user, true);
    let deleted = Object.keys(ownership)
        .filter(k => ownership[k].deleted === true && access.includes(k));
    res.json(deleted.map(k => ({ name: k, ...ownership[k] })));
});

app.post('/api/admin/trash/houses/restore/:houseId', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const houseId = req.params.houseId;
    const user = req.user;
    if (houseId === 'M_house' && !(await canAccessMHouse(user))) {
        return res.status(403).json({ error: 'You do not have permission to manage M_house' });
    }
    const ownership = await getOwnership();
    if (!ownership[houseId] || !ownership[houseId].deleted) {
        return res.status(404).json({ error: 'Deleted house not found' });
    }
    const access = await accessibleHouses(req.user, true);
    if (!access.includes(houseId)) {
        return res.status(403).json({ error: 'You do not have access to this house' });
    }
    ownership[houseId].deleted = false;
    ownership[houseId].deleted_at = null;
    await saveOwnership(ownership);
    res.json({ success: true });
});

app.delete('/api/admin/trash/houses/permanent/:houseId', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const houseId = req.params.houseId;
    const user = req.user;
    if (houseId === 'M_house' && !(await canAccessMHouse(user))) {
        return res.status(403).json({ error: 'You do not have permission to manage M_house' });
    }
    const ownership = await getOwnership();
    if (!ownership[houseId]) {
        // Orphan house file with no ownership record — remove the file directly.
        if (await houseExists(houseId)) {
            try {
                await deleteHousePermanent(houseId);
                return res.json({ success: true });
            } catch (err) {
                console.error('Error permanently deleting orphan house:', err);
                return res.status(500).json({ error: 'Failed to permanently delete house' });
            }
        }
        return res.status(404).json({ error: 'Deleted house not found' });
    }
    if (!ownership[houseId].deleted) {
        return res.status(404).json({ error: 'Deleted house not found' });
    }
    const access = await accessibleHouses(req.user, true);
    if (!access.includes(houseId)) {
        return res.status(403).json({ error: 'You do not have access to this house' });
    }
    try {
        await deleteHousePermanent(houseId);
        delete ownership[houseId];
        await saveOwnership(ownership);
        res.json({ success: true });
    } catch (err) {
        console.error('Error permanently deleting house:', err);
        res.status(500).json({ error: 'Failed to permanently delete house' });
    }
});

app.get('/api/admin/trash/users', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    try {
        const users = await getUsers(true);
        const deleted = users.filter(u => u.deleted === true);
        res.json(deleted);
    } catch (err) {
        console.error('Error fetching deleted users:', err);
        res.status(500).json({ error: 'Failed to fetch deleted users' });
    }
});

app.post('/api/admin/trash/users/restore/:userId', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const userId = parseInt(req.params.userId);
    try {
        const users = await getUsers(true);
        const user = users.find(u => u.id === userId);
        if (!user || !user.deleted) {
            return res.status(404).json({ error: 'Deleted user not found' });
        }
        user.deleted = false;
        user.deleted_at = null;
        await saveUsers(users);
        res.json({ success: true });
    } catch (err) {
        console.error('Error restoring user:', err);
        res.status(500).json({ error: 'Failed to restore user' });
    }
});

app.delete('/api/admin/trash/users/permanent/:userId', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const userId = parseInt(req.params.userId);
    try {
        let users = await getUsers(true);
        const idx = users.findIndex(u => u.id === userId);
        if (idx === -1 || !users[idx].deleted) {
            return res.status(404).json({ error: 'Deleted user not found' });
        }
        users.splice(idx, 1);
        await saveUsers(users);
        res.json({ success: true });
    } catch (err) {
        console.error('Error permanently deleting user:', err);
        res.status(500).json({ error: 'Failed to permanently delete user' });
    }
});

app.post('/api/admin/users/:userId/delete', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const userId = parseInt(req.params.userId);
    try {
        const users = await getUsers(true);
        const user = users.find(u => u.id === userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'superadmin') return res.status(403).json({ error: 'Cannot delete SuperAdmin' });
        if (user.deleted) return res.status(400).json({ error: 'User already deleted' });
        user.deleted = true;
        user.deleted_at = new Date().toISOString();
        await saveUsers(users);
        console.log(`User "${user.username}" (${user.role}) moved to trash`);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting user:', err);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

app.patch('/api/admin/subscription/:userId', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const userId = parseInt(req.params.userId);
    const { action, duration } = req.body;
    try {
        const users = await getUsers(true);
        const user = users.find(u => u.id === userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role !== 'owner') return res.status(400).json({ error: 'Subscription only for owners' });
        switch (action) {
            case 'activate':
                user.subscription_status = 'active';
                break;
            case 'deactivate':
                user.subscription_status = 'inactive';
                break;
            case 'cancel':
                user.subscription_status = 'cancelled';
                break;
            case 'extend':
                if (!duration) return res.status(400).json({ error: 'Duration in days required for extend' });
                const currentEnd = user.trial_end ? new Date(user.trial_end) : new Date();
                const newEnd = new Date(currentEnd);
                newEnd.setDate(newEnd.getDate() + parseInt(duration));
                user.trial_end = newEnd.toISOString();
                user.subscription_status = 'active';
                break;
            default:
                return res.status(400).json({ error: 'Invalid action' });
        }
        await saveUsers(users);
        res.json({ success: true, user });
    } catch (err) {
        console.error('Error managing subscription:', err);
        res.status(500).json({ error: 'Failed to manage subscription' });
    }
});

app.get('/api/tenants', async (req, res) => {
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (houseId === 'M_house' && !(await canAccessMHouse(req.user))) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        const tenants = await readTenants(houseId);
        const active = tenants.filter(t => !t.deleted);
        res.json(active);
    } catch (err) {
        console.error('Error loading tenants:', err);
        res.status(500).json({ error: 'Failed to load tenants' });
    }
});

app.post('/api/tenants', async (req, res) => {
    if (!(await requireSubscription(req, res))) return;
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (houseId === 'M_house' && !(await canAccessMHouse(req.user))) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        // Tenant quota: owners on a paid plan cannot exceed their tenant limit
        if (req.user.role === 'owner') {
            const users = await getUsers(false);
            const u = users.find(x => String(x.id) === String(req.user.userId));
            const limit = u && u.subscription_tenants != null ? u.subscription_tenants : Infinity;
            if (Number.isFinite(limit)) {
                let count = 0;
                const houses = await accessibleHouses(req.user);
                for (const h of houses) {
                    count += (await readTenants(h)).filter(t => !t.deleted).length;
                }
                if (count >= limit) {
                    return res.status(403).json({
                        code: 'TENANT_LIMIT_REACHED',
                        tenants: count,
                        limit,
                        error: `Your plan covers ${limit} tenants. Upgrade to add more.`
                    });
                }
            }
        }
        const { name, rent_amount, last_reading, tenant_username, tenant_password, tenant_fullName, tenant_phone, tenant_email, tenant_address } = req.body;
        if (!name || rent_amount == null) return res.status(400).json({ error: 'Name and rent required' });
        const tenants = await readTenants(houseId);
        let tenant_user_id = null;
        if (tenant_username && tenant_password) {
            try {
                const newUser = await createUser(tenant_username, tenant_password, 'tenant', {
                    fullName: tenant_fullName || name,
                    phone: tenant_phone || '',
                    email: tenant_email || '',
                    address: tenant_address || ''
                });
                tenant_user_id = newUser.id;
                console.log(`Tenant user "${tenant_username}" created with ID ${newUser.id}`);
            } catch (err) {
                return res.status(400).json({ error: 'Failed to create tenant user: ' + err.message });
            }
        }
        const newTenant = {
            id: Date.now(),
            name,
            rent_amount: Number(rent_amount),
            last_reading: Number(last_reading || 0),
            phone: tenant_phone || '',
            email: tenant_email || '',
            address: tenant_address || '',
            tenant_user_id: tenant_user_id,
            balance: 0,
            deleted: false,
            deleted_at: null,
            history: []
        };
        tenants.push(newTenant);
        await writeTenants(houseId, tenants);
        res.status(201).json(newTenant);
    } catch (err) {
        console.error('Error creating tenant:', err);
        res.status(500).json({ error: 'Failed to add tenant' });
    }
});

app.put('/api/tenants/:id', async (req, res) => {
    if (!(await requireSubscription(req, res))) return;
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (houseId === 'M_house' && !(await canAccessMHouse(req.user))) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        const id = parseInt(req.params.id);
        const { name, rent_amount, last_reading, phone, email, address } = req.body;
        let tenants = await readTenants(houseId);
        const idx = tenants.findIndex(t => t.id === id);
        if (idx === -1) return res.status(404).json({ error: 'Tenant not found' });
        if (tenants[idx].deleted) return res.status(400).json({ error: 'Cannot edit deleted tenant' });
        tenants[idx] = {
            ...tenants[idx],
            name: name || tenants[idx].name,
            rent_amount: rent_amount != null ? Number(rent_amount) : tenants[idx].rent_amount,
            last_reading: last_reading != null ? Number(last_reading) : tenants[idx].last_reading,
            phone: phone !== undefined ? phone : tenants[idx].phone,
            email: email !== undefined ? email : tenants[idx].email,
            address: address !== undefined ? address : tenants[idx].address
        };
        await writeTenants(houseId, tenants);
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating tenant:', err);
        res.status(500).json({ error: 'Update failed' });
    }
});

app.post('/api/tenants/:id/delete', async (req, res) => {
    if (!(await requireSubscription(req, res))) return;
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (houseId === 'M_house' && !(await canAccessMHouse(req.user))) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        const tenantId = parseInt(req.params.id);
        let tenants = await readTenants(houseId);
        const idx = tenants.findIndex(t => t.id === tenantId);
        if (idx === -1) return res.status(404).json({ error: 'Tenant not found' });
        if (tenants[idx].deleted) return res.status(400).json({ error: 'Already deleted' });
        tenants[idx].deleted = true;
        tenants[idx].deleted_at = new Date().toISOString();
        await writeTenants(houseId, tenants);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting tenant:', err);
        res.status(500).json({ error: 'Failed to delete tenant' });
    }
});

// ─── Bills ─────────────────────────────────────────────────────
app.post('/api/calculate', async (req, res) => {
    if (!(await requireSubscription(req, res))) return;
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (houseId === 'M_house' && !(await canAccessMHouse(req.user))) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        const { id, curr, water, waste, due, ded, month, dedReason, note } = req.body;
        if (!id || curr == null) return res.status(400).json({ error: 'Tenant ID and current reading required' });
        let tenants = await readTenants(houseId);
        const tenant = tenants.find(t => t.id == id);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (tenant.deleted) return res.status(400).json({ error: 'Cannot generate bill for deleted tenant' });
        const prev = tenant.last_reading || 0;
        const units = Number(curr) - Number(prev);
        if (units < 0) return res.status(400).json({ error: 'Current reading cannot be less than previous' });
        const electricity = units * RATE;
        const total = electricity + Number(tenant.rent_amount) + Number(water || 0) + 
                      Number(waste || 0) + Number(due || 0) - Number(ded || 0);
        const bill = {
            id: Date.now(),
            name: tenant.name,
            month: month || new Date().toLocaleString('default', { month: 'long', year: 'numeric' }),
            prev,
            curr: Number(curr),
            units,
            electricity,
            rent: tenant.rent_amount,
            water: Number(water || 0),
            waste: Number(waste || 0),
            due: Number(due || 0),
            ded: Number(ded || 0),
            dedReason: dedReason || '',
            note: note || '',
            total,
            paid_status: false,
            createdAt: new Date().toISOString()
        };
        const dup = (tenant.history || []).find(b =>
            String(b.month || '').trim().toLowerCase() === String(bill.month || '').trim().toLowerCase()
        );
        if (dup) {
            return res.status(409).json({ error: `Bill for ${bill.month} already exists. Delete it first to regenerate.` });
        }
        tenant.last_reading = Number(curr);
        if (!tenant.history) tenant.history = [];
        tenant.history.push(bill);
        tenant.balance = (tenant.balance || 0) + total;
        await writeTenants(houseId, tenants);
        res.json(bill);
    } catch (err) {
        console.error('Error calculating bill:', err);
        res.status(500).json({ error: 'Calculation failed' });
    }
});

app.patch('/api/bills/pay', async (req, res) => {
    if (!(await requireSubscription(req, res))) return;
    const houseId = req.body.houseId || req.query.houseId;
    const tenantId = req.body.tenantId || req.query.tenantId;
    const billId = req.body.billId || req.query.billId;
    const { paymentType, amount, reason } = req.body;
    if (!houseId || !tenantId || !billId) {
        return res.status(400).json({ error: 'houseId, tenantId, billId required' });
    }
    if (houseId === 'M_house' && !(await canAccessMHouse(req.user))) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    if (!paymentType || !['equal', 'due', 'advance'].includes(paymentType)) {
        return res.status(400).json({ error: 'paymentType must be equal, due, or advance' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        let tenants = await readTenants(houseId);
        const tenant = tenants.find(t => t.id === parseInt(tenantId));
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        const bill = tenant.history.find(b => b.id === parseInt(billId));
        if (!bill) return res.status(404).json({ error: 'Bill not found' });
        if (bill.paid_status) return res.status(400).json({ error: 'Bill already paid' });

        let paidAmount = 0;
        if (paymentType === 'equal') {
            paidAmount = bill.total;
        } else if (paymentType === 'due' || paymentType === 'advance') {
            if (!amount || isNaN(amount) || Number(amount) <= 0) {
                return res.status(400).json({ error: 'Valid amount required for due/advance payment' });
            }
            paidAmount = Number(amount);
        }

        tenant.balance = (tenant.balance || 0) - paidAmount;
        bill.paid_status = true;
        bill.payment_type = paymentType;
        bill.payment_amount = paidAmount;
        bill.payment_reason = reason || '';
        bill.paid_at = new Date().toISOString();
        await writeTenants(houseId, tenants);
        console.log(`Bill ${billId} marked ${paymentType} with amount ${paidAmount}, new balance: ${tenant.balance}`);
        res.json({ success: true, balance: tenant.balance });
    } catch (err) {
        console.error('Error toggling paid status:', err);
        res.status(500).json({ error: 'Failed to update bill' });
    }
});

// ─── DELETE bill – reverse bill and payment ──────────────────
app.delete('/api/tenants/:id/history/:index', async (req, res) => {
    if (!(await requireSubscription(req, res))) return;
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (houseId === 'M_house' && !(await canAccessMHouse(req.user))) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        const id = parseInt(req.params.id);
        const idx = parseInt(req.params.index);
        let tenants = await readTenants(houseId);
        const t = tenants.find(t => t.id === id);
        if (!t || !t.history || idx >= t.history.length) return res.status(404).json({ error: 'History entry not found' });
        const bill = t.history[idx];
        const billTotal = bill.total || 0;
        const paymentAmount = bill.paid_status ? (bill.payment_amount || 0) : 0;
        t.balance = (t.balance || 0) - billTotal + paymentAmount;
        if (idx === t.history.length - 1) {
            const prevBill = t.history[idx - 1];
            t.last_reading = prevBill ? prevBill.curr : (t.last_reading - bill.units);
        }
        t.history.splice(idx, 1);
        await writeTenants(houseId, tenants);
        console.log(`Bill deleted, new balance: ${t.balance}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting bill:', err);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// ─── Manually update tenant balance ────────────────────────────
app.put('/api/tenants/:id/balance', async (req, res) => {
    if (!(await requireSubscription(req, res))) return;
    const { houseId } = req.query;
    const newBalance = parseFloat(req.body.balance);
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (isNaN(newBalance)) return res.status(400).json({ error: 'Invalid balance value' });

    try {
        const hasAccess = await checkOwnership(houseId, req.user);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

        let tenants = await readTenants(houseId);
        const tenant = tenants.find(t => t.id === parseInt(req.params.id));
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        tenant.balance = newBalance;
        await writeTenants(houseId, tenants);
        res.json({ success: true, balance: tenant.balance });
    } catch (err) {
        console.error('Error updating tenant balance:', err);
        res.status(500).json({ error: 'Failed to update balance' });
    }
});

// ─── Admin: get all users ──────────────────────────────────────
app.get('/api/admin/users', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    try {
        const users = await getUsers(true);
        const activeUsers = users.filter(u => !u.deleted);
        const safeUsers = activeUsers.map(({ password, ...rest }) => rest);
        res.json(safeUsers);
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// ─── SuperAdmin: seed demo/test data (idempotent) ──────────────
app.post('/api/admin/seed-demo', async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'SuperAdmin access required' });
    try {
        const summary = await seedDemoData();
        res.json({ success: true, ...summary });
    } catch (err) {
        console.error('Error seeding demo data:', err);
        res.status(500).json({ error: 'Seeding failed: ' + err.message });
    }
});

app.post('/api/admin/link-tenant', async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Admin access required' });
    const { houseId, tenantId, userId } = req.body;
    if (!houseId || !tenantId || !userId) {
        return res.status(400).json({ error: 'houseId, tenantId, and userId required' });
    }
    if (houseId === 'M_house' && !(await canAccessMHouse(req.user))) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        let tenants = await readTenants(houseId);
        const idx = tenants.findIndex(t => t.id === parseInt(tenantId));
        if (idx === -1) return res.status(404).json({ error: 'Tenant not found' });
        tenants[idx].tenant_user_id = parseInt(userId);
        await writeTenants(houseId, tenants);
        res.json({ success: true, tenant: tenants[idx] });
    } catch (err) {
        console.error('Error linking tenant:', err);
        res.status(500).json({ error: 'Failed to link tenant' });
    }
});

app.get('/api/tenant/bills', async (req, res) => {
    if (req.user.role !== 'tenant') {
        return res.status(403).json({ error: 'Tenant access required' });
    }
    const userId = req.user.userId;
    try {
        const allHouses = await listHouseIds();
        let foundTenant = null;
        let foundHouse = null;
        let bills = [];

        for (const house of allHouses) {
            const ownership = await getOwnership();
            if (ownership[house]?.deleted) continue;
            const tenants = await readTenants(house);
            const activeTenants = tenants.filter(t => !t.deleted);
            const tenant = activeTenants.find(t => t.tenant_user_id === userId);
            if (tenant) {
                foundTenant = tenant;
                foundHouse = house;
                bills = (tenant.history || []).map(b => ({
                    ...b,
                    house: house,
                    tenantName: tenant.name,
                    tenantId: tenant.id
                }));
                break;
            }
        }

        if (!foundTenant) {
            const username = req.user.username;
            for (const house of allHouses) {
                const ownership = await getOwnership();
                if (ownership[house]?.deleted) continue;
                const tenants = await readTenants(house);
                const activeTenants = tenants.filter(t => !t.deleted);
                const tenant = activeTenants.find(t => t.name.toLowerCase() === username.toLowerCase());
                if (tenant) {
                    foundTenant = tenant;
                    foundHouse = house;
                    bills = (tenant.history || []).map(b => ({
                        ...b,
                        house: house,
                        tenantName: tenant.name,
                        tenantId: tenant.id
                    }));
                    break;
                }
            }
        }

        if (!foundTenant) {
            return res.json({ bills: [], message: 'No tenant linked to this user' });
        }

        bills.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({ bills, tenant: foundTenant, house: foundHouse });
    } catch (err) {
        console.error('Error fetching tenant bills:', err);
        res.status(500).json({ error: 'Failed to fetch bills' });
    }
});

app.get('/api/admin/trash/tenants', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const user = req.user;
    try {
        const houses = await listHouseIds();
        let deletedTenants = [];
        for (const house of houses) {
            if (house === 'M_house' && user.role === 'admin' && user.username !== 'admin') continue;
            const tenants = await readTenants(house);
            tenants.filter(t => t.deleted === true).forEach(t => {
                deletedTenants.push({ ...t, houseName: house });
            });
        }
        res.json(deletedTenants);
    } catch (err) {
        console.error('Error fetching deleted tenants:', err);
        res.status(500).json({ error: 'Failed to fetch deleted tenants' });
    }
});

app.post('/api/admin/trash/tenants/restore/:tenantId', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'houseId required' });
    if (houseId === 'M_house' && !(await canAccessMHouse(req.user))) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    const tenantId = parseInt(req.params.tenantId);
    try {
        let tenants = await readTenants(houseId);
        const idx = tenants.findIndex(t => t.id === tenantId);
        if (idx === -1 || !tenants[idx].deleted) {
            return res.status(404).json({ error: 'Deleted tenant not found' });
        }
        tenants[idx].deleted = false;
        tenants[idx].deleted_at = null;
        await writeTenants(houseId, tenants);
        res.json({ success: true });
    } catch (err) {
        console.error('Error restoring tenant:', err);
        res.status(500).json({ error: 'Failed to restore tenant' });
    }
});

app.delete('/api/admin/trash/tenants/permanent/:tenantId', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'houseId required' });
    if (houseId === 'M_house' && !(await canAccessMHouse(req.user))) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    const tenantId = parseInt(req.params.tenantId);
    try {
        let tenants = await readTenants(houseId);
        const idx = tenants.findIndex(t => t.id === tenantId);
        if (idx === -1 || !tenants[idx].deleted) {
            return res.status(404).json({ error: 'Deleted tenant not found' });
        }
        tenants.splice(idx, 1);
        await writeTenants(houseId, tenants);
        res.json({ success: true });
    } catch (err) {
        console.error('Error permanently deleting tenant:', err);
        res.status(500).json({ error: 'Failed to permanently delete tenant' });
    }
});

// ─── Subscription / upgrade requests ─────────────────────────
app.post('/api/subscription/request', async (req, res) => {
    const { plan, notes, cycle, tenants, screenshot, paymentNote } = req.body;
    if (!['self', 'full'].includes(plan)) return res.status(400).json({ error: 'Plan is required' });
    const cyc = cycle === 'yearly' ? 'yearly' : 'monthly';
    const n = tenants === undefined || tenants === null ? 1 : parseInt(tenants, 10);
    if (!Number.isInteger(n) || n < 1 || n > 200) return res.status(400).json({ error: 'Tenants must be 1–200' });
    let ss = null;
    if (screenshot) {
        if (typeof screenshot !== 'string' || !/^data:image\//.test(screenshot) || screenshot.length > 6 * 1024 * 1024) {
            return res.status(400).json({ error: 'Screenshot must be an image under 4 MB' });
        }
        ss = screenshot;
    }
    try {
        const { amt } = computeAmount({ plan, cycle: cyc, tenants: n });
        const reqs = await getUpgradeRequests();
        reqs.push({
            id: Date.now(),
            username: req.user.username,
            userId: req.user.userId,
            role: req.user.role,
            plan,
            cycle: cyc,
            tenants: n,
            amount: amt,
            via: 'manual',
            notes: notes || '',
            paymentNote: paymentNote || '',
            screenshot: ss,
            status: 'pending',
            createdAt: new Date().toISOString()
        });
        await saveUpgradeRequests(reqs);
        res.status(201).json({ success: true, amount: amt, cycle: cyc, tenants: n, screenshot: !!ss });
    } catch (err) {
        console.error('Error creating upgrade request:', err);
        res.status(500).json({ error: 'Failed to submit request' });
    }
});

app.get('/api/subscription/requests', async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'SuperAdmin access required' });
    try {
        res.json(await getUpgradeRequests());
    } catch (err) {
        res.status(500).json({ error: 'Failed to load requests' });
    }
});

app.post('/api/subscription/requests/:id/respond', async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'SuperAdmin access required' });
    const { status } = req.body;
    if (!['approved', 'declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    try {
        const reqs = await getUpgradeRequests();
        const idx = reqs.findIndex(r => r.id === parseInt(req.params.id));
        if (idx === -1) return res.status(404).json({ error: 'Request not found' });
        reqs[idx].status = status;
        reqs[idx].respondedAt = new Date().toISOString();

        if (status === 'approved') {
            const users = await getUsers(false);
            const owner = users.find(u => String(u.id) === String(reqs[idx].userId)) || users.find(u => u.username === reqs[idx].username);
            if (owner) {
                const now = new Date();
                const isStaff = owner.role !== 'owner';
                if (isStaff) {
                    // Staff accounts (admin/superadmin) are on a permanent plan
                    owner.subscription_status = 'paid';
                    owner.subscription_plan = 'admin';
                    owner.billing_cycle = '∞';
                    owner.subscription_tenants = null;
                    owner.trial_end = null;
                    owner.subscription_approved_at = now.toISOString();
                } else {
                    const next = new Date(now);
                    next.setMonth(next.getMonth() + (reqs[idx].cycle === 'yearly' ? 12 : 1));
                    owner.subscription_status = 'paid';
                    owner.subscription_plan = reqs[idx].plan || 'self';
                    if (reqs[idx].tenants) owner.subscription_tenants = reqs[idx].tenants;
                    owner.billing_cycle = reqs[idx].cycle || 'monthly';
                    owner.trial_end = next.toISOString();
                    owner.subscription_approved_at = now.toISOString();
                }

                // Record the manual invoice once (idempotent per request)
                if (reqs[idx].via === 'manual' && !reqs[idx].paymentId) {
                    const payments = await getPayments();
                    const payRec = {
                        pid: `MAN-${reqs[idx].id}`,
                        username: reqs[idx].username,
                        userId: reqs[idx].userId,
                        plan: isStaff ? 'admin' : (reqs[idx].plan || 'self'),
                        cycle: isStaff ? '∞' : (reqs[idx].cycle || 'monthly'),
                        tenants: isStaff ? null : (reqs[idx].tenants || 1),
                        amount: isStaff ? 0 : (reqs[idx].amount || 0),
                        status: 'paid',
                        method: 'manual',
                        screenshot: reqs[idx].screenshot || null,
                        createdAt: now,
                        verifiedAt: now
                    };
                    payments.push(payRec);
                    await savePayments(payments);
                    reqs[idx].paymentId = payRec.pid;
                }
                await saveUsers(users);
            }
        }
        await saveUpgradeRequests(reqs);
        res.json({ success: true });
    } catch (err) {
        console.error('Error responding to upgrade request:', err);
        res.status(500).json({ error: 'Failed to respond' });
    }
});

// Undo an approved upgrade: revert the owner back to trial and remove the
// manual invoice record so revenue no longer counts it.
app.post('/api/subscription/requests/:id/revert', async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'SuperAdmin access required' });
    try {
        const reqs = await getUpgradeRequests();
        const idx = reqs.findIndex(r => r.id === parseInt(req.params.id));
        if (idx === -1) return res.status(404).json({ error: 'Request not found' });
        if (reqs[idx].status !== 'approved') return res.status(400).json({ error: 'Only approved requests can be reverted' });
        const users = await getUsers(false);
        const owner = users.find(u => String(u.id) === String(reqs[idx].userId)) || users.find(u => u.username === reqs[idx].username);
        if (owner) {
            const trialEnd = new Date();
            trialEnd.setDate(trialEnd.getDate() + 30);
            owner.subscription_status = 'trial';
            owner.subscription_plan = null;
            owner.subscription_tenants = null;
            owner.billing_cycle = 'monthly';
            owner.trial_end = trialEnd.toISOString();
            owner.subscription_approved_at = null;
        }
        if (reqs[idx].paymentId) {
            const payments = await getPayments();
            const payIdx = payments.findIndex(p => p.pid === reqs[idx].paymentId);
            if (payIdx !== -1) {
                payments.splice(payIdx, 1);
                await savePayments(payments);
            }
            reqs[idx].paymentId = null;
        }
        reqs[idx].status = 'reverted';
        reqs[idx].revertedAt = new Date().toISOString();
        await saveUsers(users);
        await saveUpgradeRequests(reqs);
        res.json({ success: true });
    } catch (err) {
        console.error('Error reverting upgrade request:', err);
        res.status(500).json({ error: 'Failed to revert upgrade' });
    }
});

// ─── eSewa checkouts ─────────────────────────────────────────
app.post('/api/subscription/checkout', async (req, res) => {
    const { plan, cycle, tenants } = req.body;
    if (!['self', 'full'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    if (!['monthly', 'yearly'].includes(cycle)) return res.status(400).json({ error: 'Invalid cycle' });
    const n = parseInt(tenants, 10);
    if (!Number.isInteger(n) || n < 1 || n > 200) return res.status(400).json({ error: 'Tenants must be 1–200' });
    try {
        const { amt } = computeAmount({ plan, cycle, tenants: n });
        const pid = `SR-${req.user.userId}-${Date.now()}`;
        const now = new Date().toISOString();
        const rec = {
            pid,
            username: req.user.username,
            userId: req.user.userId,
            plan, cycle, tenants: n,
            amount: amt,
            status: 'pending',
            createdAt: now
        };
        const payments = await getPayments();
        payments.push(rec);
        await savePayments(payments);

        const reqs = await getUpgradeRequests();
        reqs.push({
            id: Date.now(),
            pid,
            username: req.user.username,
            userId: req.user.userId,
            role: req.user.role,
            plan, cycle, tenants: n, amount: amt,
            status: 'pending_payment',
            via: 'esewa',
            createdAt: now
        });
        await saveUpgradeRequests(reqs);

        res.json({
            url: paymentEndpoint(),
            params: paymentForm({ pid, amt })
        });
    } catch (err) {
        console.error('Error creating checkout:', err);
        res.status(500).json({ error: 'Failed to create checkout' });
    }
});

app.get('/api/subscription/payments', async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'SuperAdmin access required' });
    try {
        res.json(await getPayments());
    } catch (err) {
        res.status(500).json({ error: 'Failed to load payments' });
    }
});

// ─── Pages (explicit allowlist only — data/server folders stay private) ──
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});
app.get('/register.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'register.html'));
});
app.get('/payment-result.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'payment-result.html'));
});
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html'));
});
app.get('/privacy.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html'));
});
app.get('/app-version.json', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '..', 'public', 'app-version.json'));
});
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});
app.get('/superadmin.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'superadmin.html'));
});
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.get('/tenant.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'tenant.html'));
});
app.get('/logo.svg', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'assets', 'logo.svg'));
});
app.get('/assets/:file', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'assets', req.params.file));
});
app.get('/apple-touch-icon.png', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'assets', 'icon-192.png'));
});
app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
});
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.sendFile(path.join(__dirname, '..', 'public', 'robots.txt'));
});
app.get('/google1e6a0d4569332a7b.html', (req, res) => {
    res.type('text/html');
    res.sendFile(path.join(__dirname, '..', 'public', 'google1e6a0d4569332a7b.html'));
});
app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml');
    res.sendFile(path.join(__dirname, '..', 'public', 'sitemap.xml'));
});
app.get('/install-widget.js', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'install-widget.js'));
});
app.get('/downloads/:file', (req, res) => {
    const file = path.basename(req.params.file);
    res.download(path.join(__dirname, '..', 'public', 'downloads', file));
});

// ─── Init notifications data ────────────────────────────────
async function initNotifFile() {
    try {
        const existing = await getNotifs();
        if (existing.length) {
            console.log('Notifications data loaded');
            return;
        }
    } catch { /* fall through to seed */ }
    try {
        await saveNotifs([]);
        console.log('Notifications data initialised');
    } catch (err) {
        console.error('Failed to initialise notifications:', err.message);
    }
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`SajiloRent API running: http://localhost:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
    console.log(`Rate per unit: Rs. ${RATE}`);
});