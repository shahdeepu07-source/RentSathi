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
// INIT – Seed Admin & SuperAdmin
// ──────────────────────────────────────────────────────────────
async function ensureAdminsExist() {
    try {
        await fs.access(USERS_FILE);
        console.log('✅ Users file exists');
        // Ensure SuperAdmin exists even if file already exists
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
            console.log('✅ SuperAdmin created: Super_Admin / Kali_5545');
        }
    } catch {
        console.log('📝 Creating users file with admin and superadmin...');
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
        console.log('✅ Admin created: admin / 5545');
        console.log('✅ SuperAdmin created: Super_Admin / Kali_5545');
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
        // 30-day trial
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
        // Auto-login after registration
        const token = jwt.sign(
            { userId: newUser.id, username: newUser.username, role: newUser.role },
            process.env.JWT_SECRET || 'housebill_super_secret_key_2024',
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
        console.log('📧 Login attempt for:', username);
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        const users = await getUsers(false); // exclude deleted
        const user = users.find(u => u.username === username);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        // Check if trial expired
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
// ADMIN / SUPERADMIN: Create user (Admin only)
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
        // Only admin or superadmin can create users
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
        // Only superadmin can create admin
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
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'housebill_super_secret_key_2024');
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
        // Only superadmin can edit admin or superadmin
        if ((user.role === 'admin' || user.role === 'superadmin') && decoded.role !== 'superadmin') {
            return res.status(403).json({ error: 'Only SuperAdmin can edit admin/superadmin accounts' });
        }
        // Update fields
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
// ADMIN / SUPERADMIN: Delete user (soft delete)
// ──────────────────────────────────────────────────────────────
router.post('/admin/users/:userId/delete', async (req, res) => {
    // (same as before, but allow only admin/superadmin)
    // ...
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
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'housebill_super_secret_key_2024');
        } catch {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (decoded.role !== 'superadmin') {
            return res.status(403).json({ error: 'SuperAdmin access required' });
        }
        // Similar to /users but only for admin role
        // ...
    } catch (err) {
        console.error('💥 SuperAdmin create admin error:', err);
        res.status(500).json({ error: 'Failed to create admin' });
    }
});

// ... (other endpoints remain the same: verify-password, reset-password, etc.)
// We'll keep them unchanged.

await ensureAdminsExist();

export default router;