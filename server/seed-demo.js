// ═══════════════════════════════════════════════════════════════════════
// TEST / DEMO SEEDING — NOT for production use.
// Creates demo data (owners, houses, tenants, bills) and records their
// plaintext passwords in a test-only store (data/demo-passwords.json) so the
// SuperAdmin "reveal password" feature has something to return. Only the
// accounts listed in DEMO_ACCOUNTS plus the seeded built-ins (Super_Admin,
// admin) are ever written to the plaintext store.
// ═══════════════════════════════════════════════════════════════════════
import { promises as fs } from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import { getUsers, saveUsers, getOwnership, saveOwnership, readTenants, writeTenants } from './db.js';
import { resolveDataDir } from './paths.js';

const DATA_DIR = await resolveDataDir();

export const DEMO_PASSWORDS_FILE = path.join(DATA_DIR, 'demo-passwords.json');
export const REVEAL_AUDIT_FILE = path.join(DATA_DIR, 'reveal-audit.json');

// ─── Demo account catalog (plaintext = test-only, kept in this module) ───
export const DEMO_ACCOUNTS = [
    { username: 'demo_owner1', password: 'Sunny@2081', role: 'owner', fullName: 'Suresh Shrestha' },
    { username: 'demo_owner2', password: 'Pooja@2081', role: 'owner', fullName: 'Pooja Sharma' },
    { username: 't_sita', password: 'Sita@2081', role: 'tenant', fullName: 'Sita Gurung' },
    { username: 't_ram', password: 'Ram@2081', role: 'tenant', fullName: 'Ram Thapa' },
    { username: 't_geeta', password: 'Geeta@2081', role: 'tenant', fullName: 'Geeta Rai' },
    { username: 't_harish', password: 'Harish@2081', role: 'tenant', fullName: 'Harish Maharjan' },
    { username: 't_meena', password: 'Meena@2081', role: 'tenant', fullName: 'Meena Joshi' },
    { username: 't_ajay', password: 'Ajay@2081', role: 'tenant', fullName: 'Ajay Karki' }
];

const BUILTIN_PASSWORDS = { Super_Admin: 'Kali_5545', admin: '5545' };

// ─── House → owner / tenants layout ─────────────────────────────────────
export const DEMO_HOUSES = [
    {
        name: 'DemoHouse-A', address: 'Kalanki, Kathmandu',
        owner: 'demo_owner1', rent: 12000, last_reading: 800,
        tenants: [
            { user: 't_sita', phone: '9800000001', email: 'sita@demo.np', balance: 0 },
            { user: 't_ram', phone: '9800000002', email: 'ram@demo.np', balance: 0 }
        ]
    },
    {
        name: 'DemoHouse-B', address: 'Balkhu, Kathmandu',
        owner: 'demo_owner1', rent: 8500, last_reading: 410,
        tenants: [
            { user: 't_geeta', phone: '9800000003', email: 'geeta@demo.np', balance: 0 },
            { user: 't_harish', phone: '9800000004', email: 'harish@demo.np', balance: 0 }
        ]
    },
    {
        name: 'DemoHouse-C', address: 'Sanepa, Lalitpur',
        owner: 'demo_owner2', rent: 15000, last_reading: 1020,
        tenants: [
            { user: 't_meena', phone: '9800000005', email: 'meena@demo.np', balance: 0 }
        ]
    },
    {
        name: 'DemoHouse-D', address: 'Baneshwor, Kathmandu',
        owner: 'demo_owner2', rent: 9500, last_reading: 620,
        tenants: [
            { user: 't_ajay', phone: '9800000006', email: 'ajay@demo.np', balance: 0 }
        ]
    }
];

// ─── Current BS (Bikram Sambat) month, year (approx) ────────────────────
export function currentBS() {
    const now = new Date();
    const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    let year = now.getFullYear() + 57;
    if (doy < 104) year -= 1;
    let days = doy - 104;
    if (days < 0) days += 365;
    const offsets = [0, 31, 62, 93, 124, 154, 185, 215, 246, 276, 307, 337];
    let monthIdx = 0;
    for (let i = 0; i < offsets.length; i++) { if (offsets[i] <= days) monthIdx = i; }
    return { year, month: monthIdx + 1 };
}

const BS_MONTH_NAMES = ['Baishakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin', 'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'];

