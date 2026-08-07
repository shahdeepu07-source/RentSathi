import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import 'dotenv/config';
import { getUsers, saveUsers, getOwnership, listHouseIds, readTenants, getNotifs, saveNotifs } from './db.js';
import { readDemoPasswords, appendAudit, ensureDemoStore } from './seed-demo.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rate limiting for password reveal: 5 attempts per 60s, lockout after 10
// consecutive failures (15 min). TEST/DEMO feature only.
const revealState = new Map();

// Public support inbox: data/support-requests.json (kept out of the houses
// data dir on purpose — see listHouseIds()).
const SUPPORT_FILE = path.join(__dirname, '..', 'data', 'support-requests.json');
const supportLimits = new Map(); // ip -> [timestamps]

// Brute-force protection for /api/auth/login. Keyed by "ip|username" so one
// attacker hammering one account gets locked out without locking everyone on
// a shared IP. 10 consecutive failures → 15 min lockout; per-key window of
// 20 tries / 15 min. Window and lock state purge themselves on access.
const LOGIN_MAX_CONSECUTIVE_FAILS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_WINDOW_MS = 30 * 60 * 1000;
const LOGIN_WINDOW_MAX_TRIES = 20;
const loginState = new Map(); // "ip|username" -> { fails, window: [], lockUntil }

