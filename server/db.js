import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import 'dotenv/config';
import { resolveDataDir, USERS_FILE, OWNERSHIP_FILE, NOTIF_FILE, UPGRADES_FILE } from './paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Storage mode ─────────────────────────────────────────────
// If DATABASE_URL is set, all data lives in PostgreSQL (durable, survives
// redeploys on any host). Otherwise the legacy JSON files under data/ are
// used, so local development and the current Railway deploy keep working
// without any change.
export const DB_ENABLED = !!(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());

const DATA_DIR = await resolveDataDir();
await fs.mkdir(DATA_DIR, { recursive: true });
const getFilePath = (houseId) => path.join(DATA_DIR, `${houseId}.json`);

let pool = null;
if (DB_ENABLED) {
    pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 5
    });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,
    data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS houses (
    name TEXT PRIMARY KEY,
    data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS tenants (
    house_id TEXT NOT NULL,
    id BIGINT NOT NULL,
    data JSONB NOT NULL,
    PRIMARY KEY (house_id, id)
);
CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT PRIMARY KEY,
    data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS upgrade_requests (
    id BIGINT PRIMARY KEY,
    data JSONB NOT NULL
);
`;

// ─── Low-level helpers ────────────────────────────────────────
async function inTx(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw err;
    } finally {
        client.release();
    }
}

async function initSchema() {
    if (!DB_ENABLED) return;
    try {
        await pool.query(SCHEMA);
        console.log('PostgreSQL schema ready');
    } catch (err) {
        console.error('❌ Failed to initialise PostgreSQL schema:', err.message);
    }
}
await initSchema();

// ─── Users ────────────────────────────────────────────────────
export async function getUsers(includeDeleted = false) {
    if (DB_ENABLED) {
        const r = await pool.query('SELECT data FROM users ORDER BY id');
        const list = r.rows.map(x => x.data);
        return includeDeleted ? list : list.filter(u => !u.deleted);
    }
    const raw = await fs.readFile(USERS_FILE, 'utf8');
    const list = JSON.parse(raw);
    return includeDeleted ? list : list.filter(u => !u.deleted);
}

export async function saveUsers(users) {
    if (DB_ENABLED) {
        await inTx(async (c) => {
            await c.query('DELETE FROM users');
            for (const u of users) {
                await c.query('INSERT INTO users (id, data) VALUES ($1, $2)', [u.id, u]);
            }
        });
        return;
    }
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

// ─── Ownership (houses) ───────────────────────────────────────
export async function getOwnership() {
    if (DB_ENABLED) {
        const r = await pool.query('SELECT name, data FROM houses ORDER BY name');
        const map = {};
        for (const row of r.rows) map[row.name] = row.data;
        return map;
    }
    try {
        const raw = await fs.readFile(OWNERSHIP_FILE, 'utf8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

export async function saveOwnership(ownership) {
    if (DB_ENABLED) {
        await inTx(async (c) => {
            await c.query('DELETE FROM houses');
            for (const [name, val] of Object.entries(ownership || {})) {
                await c.query('INSERT INTO houses (name, data) VALUES ($1, $2)', [name, val]);
            }
        });
        return;
    }
    await fs.writeFile(OWNERSHIP_FILE, JSON.stringify(ownership || {}, null, 2));
}

// ─── Notifications ────────────────────────────────────────────
export async function getNotifs() {
    if (DB_ENABLED) {
        const r = await pool.query('SELECT data FROM notifications ORDER BY id');
        return r.rows.map(x => x.data);
    }
    try {
        const raw = await fs.readFile(NOTIF_FILE, 'utf8');
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

export async function saveNotifs(arr) {
    if (DB_ENABLED) {
        await inTx(async (c) => {
            await c.query('DELETE FROM notifications');
            for (const n of arr || []) {
                await c.query('INSERT INTO notifications (id, data) VALUES ($1, $2)', [n.id, n]);
            }
        });
        return;
    }
    await fs.writeFile(NOTIF_FILE, JSON.stringify(arr || [], null, 2));
}

// ─── Tenants (per house) ──────────────────────────────────────
export async function readTenants(houseId) {
    if (DB_ENABLED) {
        const r = await pool.query('SELECT data FROM tenants WHERE house_id = $1 ORDER BY id', [houseId]);
        return r.rows.map(x => x.data);
    }
    try {
        const raw = await fs.readFile(getFilePath(houseId), 'utf8');
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

export async function writeTenants(houseId, tenants) {
    if (DB_ENABLED) {
        await inTx(async (c) => {
            await c.query('DELETE FROM tenants WHERE house_id = $1', [houseId]);
            for (const t of tenants || []) {
                await c.query('INSERT INTO tenants (house_id, id, data) VALUES ($1, $2, $3)', [houseId, t.id, t]);
            }
        });
        return;
    }
    await fs.writeFile(getFilePath(houseId), JSON.stringify(tenants || [], null, 2), 'utf8');
}

// ─── Upgrade requests ─────────────────────────────────────────
export async function getUpgradeRequests() {
    if (DB_ENABLED) {
        const r = await pool.query('SELECT data FROM upgrade_requests ORDER BY id');
        return r.rows.map(x => x.data);
    }
    try {
        const raw = await fs.readFile(UPGRADES_FILE, 'utf8');
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

export async function saveUpgradeRequests(arr) {
    if (DB_ENABLED) {
        await inTx(async (c) => {
            await c.query('DELETE FROM upgrade_requests');
            for (const n of arr || []) {
                await c.query('INSERT INTO upgrade_requests (id, data) VALUES ($1, $2)', [n.id, n]);
            }
        });
        return;
    }
    await fs.writeFile(UPGRADES_FILE, JSON.stringify(arr || [], null, 2));
}

// ─── House listing / lifecycle ────────────────────────────────
export async function listHouseIds() {
    if (DB_ENABLED) {
        const r = await pool.query('SELECT DISTINCT house_id FROM tenants UNION SELECT name FROM houses');
        return r.rows.map(x => x.house_id || x.name).sort();
    }
    const files = await fs.readdir(DATA_DIR);
    return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
}

export async function houseExists(name) {
    if (DB_ENABLED) {
        const r = await pool.query('SELECT 1 FROM houses WHERE name = $1 LIMIT 1', [name]);
        if (r.rows.length) return true;
        const t = await pool.query('SELECT 1 FROM tenants WHERE house_id = $1 LIMIT 1', [name]);
        return t.rows.length > 0;
    }
    try {
        await fs.access(getFilePath(name));
        return true;
    } catch {
        return false;
    }
}

export async function renameHouse(oldName, newName) {
    if (DB_ENABLED) {
        await inTx(async (c) => {
            await c.query('UPDATE tenants SET house_id = $1 WHERE house_id = $2', [newName, oldName]);
        });
        return;
    }
    await fs.rename(getFilePath(oldName), getFilePath(newName));
}

export async function deleteHousePermanent(houseId) {
    if (DB_ENABLED) {
        await pool.query('DELETE FROM tenants WHERE house_id = $1', [houseId]);
        return;
    }
    try {
        await fs.unlink(getFilePath(houseId));
    } catch { /* no file */ }
}
