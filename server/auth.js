import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');

// ──────────────────────────────────────────────────────────────
// INIT – Seed Admin & SuperAdmin
// ──────────────────────────────────────────────────────────────
async function ensureAdminsExist() {
    try {
        await fs.access(USERS_FILE);
        console.log('Users file exists');
        const data = await fs.readFile(USERS_FILE, 'utf8');
        const users = JSON.parse(data);
        const hasSuperAdmin = users.some(u => u.role === 'superadmin');
        if (!hasSuperAdmin) {
            const hashedPassword = await bcrypt.hash('Kali_5545', 10);
            users.push({
                id: Date.now(),
                username: 'Super_Admin',
                password: hashedPassword,
                role: 'superadmin',
                fullName: 'Kali',
                phone: '',
                email: '',
                address: '',
                notes: '',
                subscription_status: 'active',
                trial_start: null,
                trial_end: null,
                deleted: false,
                deleted_at: null,
                created_at: new Date().toISOString()
            });
            await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
console.log('SuperAdmin created');
        }
    } catch {
        console.log('Creating users file with admin and superadmin...');
        const adminHash = await bcrypt.hash('5545', 10);
        const superHash = await bcrypt.hash('Kali_5545', 10);
        const initialUsers = [
            {
                id: 1,
                username: 'admin',
                password: adminHash,
                role: 'admin',
                fullName: 'Administrator',
                phone: '',
                email: '',
                address: '',
                notes: '',
                subscription_status: 'active',
                trial_start: null,
                trial_end: null,
                deleted: false,
                deleted_at: null,
                created_at: new Date().toISOString()
            },
            {
                id: 2,
                username: 'Super_Admin',
                password: superHash,
                role: 'superadmin',
                fullName: 'Kali',
                phone: '',
                email: '',
                address: '',
                notes: '',
                subscription_status: 'active',
                trial_start: null,
                trial_end: null,
                deleted: false,
                deleted_at: null,
                created_at: new Date().toISOString()
            }
        ];
        await fs.mkdir(path.dirname(USERS_FILE), { recursive: true });
        await fs.writeFile(USERS_FILE, JSON.stringify(initialUsers, null, 2));
        console.log('✅ Admin created');
        console.log('✅ SuperAdmin created');
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
// PUBLIC: Register (Owner only)
// ──────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
    try {
        const { username, password, fullName, phone, email, address } = req.body;
        if (!username || !password || !fullName || !phone || !email) {
            return res.status(400).json({ error: 'All fields except address are required' });
        }
        const users = await getUsers(true);
        if (users.find(u => u.username === username)) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        const trialStart = new Date();
        const trialEnd = new Date(trialStart);
        trialEnd.setDate(trialEnd.getDate() + 30);
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            id: Date.now(),
            username,
            password: hashedPassword,
            role: 'owner',
            fullName,
            phone,
            email,
            address: address || '',
            notes: '',
            subscription_status: 'trial',
            trial_start: trialStart.toISOString(),
            trial_end: trialEnd.toISOString(),
            deleted: false,
            deleted_at: null,
            created_at: new Date().toISOString()
        };
        users.push(newUser);
        await saveUsers(users);
        const token = jwt.sign(
            { userId: newUser.id, username: newUser.username, role: newUser.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.status(201).json({
            token,
            user: {
                id: newUser.id,
                username: newUser.username,
                role: newUser.role,
                fullName: newUser.fullName
            },
            trial_end: newUser.trial_end
        });
    } catch (err) {
        console.error('💥 Registration error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// ──────────────────────────────────────────────────────────────
// PUBLIC: Login
// ──────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log('Login attempt for:', username);
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        const users = await getUsers(false);
        const user = users.find(u => u.username === username);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        if (user.role === 'owner' && user.subscription_status === 'trial') {
            const now = new Date();
            const trialEnd = new Date(user.trial_end);
            if (now > trialEnd) {
                user.subscription_status = 'expired';
                await saveUsers(users);
                return res.status(403).json({ error: 'Trial expired. Please contact admin to renew.' });
            }
        }
        const validPassword = await bcrypt.compare(password, user.password);
        console.log('Password check completed');
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign(
            { userId: user.id, username: user.username, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                fullName: user.fullName || '',
                subscription_status: user.subscription_status,
                trial_end: user.trial_end
            }
        });
    } catch (err) {
        console.error('💥 Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ──────────────────────────────────────────────────────────────
// ADMIN / SUPERADMIN: Create user (Owner or Admin)
// ──────────────────────────────────────────────────────────────
router.post('/users', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (!['admin', 'superadmin'].includes(decoded.role)) {
            return res.status(403).json({ error: 'Admin or SuperAdmin access required' });
        }
        const { username, password, role, fullName, phone, email, address, notes } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        if (!['owner', 'admin'].includes(role)) {
            return res.status(400).json({ error: 'Role must be "owner" or "admin"' });
        }
        if (role === 'admin' && decoded.role !== 'superadmin') {
            return res.status(403).json({ error: 'Only SuperAdmin can create Admin accounts' });
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
            subscription_status: 'active',
            trial_start: null,
            trial_end: null,
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
// ADMIN / SUPERADMIN: Update user (edit details)
// ──────────────────────────────────────────────────────────────
router.put('/users/:userId', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (!['admin', 'superadmin'].includes(decoded.role)) {
            return res.status(403).json({ error: 'Admin or SuperAdmin access required' });
        }
        const userId = parseInt(req.params.userId);
        const { fullName, phone, email, address, notes, subscription_status } = req.body;
        const users = await getUsers(true);
        const user = users.find(u => u.id === userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if ((user.role === 'admin' || user.role === 'superadmin') && decoded.role !== 'superadmin') {
            return res.status(403).json({ error: 'Only SuperAdmin can edit admin/superadmin accounts' });
        }
        if (fullName !== undefined) user.fullName = fullName;
        if (phone !== undefined) user.phone = phone;
        if (email !== undefined) user.email = email;
        if (address !== undefined) user.address = address;
        if (notes !== undefined) user.notes = notes;
        if (subscription_status !== undefined && user.role === 'owner') {
            user.subscription_status = subscription_status;
        }
        await saveUsers(users);
        res.json({ success: true, user });
    } catch (err) {
        console.error('💥 User update error:', err);
        res.status(500).json({ error: 'User update failed' });
    }
});

// ──────────────────────────────────────────────────────────────
// SUPERADMIN: Create admin (only superadmin)
// ──────────────────────────────────────────────────────────────
router.post('/superadmin/admins', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (decoded.role !== 'superadmin') {
            return res.status(403).json({ error: 'SuperAdmin access required' });
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
        const newAdmin = {
            id: Date.now(),
            username,
            password: hashedPassword,
            role: 'admin',
            fullName: fullName || '',
            phone: phone || '',
            email: email || '',
            address: address || '',
            notes: notes || '',
            subscription_status: 'active',
            trial_start: null,
            trial_end: null,
            deleted: false,
            deleted_at: null,
            created_at: new Date().toISOString()
        };
        users.push(newAdmin);
        await saveUsers(users);
        res.status(201).json({
            id: newAdmin.id,
            username: newAdmin.username,
            role: newAdmin.role,
            fullName: newAdmin.fullName
        });
    } catch (err) {
        console.error('💥 SuperAdmin create admin error:', err);
        res.status(500).json({ error: 'Failed to create admin' });
    }
});

// ──────────────────────────────────────────────────────────────
// ADMIN: Soft delete user
// ──────────────────────────────────────────────────────────────
router.post('/admin/users/:userId/delete', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
    const userId = parseInt(req.params.userId);
    try {
        const usersData = await fs.readFile(USERS_FILE, 'utf8');
        const users = JSON.parse(usersData);
        const user = users.find(u => u.id === userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'superadmin') return res.status(403).json({ error: 'Cannot delete SuperAdmin' });
        if (user.deleted) return res.status(400).json({ error: 'User already deleted' });
        user.deleted = true;
        user.deleted_at = new Date().toISOString();
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        console.log(`User "${user.username}" (${user.role}) moved to trash`);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting user:', err);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// ──────────────────────────────────────────────────────────────
// VERIFY PASSWORD (with debug logs)
// ──────────────────────────────────────────────────────────────
router.post('/verify-password', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: 'Password required' });
        const users = await getUsers(true);
        const user = users.find(u => u.id === decoded.userId);
        if (!user) {
            console.log('verify-password: User not found for userId:', decoded.userId);
            return res.status(404).json({ error: 'User not found' });
        }
        console.log(`verify-password: Found user ${user.username}, checking password...`);
        const valid = await bcrypt.compare(password, user.password);
        console.log(`verify-password: Password match = ${valid}`);
        if (!valid) return res.status(401).json({ error: 'Invalid password' });
        res.json({ success: true });
    } catch (err) {
        console.error('💥 Verify password error:', err);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// ──────────────────────────────────────────────────────────────
// ADMIN / SUPERADMIN: Reset password
// ──────────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (!['admin', 'superadmin'].includes(decoded.role)) {
            return res.status(403).json({ error: 'Admin or SuperAdmin access required' });
        }
        const { userId, newPassword } = req.body;
        if (!userId || !newPassword) return res.status(400).json({ error: 'UserId and newPassword required' });
        const users = await getUsers(true);
        const user = users.find(u => u.id === parseInt(userId));
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'superadmin') return res.status(403).json({ error: 'SuperAdmin passwords cannot be reset this way' });
        user.password = await bcrypt.hash(newPassword, 10);
        await saveUsers(users);
        res.json({ success: true, message: `Password reset for ${user.username}` });
    } catch (err) {
        console.error('💥 Password reset error:', err);
        res.status(500).json({ error: 'Password reset failed' });
    }
});

// ──────────────────────────────────────────────────────────────
// GET current user
// ──────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        const users = await getUsers(false);
        const user = users.find(u => u.id === decoded.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            fullName: user.fullName || '',
            phone: user.phone || '',
            email: user.email || '',
            address: user.address || '',
            subscription_status: user.subscription_status,
            trial_end: user.trial_end
        });
    } catch (err) {
        console.error('💥 Get user error:', err);
        res.status(500).json({ error: 'Failed to get user' });
    }
});

// ──────────────────────────────────────────────────────────────
// EXPORT createUser helper
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
await ensureAdminsExist();

export default router;