function getClientIp(req) {
    return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function loginCheck(key) {
    const now = Date.now();
    let st = loginState.get(key) || { fails: 0, window: [], lockUntil: 0 };
    if (st.lockUntil > now) return st;
    st.window = st.window.filter(t => now - t < LOGIN_WINDOW_MS);
    if (st.window.length >= LOGIN_WINDOW_MAX_TRIES) {
        st.lockUntil = now + LOGIN_LOCK_MS;
    }
    loginState.set(key, st);
    return st;
}

function recordLoginFailure(key) {
    const now = Date.now();
    const st = loginState.get(key) || { fails: 0, window: [], lockUntil: 0 };
    st.window = st.window.filter(t => now - t < LOGIN_WINDOW_MS);
    st.window.push(now);
    st.fails += 1;
    if (st.fails >= LOGIN_MAX_CONSECUTIVE_FAILS) {
        st.fails = 0;
        st.lockUntil = now + LOGIN_LOCK_MS;
    }
    loginState.set(key, st);
}

// Total active (non-deleted) tenants across all houses owned by a user
export async function countActiveTenants(userId) {
    try {
        const ownership = await getOwnership();
        const allHouses = await listHouseIds();
        const owned = allHouses.filter(h => !ownership[h]?.deleted && String(ownership[h]?.owner_id) === String(userId));
        let count = 0;
        for (const h of owned) {
            const ts = await readTenants(h);
            if (Array.isArray(ts)) count += ts.filter(t => !t.deleted).length;
        }
        return count;
    } catch {
        return 0;
    }
}

// ──────────────────────────────────────────────────────────────
// INIT – Seed Admin & SuperAdmin
// ──────────────────────────────────────────────────────────────
async function ensureAdminsExist() {
    let users;
    try {
        users = await getUsers(true);
    } catch {
        users = [];
    }
    let changed = false;
    if (!users.some(u => u.role === 'superadmin')) {
        users.push({
            id: Date.now(),
            username: 'Super_Admin',
            password: await bcrypt.hash('Kali_5545', 10),
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
        changed = true;
        console.log('✅ SuperAdmin created');
    }
    if (!users.some(u => u.role === 'admin')) {
        users.push({
            id: 1,
            username: 'admin',
            password: await bcrypt.hash('5545', 10),
            role: 'admin',
            fullName: 'Administrator',
            phone: '',
            email: '',
            address: '',
            notes: '',
            houses: ['M_house'],
            subscription_status: 'active',
            trial_start: null,
            trial_end: null,
            deleted: false,
            deleted_at: null,
            created_at: new Date().toISOString()
        });
        changed = true;
        console.log('✅ Admin created');
    }
    if (changed) await saveUsers(users);
}

// Houses an admin may manage. M_house is reserved for the `admin` account.
function sanitizeHouses(houses, username) {
    if (!Array.isArray(houses)) return undefined;
    let list = houses.filter(h => typeof h === 'string' && h.trim());
    if (username !== 'admin') list = list.filter(h => h !== 'M_house');
    return [...new Set(list)];
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
        const ip = getClientIp(req);
        const key = `${ip}|${username}`;
        const guard = loginCheck(key);
        if (guard.lockUntil > Date.now()) {
            const mins = Math.ceil((guard.lockUntil - Date.now()) / 60000);
            return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} min.` });
        }
        const users = await getUsers(false);
        const user = users.find(u => u.username === username);
        if (!user) {
            recordLoginFailure(key);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        if (user.role === 'owner' && user.subscription_status === 'trial') {
            const now = new Date();
            const trialEnd = new Date(user.trial_end);
            if (now > trialEnd) {
                user.subscription_status = 'expired';
                await saveUsers(users);
            }
        }
        const validPassword = await bcrypt.compare(password, user.password);
        console.log('Password check completed');
        if (!validPassword) {
            recordLoginFailure(key);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        loginState.set(key, { fails: 0, window: [], lockUntil: 0 });
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
                subscription_plan: user.subscription_plan || null,
                billing_cycle: user.billing_cycle || null,
                subscription_tenants: user.subscription_tenants ?? null,
                tenant_count: user.role === 'owner' ? await countActiveTenants(user.id) : 0,
                trial_end: user.trial_end,
                houses: user.houses
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
        const { username, password, role, fullName, phone, email, address, notes, houses } = req.body;
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
        if (role === 'admin') {
            const safeHouses = sanitizeHouses(houses, username);
            if (safeHouses !== undefined) newUser.houses = safeHouses;
        }
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
        const { fullName, phone, email, address, notes, subscription_status, houses } = req.body;
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
        if (houses !== undefined && user.role === 'admin') {
            const safeHouses = sanitizeHouses(houses, user.username);
            if (safeHouses === undefined) delete user.houses;
            else user.houses = safeHouses;
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
        const { username, password, fullName, phone, email, address, notes, houses } = req.body;
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
        const safeHouses = sanitizeHouses(houses, username);
        if (safeHouses !== undefined) newAdmin.houses = safeHouses;
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
// CHANGE MY PASSWORD (any signed-in user)
// ──────────────────────────────────────────────────────────────
router.post('/change-password', async (req, res) => {
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
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password required' });
        }
        if (newPassword.length < 4) {
            return res.status(400).json({ error: 'New password must be at least 4 characters' });
        }
        const users = await getUsers(true);
        const user = users.find(u => u.id === decoded.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const valid = await bcrypt.compare(currentPassword, user.password);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
        user.password = await bcrypt.hash(newPassword, 10);
        await saveUsers(users);
        res.json({ success: true, message: 'Password updated' });
    } catch (err) {
        console.error('💥 Change password error:', err);
        res.status(500).json({ error: 'Failed to change password' });
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
        if (user.role === 'owner' && user.subscription_status === 'trial' && user.trial_end && new Date() > new Date(user.trial_end)) {
            user.subscription_status = 'expired';
            await saveUsers(users);
        }
        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            fullName: user.fullName || '',
            phone: user.phone || '',
            email: user.email || '',
            address: user.address || '',
            subscription_status: user.subscription_status,
            subscription_plan: user.subscription_plan || null,
            billing_cycle: user.billing_cycle || null,
            subscription_tenants: user.subscription_tenants ?? null,
            tenant_count: user.role === 'owner' ? await countActiveTenants(user.id) : 0,
            trial_end: user.trial_end,
            houses: user.houses
        });
    } catch (err) {
        console.error('💥 Get user error:', err);
        res.status(500).json({ error: 'Failed to get user' });
    }
});

// ──────────────────────────────────────────────────────────────
// PUBLIC: Support inquiry (app & web help desk)
// No login required — anyone can ask for help. Rate-limited to 5
// submissions per IP per hour. Each inquiry is stored and also pushed to
// the SuperAdmin notification strip.
// ──────────────────────────────────────────────────────────────
async function readSupportRequests() {
    try {
        const raw = await fs.readFile(SUPPORT_FILE, 'utf8');
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

router.post('/support', async (req, res) => {
    try {
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
        const now = Date.now();
        const hits = (supportLimits.get(ip) || []).filter(t => now - t < 3600000);
        if (hits.length >= 5) {
            return res.status(429).json({ error: 'Too many messages. Please try again later.' });
        }
        const { name, contact, topic, message } = req.body || {};
        if (!name || !String(name).trim() || String(name).trim().length > 80) {
            return res.status(400).json({ error: 'Please provide your name (max 80 characters).' });
        }
        if (!message || !String(message).trim() || String(message).trim().length < 10 || String(message).trim().length > 1000) {
            return res.status(400).json({ error: 'Message must be between 10 and 1000 characters.' });
        }
        if (contact && String(contact).trim().length > 120) {
            return res.status(400).json({ error: 'Contact is too long (max 120 characters).' });
        }
        if (topic && String(topic).trim().length > 60) {
            return res.status(400).json({ error: 'Topic is too long (max 60 characters).' });
        }
        hits.push(now);
        supportLimits.set(ip, hits);

        const entry = {
            id: Date.now(),
            name: String(name).trim(),
            contact: String(contact || '').trim(),
            topic: String(topic || '').trim(),
            message: String(message).trim(),
            ip,
            created_at: new Date().toISOString()
        };
        const all = await readSupportRequests();
        all.push(entry);
        if (all.length > 500) all.splice(0, all.length - 500);
        await fs.mkdir(path.dirname(SUPPORT_FILE), { recursive: true }).catch(() => {});
        await fs.writeFile(SUPPORT_FILE, JSON.stringify(all, null, 2));

        // Notify the SuperAdmin strip
        try {
            const notifs = await getNotifs();
            notifs.push({
                id: Date.now(),
                sender_id: 0,
                sender_name: 'Support form',
                sender_role: 'public',
                target_role: 'superadmin',
                target_roles: ['superadmin'],
                house_id: null,
                title: `Support request from ${entry.name}`,
                message: `${entry.message}${entry.contact ? '  — reply at ' + entry.contact : ''}${entry.topic ? ' [' + entry.topic + ']' : ''}`,
                priority: 'normal',
                is_active: true,
                created_at: entry.created_at,
                expires_at: null
            });
            await saveNotifs(notifs);
        } catch (err) {
            console.error('Support notification failed:', err.message);
        }

        console.log(`Support inquiry from ${entry.name}: "${entry.message.slice(0, 60)}"`);
        res.status(201).json({ success: true, id: entry.id });
    } catch (err) {
        console.error('💥 Support endpoint error:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// ──────────────────────────────────────────────────────────────
// ADMIN / SUPERADMIN: List support inquiries
// ──────────────────────────────────────────────────────────────
router.get('/admin/support', async (req, res) => {
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
        const all = await readSupportRequests();
        res.json(all.slice().reverse());
    } catch (err) {
        console.error('💥 Support list error:', err);
        res.status(500).json({ error: 'Failed to load support requests' });
    }
});

// ──────────────────────────────────────────────────────────────
// SUPERADMIN: Reveal stored (test-only) plaintext password
// Requires the SuperAdmin to re-enter their own password on every call.
// Backed by data/demo-passwords.json, which only ever contains the demo
// catalog accounts — never arbitrary production users.
// ──────────────────────────────────────────────────────────────
router.post('/reveal-password', async (req, res) => {
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
        const { superadminPassword, targetUserId } = req.body;
        if (!superadminPassword || !targetUserId) {
            return res.status(400).json({ error: 'superadminPassword and targetUserId required' });
        }
        const users = await getUsers(true);
        const sa = users.find(u => u.id === decoded.userId);
        if (!sa) return res.status(404).json({ error: 'SuperAdmin account not found' });

        const now = Date.now();
        const st = revealState.get(sa.id) || { fails: 0, window: [], lockUntil: 0 };
        if (st.lockUntil > now) {
            const mins = Math.ceil((st.lockUntil - now) / 60000);
            return res.status(429).json({ error: `Too many failed attempts. Locked for ${mins} more min.` });
        }
        st.window = st.window.filter(t => now - t < 60000);
        if (st.window.length >= 5) {
            return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
        }
        const valid = await bcrypt.compare(superadminPassword, sa.password);
        if (!valid) {
            st.fails += 1;
            st.window.push(now);
            if (st.fails >= 10) { st.fails = 0; st.lockUntil = now + 15 * 60000; }
            revealState.set(sa.id, st);
            await appendAudit({ at: new Date().toISOString(), who: sa.username, whoId: sa.id, target: String(targetUserId), ok: false });
            return res.status(401).json({ error: 'Invalid SuperAdmin password' });
        }
        st.fails = 0;
        st.lockUntil = 0;
        revealState.set(sa.id, st);

        const target = users.find(u => u.id === parseInt(targetUserId));
        if (!target) return res.status(404).json({ error: 'User not found' });
        const store = await readDemoPasswords();
        const plain = store[target.username];
        if (!plain) {
            await appendAudit({ at: new Date().toISOString(), who: sa.username, whoId: sa.id, target: target.username, targetId: target.id, ok: false, reason: 'no-stored-password' });
            return res.status(404).json({ error: 'No stored password for this account (not a demo account)' });
        }
        await appendAudit({ at: new Date().toISOString(), who: sa.username, whoId: sa.id, target: target.username, targetId: target.id, ok: true });
        res.json({ username: target.username, password: plain });
    } catch (err) {
        console.error('💥 Reveal password error:', err);
        res.status(500).json({ error: 'Reveal failed' });
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
ensureDemoStore().then(() => console.log('✅ Demo password store ready (test-only)'));

export default router;