export async function readDemoPasswords() {
    try {
        const raw = await fs.readFile(DEMO_PASSWORDS_FILE, 'utf8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

// Refresh the plaintext store for every account in the catalog that actually
// exists. Called at boot and after every seed so a redeploy (which wipes the
// ephemeral data dir) self-heals the store from the code-level catalog.
export async function ensureDemoStore() {
    try {
        const users = await getUsers(true);
        const store = await readDemoPasswords();
        let changed = false;
        const want = {};
        for (const a of DEMO_ACCOUNTS) want[a.username] = a.password;
        for (const [uname, pwd] of Object.entries(BUILTIN_PASSWORDS)) want[uname] = pwd;
        for (const u of users) {
            if (want[u.username] !== undefined) {
                if (store[u.username] !== want[u.username]) { store[u.username] = want[u.username]; changed = true; }
            }
        }
        if (changed) await fs.writeFile(DEMO_PASSWORDS_FILE, JSON.stringify(store, null, 2));
        return store;
    } catch (err) {
        console.error('ensureDemoStore failed:', err.message);
        return {};
    }
}

export async function appendAudit(entry) {
    try {
        let list = [];
        try {
            const raw = await fs.readFile(REVEAL_AUDIT_FILE, 'utf8');
            list = JSON.parse(raw);
        } catch { /* first entry */ }
        list.push(entry);
        if (list.length > 500) list = list.slice(-500);
        await fs.writeFile(REVEAL_AUDIT_FILE, JSON.stringify(list, null, 2));
    } catch (err) {
        console.error('audit write failed:', err.message);
    }
}

// ─── Seed (idempotent) ──────────────────────────────────────────────────
export async function seedDemoData() {
    const result = { created: { users: 0, houses: 0, tenants: 0, bills: 0 }, skipped: { users: 0, houses: 0, tenants: 0 }, accounts: [] };
    let seq = 1;

    // 1. Users
    const users = await getUsers(true);
    const userMap = {};
    for (const u of users) userMap[u.username] = u;
    const createdUsers = [];
    for (const a of DEMO_ACCOUNTS) {
        if (userMap[a.username]) { result.skipped.users++; userMap[a.username] = userMap[a.username]; continue; }
        const newUser = {
            id: Date.now() + seq++,
            username: a.username,
            password: await bcrypt.hash(a.password, 10),
            role: a.role,
            fullName: a.fullName,
            phone: '',
            email: '',
            address: '',
            notes: '',
            subscription_status: a.role === 'owner' ? 'active' : undefined,
            subscription_plan: a.role === 'owner' ? 'full' : undefined,
            billing_cycle: a.role === 'owner' ? 'monthly' : undefined,
            subscription_tenants: a.role === 'owner' ? 50 : undefined,
            deleted: false,
            deleted_at: null,
            created_at: new Date().toISOString()
        };
        for (const k of ['subscription_status', 'subscription_plan', 'billing_cycle', 'subscription_tenants']) {
            if (newUser[k] === undefined) delete newUser[k];
        }
        users.push(newUser);
        userMap[a.username] = newUser;
        createdUsers.push(newUser);
        result.created.users++;
    }
    if (createdUsers.length) await saveUsers(users);

    // 2. Houses + ownership
    const ownership = await getOwnership();
    let houseChanged = false;
    for (const h of DEMO_HOUSES) {
        if (ownership[h.name] && !ownership[h.name].deleted) { result.skipped.houses++; continue; }
        const owner = userMap[h.owner];
        if (!owner) { result.skipped.houses++; continue; }
        await writeTenants(h.name, []);
        ownership[h.name] = {
            owner_id: owner.id,
            created_by: owner.id,
            created_at: new Date().toISOString(),
            deleted: false,
            deleted_at: null
        };
        houseChanged = true;
        result.created.houses++;
    }
    if (houseChanged) await saveOwnership(ownership);

    // 3. Tenants + 4. bills
    const cur = currentBS();
    const monthIdx = cur.month - 1;
    for (const h of DEMO_HOUSES) {
        const owner = userMap[h.owner];
        if (!owner) continue;
        const tenants = await readTenants(h.name);
        const existingNames = new Set(tenants.map(t => t.name));
        for (const tDef of h.tenants) {
            const u = userMap[tDef.user];
            if (!u) continue;
            let tenant = tenants.find(t => t.tenant_user_id && String(t.tenant_user_id) === String(u.id));
            if (!tenant && existingNames.has(u.fullName)) {
                tenant = tenants.find(t => t.name === u.fullName);
            }
            if (!tenant) {
                tenant = {
                    id: Date.now() + seq++,
                    name: u.fullName,
                    rent_amount: h.rent,
                    last_reading: h.last_reading,
                    phone: tDef.phone,
                    email: tDef.email,
                    address: h.address,
                    tenant_user_id: u.id,
                    balance: tDef.balance,
                    deleted: false,
                    deleted_at: null,
                    history: []
                };
                tenants.push(tenant);
                existingNames.add(tenant.name);
                result.created.tenants++;
            }
            if (tenant.history && tenant.history.length === 0) {
                const bills = [];
                for (let back = 1; back <= 3; back++) {
                    let mi = monthIdx - back;
                    let yy = cur.year;
                    while (mi < 0) { mi += 12; yy -= 1; }
                    const month = `${BS_MONTH_NAMES[mi]} ${yy}`;
                    const prev = tenant.last_reading + (back - 1) * 14;
                    const curr = prev + 14 + back;
                    const units = curr - prev;
                    const water = 250 + back * 10;
                    const waste = 200;
                    const due = back === 3 ? 1500 : 0;
                    const ded = back === 3 ? 300 : 0;
                    const total = units * 15 + h.rent + water + waste + due - ded;
                    bills.push({
                        id: Date.now() + seq++,
                        name: tenant.name,
                        month,
                        prev,
                        curr,
                        units,
                        electricity: units * 15,
                        rent: h.rent,
                        water,
                        waste,
                        due,
                        ded,
                        dedReason: ded > 0 ? 'Water line maintenance' : '',
                        note: '',
                        total,
                        paid_status: back <= 2,
                        createdAt: new Date(Date.now() - back * 32 * 86400000).toISOString()
                    });
                    result.created.bills++;
                }
                tenant.history = bills;
                tenant.last_reading = tenant.history[tenant.history.length - 1].curr;
                tenant.balance = tenant.history.filter(b => !b.paid_status).reduce((s, b) => s + b.total, 0) + tDef.balance;
            }
        }
        await writeTenants(h.name, tenants);
    }

    // 5. Plaintext store
    await ensureDemoStore();

    result.accounts = DEMO_ACCOUNTS.map(a => ({
        username: a.username, password: a.password, role: a.role,
        house: (DEMO_HOUSES.find(h => h.tenants.some(t => t.user === a.username)) || {}).name || '',
        linked: !!userMap[a.username]
    }));
    return result;
}
