import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import authRoutes from './auth.js';
import { verifyToken } from './middleware.js';
import { createUser } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

const DATA_DIR = path.join(__dirname, '..', 'data', 'clients');
const OWNERSHIP_FILE = path.join(__dirname, 'data', 'ownership.json');
const RATE = 15;
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..')));

app.use('/api/auth', authRoutes);
app.use('/api', verifyToken);

await fs.mkdir(DATA_DIR, { recursive: true });

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
    if (userRole === 'admin') return true;
    const ownership = await getOwnership();
    const owner = ownership[houseId];
    return owner && owner.owner_id == userId && !owner.deleted;
}

// ─── Houses ──────────────────────────────────────────────────
app.get('/api/houses', async (req, res) => {
    try {
        const userId = req.user.userId;
        const userRole = req.user.role;
        const files = await fs.readdir(DATA_DIR);
        const allHouses = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        const ownership = await getOwnership();
        const activeHouses = allHouses.filter(h => !ownership[h]?.deleted);
        let visibleHouses = activeHouses;
        if (userRole !== 'admin') {
            visibleHouses = activeHouses.filter(houseId => {
                const owner = ownership[houseId];
                return owner && owner.owner_id == userId;
            });
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
            if (!val.deleted) active[key] = val;
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
        if (!name) return res.status(400).json({ error: 'House name required' });
        let finalOwnerId = userId;
        if (userRole === 'admin' && owner_id) finalOwnerId = owner_id;
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

// ─── Soft delete house ──────────────────────────────────────
app.post('/api/houses/:id/delete', async (req, res) => {
    try {
        const houseId = req.params.id;
        const userRole = req.user.role;
        if (userRole !== 'admin') {
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

// ─── Trash endpoints for Houses ────────────────────────────
app.get('/api/admin/trash/houses', async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const ownership = await getOwnership();
    const deleted = Object.keys(ownership)
        .filter(k => ownership[k].deleted === true)
        .map(k => ({ name: k, ...ownership[k] }));
    res.json(deleted);
});

app.post('/api/admin/trash/houses/restore/:houseId', async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const houseId = req.params.houseId;
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
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const houseId = req.params.houseId;
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

// ─── Trash endpoints for Users ─────────────────────────────
app.get('/api/admin/trash/users', async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
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
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
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
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
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

// ─── Soft delete user (owners and tenants) ───────────────────
app.post('/api/admin/users/:userId/delete', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    const userId = parseInt(req.params.userId);
    try {
        const usersData = await fs.readFile(path.join(__dirname, 'data', 'users.json'), 'utf8');
        const users = JSON.parse(usersData);
        const user = users.find(u => u.id === userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (user.deleted) {
            return res.status(400).json({ error: 'User already deleted' });
        }
        if (user.role === 'admin') {
            return res.status(403).json({ error: 'Cannot delete admin users' });
        }
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

// ─── Tenants ──────────────────────────────────────────────────
app.get('/api/tenants', async (req, res) => {
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
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
    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        const { name, rent_amount, last_reading, tenant_username, tenant_password, tenant_fullName, tenant_phone, tenant_email } = req.body;
        if (!name || rent_amount == null) return res.status(400).json({ error: 'Name and rent required' });
        const tenants = await readTenants(houseId);
        let tenant_user_id = null;
        if (tenant_username && tenant_password) {
            try {
                const newUser = await createUser(tenant_username, tenant_password, 'tenant', {
                    fullName: tenant_fullName || name,
                    phone: tenant_phone || '',
                    email: tenant_email || ''
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
            tenant_user_id: tenant_user_id,
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

// ─── Soft delete tenant (owner only, password verified on frontend) ──
app.post('/api/tenants/:id/delete', async (req, res) => {
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
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

app.put('/api/tenants/:id', async (req, res) => {
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        const id = parseInt(req.params.id);
        const { name, rent_amount, last_reading } = req.body;
        let tenants = await readTenants(houseId);
        const idx = tenants.findIndex(t => t.id === id);
        if (idx === -1) return res.status(404).json({ error: 'Tenant not found' });
        if (tenants[idx].deleted) return res.status(400).json({ error: 'Cannot edit deleted tenant' });
        tenants[idx] = {
            ...tenants[idx],
            name: name || tenants[idx].name,
            rent_amount: rent_amount != null ? Number(rent_amount) : tenants[idx].rent_amount,
            last_reading: last_reading != null ? Number(last_reading) : tenants[idx].last_reading
        };
        await writeTenants(houseId, tenants);
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating tenant:', err);
        res.status(500).json({ error: 'Update failed' });
    }
});

app.delete('/api/tenants/:id', async (req, res) => {
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        let tenants = await readTenants(houseId);
        tenants = tenants.filter(t => t.id !== parseInt(req.params.id));
        await writeTenants(houseId, tenants);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting tenant:', err);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// ─── Bills ─────────────────────────────────────────────────────
app.post('/api/calculate', async (req, res) => {
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
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
    if (!houseId || !tenantId || !billId) {
        return res.status(400).json({ error: 'houseId, tenantId, billId required' });
    }
    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        let tenants = await readTenants(houseId);
        const tenant = tenants.find(t => t.id === parseInt(tenantId));
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        const bill = tenant.history.find(b => b.id === parseInt(billId));
        if (!bill) return res.status(404).json({ error: 'Bill not found' });
        bill.paid_status = !bill.paid_status;
        await writeTenants(houseId, tenants);
        console.log(`✅ Bill ${billId} toggled to ${bill.paid_status ? 'paid' : 'unpaid'}`);
        res.json({ success: true, paid_status: bill.paid_status });
    } catch (err) {
        console.error('Error toggling paid status:', err);
        res.status(500).json({ error: 'Failed to update bill' });
    }
});

app.delete('/api/tenants/:id/history/:index', async (req, res) => {
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'Missing houseId' });
    try {
        const hasAccess = await checkOwnership(houseId, req.user.userId, req.user.role);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        const id = parseInt(req.params.id);
        const idx = parseInt(req.params.index);
        let tenants = await readTenants(houseId);
        const t = tenants.find(t => t.id === id);
        if (!t || !t.history || idx >= t.history.length) return res.status(404).json({ error: 'History entry not found' });
        if (idx === t.history.length - 1) {
            const prevBill = t.history[idx - 1];
            t.last_reading = prevBill ? prevBill.curr : (t.last_reading - t.history[idx].units);
        }
        t.history.splice(idx, 1);
        await writeTenants(houseId, tenants);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting bill:', err);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// ─── Admin: get all users (non-deleted) ──────────────────────
app.get('/api/admin/users', async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
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

// ─── Admin: link tenant to user ──────────────────────────────
app.post('/api/admin/link-tenant', async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { houseId, tenantId, userId } = req.body;
    if (!houseId || !tenantId || !userId) {
        return res.status(400).json({ error: 'houseId, tenantId, and userId required' });
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

// ─── Tenant bills endpoint ────────────────────────────────────
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

// ─── Static ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'admin.html'));
});
app.get('/tenant.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'tenant.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`✅ RentSathi API running: http://localhost:${PORT}`);
    console.log(`📁 Data directory: ${DATA_DIR}`);
    console.log(`🔐 Default login: admin / 5545`);
    console.log(`📊 Rate per unit: Rs. ${RATE}`);
});