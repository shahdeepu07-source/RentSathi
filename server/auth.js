import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

const USERS_FILE = path.join(__dirname, 'data', 'users.json');

// ──────────────────────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────────────────────
async function ensureAdminExists() {
    try {
        await fs.access(USERS_FILE);
        console.log('✅ Users file exists');
    } catch {
        console.log('📝 Creating users file with admin...');
        const hashedPassword = await bcrypt.hash('5545', 10);
        const adminUser = {
            id: 1,
            username: 'admin',
            password: hashedPassword,
            role: 'admin',
            fullName: 'Administrator',
            phone: '',
            email: '',
            address: '',
            notes: '',
            deleted: false,
            deleted_at: null,
            created_at: new Date().toISOString()
        };
        await fs.mkdir(path.dirname(USERS_FILE), { recursive: true });
        await fs.writeFile(USERS_FILE, JSON.stringify([adminUser], null, 2));
        console.log('✅ Admin created: admin / 5545');
    }
}

async function getUsers(includeDeleted = false) {
    const data = await fs.readFile(USERS_FILE, 'utf8');
    const users = JSON.parse(data);
    if (!includeDeleted) {
        return users.filter(u => !u.deleted);
    }
    return users;
}

async function saveUsers(users) {
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

// ──────────────────────────────────────────────────────────────
// PUBLIC: Login
// ──────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log('📧 Login attempt for:', username);
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        const users = await getUsers(false); // only non-deleted
        const user = users.find(u => u.username === username);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const validPassword = await bcrypt.compare(password, user.password);
        console.log('🔑 Password match:', validPassword);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign(
            { userId: user.id, username: user.username, role: user.role },
            process.env.JWT_SECRET || 'housebill_super_secret_key_2024',
            { expiresIn: '7d' }
        );
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                fullName: user.fullName || ''
            }
        });
    } catch (err) {
        console.error('💥 Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ──────────────────────────────────────────────────────────────
// ADMIN: Create user (Owner/Admin)
// ──────────────────────────────────────────────────────────────
router.post('/users', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'housebill_super_secret_key_2024');
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const { username, password, role, fullName, phone, email, address, notes } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        if (!['owner', 'admin'].includes(role)) {
            return res.status(400).json({ error: 'Role must be "owner" or "admin"' });
        }
        const users = await getUsers(true);
        if (users.find(u => u.username === username)) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            id: Date.now(),
            username,
            password: hashedPassword,
            role,
            fullName: fullName || '',
            phone: phone || '',
            email: email || '',
            address: address || '',
            notes: notes || '',
            deleted: false,
            deleted_at: null,
            created_at: new Date().toISOString()
        };
        users.push(newUser);
        await saveUsers(users);
        res.status(201).json({
            id: newUser.id,
            username: newUser.username,
            role: newUser.role,
            fullName: newUser.fullName
        });
    } catch (err) {
        console.error('💥 User creation error:', err);
        res.status(500).json({ error: 'User creation failed' });
    }
});

// ──────────────────────────────────────────────────────────────
// ADMIN: Create tenant user
// ──────────────────────────────────────────────────────────────
router.post('/tenant-users', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'housebill_super_secret_key_2024');
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const { username, password, fullName, phone, email, address, notes } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        const users = await getUsers(true);
        if (users.find(u => u.username === username)) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            id: Date.now(),
            username,
            password: hashedPassword,
            role: 'tenant',
            fullName: fullName || '',
            phone: phone || '',
            email: email || '',
            address: address || '',
            notes: notes || '',
            deleted: false,
            deleted_at: null,
            created_at: new Date().toISOString()
        };
        users.push(newUser);
        await saveUsers(users);
        res.status(201).json({
            id: newUser.id,
            username: newUser.username,
            role: newUser.role,
            fullName: newUser.fullName
        });
    } catch (err) {
        console.error('💥 Tenant user creation error:', err);
        res.status(500).json({ error: 'Tenant user creation failed' });
    }
});

// ──────────────────────────────────────────────────────────────
// ADMIN: Reset password
// ──────────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'housebill_super_secret_key_2024');
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const { userId, newPassword } = req.body;
        if (!userId || !newPassword) {
            return res.status(400).json({ error: 'UserId and newPassword required' });
        }
        const users = await getUsers(true);
        const user = users.find(u => u.id === parseInt(userId));
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (user.role === 'admin') {
            return res.status(403).json({ error: 'Admin passwords cannot be reset this way' });
        }
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        await saveUsers(users);
        res.json({ success: true, message: `Password reset for ${user.username}` });
    } catch (err) {
        console.error('💥 Password reset error:', err);
        res.status(500).json({ error: 'Password reset failed' });
    }
});

