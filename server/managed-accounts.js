// ═══════════════════════════════════════════════════════════════════════
// MANAGED ACCOUNTS — real accounts that must survive redeploys + reseeds.
// Runs idempotently at boot. Unlike DEMO_ACCOUNTS this never touches the
// plaintext demo-password store, never overwrites an existing account's
// password/subscription, and is only used for genuinely real users.
// ═══════════════════════════════════════════════════════════════════════
import bcrypt from 'bcrypt';
import { getUsers, saveUsers, getOwnership, saveOwnership } from './db.js';

// Seema — real owner of M_house, lifetime subscription.
// username 9818100062. Password is set via env (SEEMA_PASSWORD) with a
// local-only default so the real credential is never committed to git.
const MANAGED_ACCOUNTS = [
    {
        username: '9818100062',
        password: process.env.SEEMA_PASSWORD || '5052',
        role: 'owner',
        fullName: 'Seema Devi',
        phone: '9818100062',
        email: '',
        address: '',
        notes: ''
    }
];

// M_house must always belong to the managed owner above.
const MANAGED_HOUSE = 'M_house';
const LIFETIME_STATUSES = ['expired', 'inactive', 'cancelled'];

async function ensureSingleAccount(a) {
    const users = await getUsers(true);
    let user = users.find(u => u.username === a.username);

    if (!user) {
        user = {
            id: Date.now(),
            username: a.username,
            password: await bcrypt.hash(a.password, 10),
            role: a.role,
            fullName: a.fullName,
            phone: a.phone || '',
            email: a.email || '',
            address: a.address || '',
            notes: a.notes || '',
            subscription_status: 'paid',
            subscription_plan: 'self',
            billing_cycle: '∞',
            subscription_tenants: null,
            trial_start: null,
            trial_end: null,
            deleted: false,
            deleted_at: null,
            created_at: new Date().toISOString()
        };
        users.push(user);
        await saveUsers(users);
        console.log(`[managed-accounts] created ${a.username} (${a.fullName})`);
        return user;
    }

    // Never downgrade an active sub; only rescue a blocked one.
    let changed = false;
    if (LIFETIME_STATUSES.includes(user.subscription_status)) {
        user.subscription_status = 'paid';
        user.subscription_plan = 'self';
        user.billing_cycle = '∞';
        user.subscription_tenants = null;
        user.trial_end = null;
        changed = true;
    }
    if (user.role !== 'owner') {
        user.role = 'owner';
        changed = true;
    }
    if (changed) await saveUsers(users);
    return user;
}

async function ensureHouseOwnership(owner) {
    const ownership = await getOwnership();
    const cur = ownership[MANAGED_HOUSE];
    if (cur && !cur.deleted && cur.owner_id == owner.id) return false;
    ownership[MANAGED_HOUSE] = {
        owner_id: owner.id,
        created_by: owner.id,
        created_at: cur && cur.created_at ? cur.created_at : new Date().toISOString(),
        deleted: false,
        deleted_at: null
    };
    await saveOwnership(ownership);
    console.log(`[managed-accounts] ${MANAGED_HOUSE} assigned to ${owner.username}`);
    return true;
}

export async function ensureManagedAccounts() {
    try {
        for (const a of MANAGED_ACCOUNTS) {
            const user = await ensureSingleAccount(a);
            await ensureHouseOwnership(user);
        }
    } catch (err) {
        console.error('[managed-accounts] error:', err.message || err);
    }
}