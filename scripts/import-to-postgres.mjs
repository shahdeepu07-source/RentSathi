// One-time import: migrate data/*.json files into PostgreSQL.
// Requires DATABASE_URL to be set (e.g. a Neon connection string).
// Run: node scripts/import-to-postgres.mjs
import { promises as fs } from 'fs';
import path from 'path';
import 'dotenv/config';
import { DB_ENABLED, saveUsers, saveOwnership, saveNotifs, writeTenants } from '../server/db.js';
import { USERS_FILE, OWNERSHIP_FILE, NOTIF_FILE, resolveDataDir } from '../server/paths.js';

if (!DB_ENABLED) {
    console.error('❌ DATABASE_URL is not set. Aborting — nothing would be imported.');
    process.exit(1);
}

const DATA_DIR = await resolveDataDir();

try {
    const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    await saveUsers(users);
    console.log(`✔ users: ${users.length} rows`);
} catch {
    console.log('– users: no file found, skipped');
}

try {
    const ownership = JSON.parse(await fs.readFile(OWNERSHIP_FILE, 'utf8'));
    await saveOwnership(ownership);
    console.log(`✔ ownership: ${Object.keys(ownership).length} houses`);
} catch {
    console.log('– ownership: no file found, skipped');
}

try {
    const notifs = JSON.parse(await fs.readFile(NOTIF_FILE, 'utf8'));
    await saveNotifs(notifs);
    console.log(`✔ notifications: ${notifs.length} rows`);
} catch {
    console.log('– notifications: no file found, skipped');
}

const files = await fs.readdir(DATA_DIR);
for (const f of files.filter(x => x.endsWith('.json'))) {
    const houseId = f.replace('.json', '');
    const tenants = JSON.parse(await fs.readFile(path.join(DATA_DIR, f), 'utf8'));
    await writeTenants(houseId, tenants);
    console.log(`✔ ${houseId}: ${tenants.length} tenants`);
}

console.log('🎉 Import complete.');
process.exit(0);
