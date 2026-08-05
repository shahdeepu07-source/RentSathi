import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_ROOT = path.join(__dirname, '..', 'data');

// On Windows (case-insensitive filesystem) `data/clients` and `data/Clients`
// are the same directory; on Linux deploys (e.g. Railway) they are different,
// and the git-tracked files may live under either casing. Resolve the real
// on-disk directory name so every read/write targets the same folder.
export async function resolveDataDir() {
    try {
        const entries = await fs.readdir(DATA_ROOT);
        const found = entries.find(e => e.toLowerCase() === 'clients');
        if (found) {
            const candidate = path.join(DATA_ROOT, found);
            const st = await fs.stat(candidate);
            if (st.isDirectory()) return candidate;
        }
    } catch { /* directory does not exist yet */ }
    return path.join(DATA_ROOT, 'clients');
}

export const USERS_FILE = path.join(DATA_ROOT, 'users.json');
export const OWNERSHIP_FILE = path.join(DATA_ROOT, 'ownership.json');
export const NOTIF_FILE = path.join(DATA_ROOT, 'notifications.json');
export const UPGRADES_FILE = path.join(DATA_ROOT, 'upgrade_requests.json');
export const PAYMENTS_FILE = path.join(DATA_ROOT, 'payments.json');