// ──────────────────────────────────────────────────────────────
// ADMIN: Soft delete user (move to trash)
// ──────────────────────────────────────────────────────────────
router.post('/admin/users/:userId/delete', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'housebill_super_secret_key_2024');
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const userId = parseInt(req.params.userId);
        const users = await getUsers(true);
        const user = users.find(u => u.id === userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (user.role === 'admin') {
            return res.status(403).json({ error: 'Cannot delete admin users' });
        }
        if (user.deleted) {
            return res.status(400).json({ error: 'User already deleted' });
        }
        user.deleted = true;
        user.deleted_at = new Date().toISOString();
        await saveUsers(users);
        res.json({ success: true });
    } catch (err) {
        console.error('💥 Delete user error:', err);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// ──────────────────────────────────────────────────────────────
// ADMIN: List deleted users (trash)
// ──────────────────────────────────────────────────────────────
router.get('/admin/trash/users', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'housebill_super_secret_key_2024');
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const users = await getUsers(true);
        const deleted = users.filter(u => u.deleted === true);
        res.json(deleted);
    } catch (err) {
        console.error('💥 Trash users error:', err);
        res.status(500).json({ error: 'Failed to fetch deleted users' });
    }
});

// ──────────────────────────────────────────────────────────────
// ADMIN: Restore user from trash
// ──────────────────────────────────────────────────────────────
router.post('/admin/trash/users/restore/:userId', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'housebill_super_secret_key_2024');
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const userId = parseInt(req.params.userId);
        const users = await getUsers(true);
        const user = users.find(u => u.id === userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (!user.deleted) {
            return res.status(400).json({ error: 'User is not deleted' });
        }
        user.deleted = false;
        user.deleted_at = null;
        await saveUsers(users);
        res.json({ success: true });
    } catch (err) {
        console.error('💥 Restore user error:', err);
        res.status(500).json({ error: 'Failed to restore user' });
    }
});

// ──────────────────────────────────────────────────────────────
// ADMIN: Permanently delete user (from trash)
// ──────────────────────────────────────────────────────────────
router.delete('/admin/trash/users/permanent/:userId', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'housebill_super_secret_key_2024');
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const userId = parseInt(req.params.userId);
        let users = await getUsers(true);
        const idx = users.findIndex(u => u.id === userId);
        if (idx === -1) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (!users[idx].deleted) {
            return res.status(400).json({ error: 'User is not deleted' });
        }
        users.splice(idx, 1);
        await saveUsers(users);
        res.json({ success: true });
    } catch (err) {
        console.error('💥 Permanent delete user error:', err);
        res.status(500).json({ error: 'Failed to permanently delete user' });
    }
});

// ──────────────────────────────────────────────────────────────
// VERIFY PASSWORD (for admin or owner actions)
// ──────────────────────────────────────────────────────────────
router.post('/verify-password', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            console.log('❌ No token provided');
            return res.status(401).json({ error: 'No token provided' });
        }
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'housebill_super_secret_key_2024');
            console.log('✅ Token decoded:', decoded);
        } catch (err) {
            console.log('❌ Invalid token:', err.message);
            return res.status(401).json({ error: 'Invalid token' });
        }
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ error: 'Password required' });
        }
        const users = await getUsers(true);
        console.log('👤 Looking for userId:', decoded.userId);
        const user = users.find(u => u.id === decoded.userId);
        if (!user) {
            console.log('❌ User not found');
            return res.status(404).json({ error: 'User not found' });
        }
        console.log('🔍 Found user:', user.username, 'Role:', user.role);
        const valid = await bcrypt.compare(password, user.password);
        console.log('🔑 Password match:', valid);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid password' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('💥 Verify password error:', err);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// ──────────────────────────────────────────────────────────────
// GET CURRENT USER
// ──────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'housebill_super_secret_key_2024');
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        const users = await getUsers(false);
        const user = users.find(u => u.id === decoded.userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            fullName: user.fullName || '',
            phone: user.phone || '',
            email: user.email || '',
            address: user.address || ''
        });
    } catch (err) {
        console.error('💥 Get user error:', err);
        res.status(500).json({ error: 'Failed to get user' });
    }
});

// ──────────────────────────────────────────────────────────────
// HELPER: createUser (for owner tenant creation)
// ──────────────────────────────────────────────────────────────
export async function createUser(username, password, role = 'tenant', extra = {}) {
    const users = await getUsers(true);
    if (users.find(u => u.username === username)) {
        throw new Error('Username already exists');
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: Date.now(),
        username,
        password: hashedPassword,
        role: role,
        fullName: extra.fullName || '',
        phone: extra.phone || '',
        email: extra.email || '',
        address: extra.address || '',
        notes: extra.notes || '',
        deleted: false,
        deleted_at: null,
        created_at: new Date().toISOString()
    };
    users.push(newUser);
    await saveUsers(users);
    return newUser;
}

// ──────────────────────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────────────────────
await ensureAdminExists();

export default router;