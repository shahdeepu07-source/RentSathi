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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

const DATA_DIR = path.join(__dirname, '..', 'data', 'clients');
const OWNERSHIP_FILE = path.join(__dirname, 'data', 'ownership.json');
const NOTIF_FILE = path.join(__dirname, 'data', 'notifications.json');
const RATE = 15;
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..')));

app.use('/api/auth', authRoutes);
app.use('/api', verifyToken);
app.use('/api', notificationRoutes);

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });

async function getOwnership() {
    try {
        const data = await fs.readFile(OWNERSHIP_FILE, 'utf8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

async function saveOwnership(ownership) {
    await fs.writeFile(OWNERSHIP_FILE, JSON.stringify(ownership, null, 2));
}

const getFilePath = (houseId) => path.join(DATA_DIR, `${houseId}.json`);

const readTenants = async (houseId) => {
    try {
        const data = await fs.readFile(getFilePath(houseId), 'utf8');
        return JSON.parse(data);
    } catch {
        return [];
    }
};

const writeTenants = async (houseId, data) => {
    await fs.writeFile(getFilePath(houseId), JSON.stringify(data, null, 2), 'utf8');
};

async function checkOwnership(houseId, userId, userRole) {
    if (userRole === 'admin' || userRole === 'superadmin') return true;
    const ownership = await getOwnership();
    const owner = ownership[houseId];
    return owner && owner.owner_id == userId && !owner.deleted;
}

function canAccessMHouse(user) {
    if (!user) return false;
    if (user.role === 'superadmin') return true;
    if (user.role === 'admin' && user.username === 'admin') return true;
    return false;
}

async function initOwnership() {
    try {
        await fs.access(OWNERSHIP_FILE);
        console.log('✅ Ownership file loaded');
    } catch {
        await fs.mkdir(path.dirname(OWNERSHIP_FILE), { recursive: true });
        await fs.writeFile(OWNERSHIP_FILE, JSON.stringify({
            "M_house": {
                owner_id: 1,
                created_by: 1,
                created_at: new Date().toISOString(),
                deleted: false,
                deleted_at: null
            }
        }, null, 2));
        console.log('✅ Ownership file created with default M_house (owner: admin)');
    }
}
await initOwnership();
await initNotifFile();

// ─── Houses ──────────────────────────────────────────────────
app.get('/api/houses', async (req, res) => {
    try {
        const userId = req.user.userId;
        const userRole = req.user.role;
        const user = req.user;
        const files = await fs.readdir(DATA_DIR);
        const allHouses = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        const ownership = await getOwnership();
        const activeHouses = allHouses.filter(h => !ownership[h]?.deleted);
        let visibleHouses = activeHouses;
        if (userRole !== 'admin' && userRole !== 'superadmin') {
            visibleHouses = activeHouses.filter(houseId => {
                const owner = ownership[houseId];
                return owner && owner.owner_id == userId;
            });
        } else {
            if (userRole === 'admin' && user.username !== 'admin') {
                visibleHouses = activeHouses.filter(h => h !== 'M_house');
            }
        }
        res.json(visibleHouses);
    } catch (err) {
        console.error('Error loading houses:', err);
        res.status(500).json({ error: 'Failed to load houses' });
    }
});

app.get('/api/houses/ownership', async (req, res) => {
    try {
        const ownership = await getOwnership();
        const active = {};
        for (const [key, val] of Object.entries(ownership)) {
            if (!val.deleted) {
                if (req.user.role === 'admin' && req.user.username !== 'admin' && key === 'M_house') {
                    continue;
                }
                active[key] = val;
            }
        }
        res.json(active);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load ownership' });
    }
});

app.post('/api/houses', async (req, res) => {
    try {
        const { name, address, owner_id } = req.body;
        const userId = req.user.userId;
        const userRole = req.user.role;
        const user = req.user;
        if (name === 'M_house' && !canAccessMHouse(user)) {
            return res.status(403).json({ error: 'You do not have permission to manage M_house' });
        }
        if (!name) return res.status(400).json({ error: 'House name required' });
        let finalOwnerId = userId;
        if (['admin', 'superadmin'].includes(userRole) && owner_id) finalOwnerId = owner_id;
        const filePath = getFilePath(name);
        try {
            await fs.access(filePath);
            return res.status(400).json({ error: 'House already exists' });
        } catch {}
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
    try {
        const houseId = req.params.id;
        const userRole = req.user.role;
        const user = req.user;
        if (houseId === 'M_house' && !canAccessMHouse(user)) {
            return res.status(403).json({ error: 'You do not have permission to manage M_house' });
        }
        if (!['admin', 'superadmin'].includes(userRole)) {
            return res.status(403).json({ error: 'Admin or SuperAdmin access required' });
        }
        const { name, address, owner_id } = req.body;
        const ownership = await getOwnership();
        if (!ownership[houseId]) {
            return res.status(404).json({ error: 'House not found' });
        }
        if (name && name !== houseId) {
            const newPath = getFilePath(name);
            try {
                await fs.access(newPath);
                return res.status(400).json({ error: 'A house with that name already exists' });
            } catch {}
            await fs.rename(getFilePath(houseId), newPath);
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
    try {
        const houseId = req.params.id;
        const userRole = req.user.role;
        const user = req.user;
        if (houseId === 'M_house' && !canAccessMHouse(user)) {
            return res.status(403).json({ error: 'You do not have permission to manage M_house' });
        }
        if (!['admin', 'superadmin'].includes(userRole)) {
            return res.status(403).json({ error: 'Only admin can delete houses' });
        }
        const ownership = await getOwnership();
        if (!ownership[houseId]) {
            return res.status(404).json({ error: 'House not found' });
        }
        if (ownership[houseId].deleted) {
            return res.status(400).json({ error: 'House already deleted' });
        }
        ownership[houseId].deleted = true;
        ownership[houseId].deleted_at = new Date().toISOString();
        await saveOwnership(ownership);
        console.log(`🗑️ House "${houseId}" moved to trash`);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting house:', err);
        res.status(500).json({ error: 'Failed to delete house' });
    }
});

app.get('/api/admin/trash/houses', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const user = req.user;
    const ownership = await getOwnership();
    let deleted = Object.keys(ownership)
        .filter(k => ownership[k].deleted === true);
    if (user.role === 'admin' && user.username !== 'admin') {
        deleted = deleted.filter(k => k !== 'M_house');
    }
    res.json(deleted.map(k => ({ name: k, ...ownership[k] })));
});

app.post('/api/admin/trash/houses/restore/:houseId', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const houseId = req.params.houseId;
    const user = req.user;
    if (houseId === 'M_house' && !canAccessMHouse(user)) {
        return res.status(403).json({ error: 'You do not have permission to manage M_house' });
    }
    const ownership = await getOwnership();
    if (!ownership[houseId] || !ownership[houseId].deleted) {
        return res.status(404).json({ error: 'Deleted house not found' });
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
    if (houseId === 'M_house' && !canAccessMHouse(user)) {
        return res.status(403).json({ error: 'You do not have permission to manage M_house' });
    }
    const ownership = await getOwnership();
    if (!ownership[houseId] || !ownership[houseId].deleted) {
        return res.status(404).json({ error: 'Deleted house not found' });
    }
    try {
        await fs.unlink(getFilePath(houseId));
    } catch (e) {}
    delete ownership[houseId];
    await saveOwnership(ownership);
    res.json({ success: true });
});

app.get('/api/admin/trash/users', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    try {
        const usersData = await fs.readFile(path.join(__dirname, 'data', 'users.json'), 'utf8');
        const users = JSON.parse(usersData);
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
        const usersData = await fs.readFile(path.join(__dirname, 'data', 'users.json'), 'utf8');
        const users = JSON.parse(usersData);
        const user = users.find(u => u.id === userId);
        if (!user || !user.deleted) {
            return res.status(404).json({ error: 'Deleted user not found' });
        }
        user.deleted = false;
        user.deleted_at = null;
        await fs.writeFile(path.join(__dirname, 'data', 'users.json'), JSON.stringify(users, null, 2));
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
        const usersData = await fs.readFile(path.join(__dirname, 'data', 'users.json'), 'utf8');
        let users = JSON.parse(usersData);
        const idx = users.findIndex(u => u.id === userId);
        if (idx === -1 || !users[idx].deleted) {
            return res.status(404).json({ error: 'Deleted user not found' });
        }
        users.splice(idx, 1);
        await fs.writeFile(path.join(__dirname, 'data', 'users.json'), JSON.stringify(users, null, 2));
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
        const usersData = await fs.readFile(path.join(__dirname, 'data', 'users.json'), 'utf8');
        const users = JSON.parse(usersData);
        const user = users.find(u => u.id === userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'superadmin') return res.status(403).json({ error: 'Cannot delete SuperAdmin' });
        if (user.deleted) return res.status(400).json({ error: 'User already deleted' });
        user.deleted = true;
        user.deleted_at = new Date().toISOString();
        await fs.writeFile(path.join(__dirname, 'data', 'users.json'), JSON.stringify(users, null, 2));
        console.log(`🗑️ User "${user.username}" (${user.role}) moved to trash`);
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
        const usersData = await fs.readFile(path.join(__dirname, 'data', 'users.json'), 'utf8');
        const users = JSON.parse(usersData);
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
        await fs.writeFile(path.join(__dirname, 'data', 'users.json'), JSON.stringify(users, null, 2));
        res.json({ success: true, user });
    } catch (err) {
        console.error('Error managing subscription:', err);
        res.status(500).json({ error: 'Failed to manage subscription' });
    }
});

app.get('/api/tenants', async (req, res) => {
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
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
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
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
                console.log(`✅ Tenant user "${tenant_username}" created with ID ${newUser.id}`);
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
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
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
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
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
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
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
    const houseId = req.body.houseId || req.query.houseId;
    const tenantId = req.body.tenantId || req.query.tenantId;
    const billId = req.body.billId || req.query.billId;
    const { paymentType, amount, reason } = req.body;
    if (!houseId || !tenantId || !billId) {
        return res.status(400).json({ error: 'houseId, tenantId, billId required' });
    }
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    if (!paymentType || !['equal', 'due', 'advance'].includes(paymentType)) {
        return res.status(400).json({ error: 'paymentType must be equal, due, or advance' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
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
        console.log(`✅ Bill ${billId} marked ${paymentType} with amount ${paidAmount}, new balance: ${tenant.balance}`);
        res.json({ success: true, balance: tenant.balance });
    } catch (err) {
        console.error('Error toggling paid status:', err);
        res.status(500).json({ error: 'Failed to update bill' });
    }
});

// ─── DELETE bill – reverse bill and payment ──────────────────
app.delete('/api/tenants/:id/history/:index', async (req, res) => {
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
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
        console.log(`🗑️ Bill deleted, new balance: ${t.balance}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting bill:', err);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// ─── Manually update tenant balance ────────────────────────────
app.put('/api/tenants/:id/balance', async (req, res) => {
    const { houseId } = req.query;
    const newBalance = parseFloat(req.body.balance);
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    if (isNaN(newBalance)) return res.status(400).json({ error: 'Invalid balance value' });

    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
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
        const usersData = await fs.readFile(path.join(__dirname, 'data', 'users.json'), 'utf8');
        const users = JSON.parse(usersData);
        const activeUsers = users.filter(u => !u.deleted);
        const safeUsers = activeUsers.map(({ password, ...rest }) => rest);
        res.json(safeUsers);
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

app.post('/api/admin/link-tenant', async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Admin access required' });
    const { houseId, tenantId, userId } = req.body;
    if (!houseId || !tenantId || !userId) {
        return res.status(400).json({ error: 'houseId, tenantId, and userId required' });
    }
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
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
        const files = await fs.readdir(DATA_DIR);
        const allHouses = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
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
        const files = await fs.readdir(DATA_DIR);
        const houses = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
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
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
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
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
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

// ─── Static ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'login.html'));
});
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'login.html'));
});
app.get('/register.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'register.html'));
});
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'admin.html'));
});
app.get('/superadmin.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'superadmin.html'));
});
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});
app.get('/tenant.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'tenant.html'));
});

// ─── Init notifications file ────────────────────────────────
async function initNotifFile() {
    try {
        await fs.access(NOTIF_FILE);
    } catch {
        await fs.writeFile(NOTIF_FILE, JSON.stringify([], null, 2));
        console.log('📢 Notifications file created');
    }
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`✅ SajiloRent API running: http://localhost:${PORT}`);
    console.log(`📁 Data directory: ${DATA_DIR}`);
    console.log(`🔐 Default login: admin / 5545`);
    console.log(`🔑 SuperAdmin: Super_Admin / Kali_5545`);
    console.log(`📊 Rate per unit: Rs. ${RATE}`);
});