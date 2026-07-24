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

// ─── Ownership helpers ──────────────────────────────────────────
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

// ─── M_House access control ─────────────────────────────────────
function canAccessMHouse(user) {
    if (!user) return false;
    if (user.role === 'superadmin') return true;
    if (user.role === 'admin' && user.username === 'admin') return true;
    return false;
}

// ─── Initialize ownership file ──────────────────────────────────
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

// ─── Houses ──────────────────────────────────────────────────
app.get('/api/houses', async (req, res) => {
    try {
        const userId = req.user.userId;
        const userRole = req.user.role;
        const user = req.user; // contains username
        const files = await fs.readdir(DATA_DIR);
        const allHouses = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        const ownership = await getOwnership();
        const activeHouses = allHouses.filter(h => !ownership[h]?.deleted);
        let visibleHouses = activeHouses;
        if (userRole !== 'admin' && userRole !== 'superadmin') {
            // Owners and tenants: filter by ownership
            visibleHouses = activeHouses.filter(houseId => {
                const owner = ownership[houseId];
                return owner && owner.owner_id == userId;
            });
        } else {
            // Admin or SuperAdmin: apply M_House filter
            if (userRole === 'admin' && user.username !== 'admin') {
                // Normal admin: remove M_House
                visibleHouses = activeHouses.filter(h => h !== 'M_house');
            }
            // SuperAdmin or special admin (username 'admin'): keep all
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
                // If user is normal admin, exclude M_house from ownership mapping
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
        // Optionally rename the file if name changed
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
            houseId = name; // update for further use
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

// ─── Trash endpoints for Houses ────────────────────────────
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

// ─── Trash endpoints for Users ─────────────────────────────
app.get('/api/admin/trash/users', async (req, res) => {
    // (unchanged)
});

app.post('/api/admin/trash/users/restore/:userId', async (req, res) => {
    // (unchanged)
});

app.delete('/api/admin/trash/users/permanent/:userId', async (req, res) => {
    // (unchanged)
});

// ─── Soft delete user ────────────────────────────────────────
app.post('/api/admin/users/:userId/delete', async (req, res) => {
    // (unchanged)
});

// ─── Subscription management ─────────────────────────────────
app.patch('/api/admin/subscription/:userId', async (req, res) => {
    // (unchanged)
});

// ─── Tenants ──────────────────────────────────────────────────
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
        // ... rest of bill generation
    } catch (err) {
        console.error('Error calculating bill:', err);
        res.status(500).json({ error: 'Calculation failed' });
    }
});

app.patch('/api/bills/pay', async (req, res) => {
    const houseId = req.body.houseId || req.query.houseId;
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    // ... rest
});

app.delete('/api/tenants/:id/history/:index', async (req, res) => {
    // ... similar
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

// ─── Admin: link tenant to user ──────────────────────────────
app.post('/api/admin/link-tenant', async (req, res) => {
    // ... (unchanged)
});

// ─── Tenant bills endpoint ────────────────────────────────────
app.get('/api/tenant/bills', async (req, res) => {
    // ... (unchanged)
});

// ─── Trash for tenants ────────────────────────────────────────
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
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'houseId required' });
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    // ... rest
});

app.delete('/api/admin/trash/tenants/permanent/:tenantId', async (req, res) => {
    const { houseId } = req.query;
    if (!houseId) return res.status(400).json({ error: 'houseId required' });
    if (houseId === 'M_house' && !canAccessMHouse(req.user)) {
        return res.status(403).json({ error: 'Access denied to M_house' });
    }
    // ... rest
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`✅ RentSathi API running: http://localhost:${PORT}`);
    console.log(`📁 Data directory: ${DATA_DIR}`);
    console.log(`🔐 Default login: admin / 5545`);
    console.log(`🔑 SuperAdmin: Super_Admin / Kali_5545`);
    console.log(`📊 Rate per unit: Rs. ${RATE}`);
});