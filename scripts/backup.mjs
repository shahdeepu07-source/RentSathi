import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import 'dotenv/config';
import { resolveDataDir, USERS_FILE, OWNERSHIP_FILE, NOTIF_FILE } from '../server/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const KEEP = 14;

async function dumpPostgres() {
    const pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 2
    });
    try {
        const [u, h, t, n] = await Promise.all([
            pool.query('SELECT data FROM users ORDER BY id'),
            pool.query('SELECT name, data FROM houses ORDER BY name'),
            pool.query('SELECT house_id, data FROM tenants ORDER BY house_id, id'),
            pool.query('SELECT data FROM notifications ORDER BY id')
        ]);
        const tenants = {};
        for (const row of t.rows) {
            (tenants[row.house_id] = tenants[row.house_id] || []).push(row.data);
        }
        return {
            app: 'sajilorent',
            source: 'postgres',
            createdAt: new Date().toISOString(),
            users: u.rows.map(r => r.data),
            houses: Object.fromEntries(h.rows.map(r => [r.name, r.data])),
            tenants,
            notifications: n.rows.map(r => r.data)
        };
    } finally {
        await pool.end();
    }
}

async function dumpJson() {
    const dataDir = await resolveDataDir();
    const read = async (p) => {
        try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
    };
    const tenants = {};
    for (const f of (await fs.readdir(dataDir)).filter(x => x.endsWith('.json'))) {
        tenants[f.replace('.json', '')] = JSON.parse(await fs.readFile(path.join(dataDir, f), 'utf8'));
    }
    return {
        app: 'sajilorent',
        source: 'json',
        createdAt: new Date().toISOString(),
        users: (await read(USERS_FILE)) || [],
        houses: (await read(OWNERSHIP_FILE)) || {},
        tenants,
        notifications: (await read(NOTIF_FILE)) || []
    };
}

await fs.mkdir(BACKUP_DIR, { recursive: true });
const data = process.env.DATABASE_URL ? await dumpPostgres() : await dumpJson();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = path.join(BACKUP_DIR, `sajilorent-${stamp}.json`);
await fs.writeFile(file, JSON.stringify(data, null, 2));

const backups = (await fs.readdir(BACKUP_DIR)).filter(f => f.startsWith('sajilorent-')).sort();
for (const f of backups.slice(0, Math.max(0, backups.length - KEEP))) {
    await fs.unlink(path.join(BACKUP_DIR, f));
}

const size = (await fs.stat(file)).size;
console.log(`Backup written: ${path.relative(process.cwd(), file)} (${(size / 1024).toFixed(1)} KB, source: ${data.source})`);
