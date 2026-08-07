import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import webpush from 'web-push';
import { getPushSubs, savePushSubs } from './db.js';
import { resolveDataDir } from './paths.js';
import { isFcmConfigured, sendFcmToToken } from './fcm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VAPID_FILE = path.join(__dirname, '..', 'data', 'vapid.json');

let vapidPublicKey = null;
let vapidPrivateKey = null;

// ─── VAPID keys ────────────────────────────────────────────────
// Keys come from env when set (stable across redeploys); otherwise they are
// generated once at boot and persisted under data/vapid.json so all server
// restarts share the same pair. The public key is served to clients at
// GET /api/push/vapid-key.
async function ensureVapid() {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
        vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
    } else {
        try {
            const raw = await fs.readFile(VAPID_FILE, 'utf8');
            const saved = JSON.parse(raw);
            vapidPublicKey = saved.publicKey;
            vapidPrivateKey = saved.privateKey;
        } catch {
            const keys = webpush.generateVAPIDKeys();
            vapidPublicKey = keys.publicKey;
            vapidPrivateKey = keys.privateKey;
            const dir = path.dirname(VAPID_FILE);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(VAPID_FILE, JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }, null, 2));
            console.log('[push] Generated VAPID keys (persisted to data/vapid.json). For stable deploy keys set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in platform env vars.');
        }
    }
    webpush.setVapidDetails('mailto:admin@sajilorent.com', vapidPublicKey, vapidPrivateKey);
}

export function getVapidPublicKey() {
    return vapidPublicKey;
}

export async function initPush() {
    await ensureVapid();
}

// ─── Subscription store ────────────────────────────────────────
export async function registerSubscription({ userId, role, platform, subscription, deviceName }) {
    const subs = await getPushSubs();
    const key = platform === 'android'
        ? subscription.token
        : subscription.endpoint;
    const existing = subs.find(s => s.userId === userId && s.platform === platform && s.key === key);
    const now = new Date().toISOString();
    if (existing) {
        existing.subscription = subscription;
        existing.deviceName = deviceName || existing.deviceName;
        existing.updated_at = now;
        await savePushSubs(subs);
        return existing;
    }
    const entry = {
        id: Date.now(),
        userId,
        role,
        platform,
        key,
        subscription,
        deviceName: deviceName || '',
        created_at: now,
        updated_at: now
    };
    subs.push(entry);
    await savePushSubs(subs);
    return entry;
}

export async function unregisterSubscription({ userId, platform, key }) {
    let subs = await getPushSubs();
    const before = subs.length;
    subs = subs.filter(s => !(s.userId === userId && s.platform === platform && s.key === key));
    if (subs.length !== before) {
        await savePushSubs(subs);
        return true;
    }
    return false;
}

export async function getSubsForUser(userId) {
    const subs = await getPushSubs();
    return subs.filter(s => String(s.userId) === String(userId));
}

// ─── Sending ───────────────────────────────────────────────────
// Send to every device registered for a user. Dead subscriptions
// (410 Gone / 404) are pruned automatically.
export async function sendToUser(userId, { title, body, url }) {
    const subs = await getSubsForUser(userId);
    if (!subs.length) return { sent: 0, pruned: 0 };
    let pruned = [];
    let sent = 0;

    for (const sub of subs) {
        try {
            if (sub.platform === 'android') {
                if (!(await isFcmConfigured())) {
                    continue;
                }
                try {
                    await sendFcmToToken(sub.subscription.token, { title, body, url: url || '/' });
                    sent += 1;
                    console.log(`[push] delivered to android device of user ${userId}${sub.deviceName ? ' (' + sub.deviceName + ')' : ''}`);
                } catch (err) {
                    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
                        pruned.push(sub.id);
                    } else {
                        console.error(`[push] FCM send failed (${sub.platform}):`, err.message || err);
                    }
                }
                continue;
            }
            const payload = JSON.stringify({ title, body, url: url || '/' });
            await webpush.sendNotification(sub.subscription, payload, { TTL: 86400 });
            sent += 1;
            console.log(`[push] delivered to ${sub.platform} device of user ${userId}${sub.deviceName ? ' (' + sub.deviceName + ')' : ''}`);
        } catch (err) {
            if (err && (err.statusCode === 410 || err.statusCode === 404)) {
                pruned.push(sub.id);
            } else {
                console.error(`[push] send failed (${sub.platform}):`, err.message || err);
            }
        }
    }

    if (pruned.length) {
        let subsAll = await getPushSubs();
        subsAll = subsAll.filter(s => !pruned.includes(s.id));
        await savePushSubs(subsAll);
    }

    return { sent, pruned: pruned.length };
}

export async function sendToMany(userIds, payload) {
    const results = [];
    for (const uid of userIds) {
        results.push(await sendToUser(uid, payload));
    }
    return results;
}

export async function listSubscriptions() {
    return getPushSubs();
}

// ─── Auth-aware router (mounted under /api) ───────────────────
// All routes below sit behind verifyToken (per-request, not per-device), so
// a subscription is always bound to the currently logged-in user.
const router = Router();

// Public: VAPID public key used by the client's pushManager.subscribe().
router.get('/push/vapid-key', (req, res) => {
    if (!vapidPublicKey) {
        return res.status(503).json({ error: 'Push not initialised' });
    }
    res.json({ publicKey: vapidPublicKey });
});

// Register a device (web browser endpoint or Android/FCM token).
// web:    { platform:'web', subscription:{endpoint, keys:{p256dh,auth}} }
// android:{ platform:'android', subscription:{token } }
router.post('/push/register', async (req, res) => {
    try {
        const { userId, role, username } = req.user;
        const { platform, subscription, deviceName } = req.body || {};
        if (!platform || !['web', 'android'].includes(platform)) {
            return res.status(400).json({ error: 'Platform must be "web" or "android"' });
        }
        if (!subscription) {
            return res.status(400).json({ error: 'subscription is required' });
        }
        if (platform === 'web' && !(subscription.endpoint && subscription.keys)) {
            return res.status(400).json({ error: 'Web subscription needs endpoint and keys' });
        }
        if (platform === 'android' && !subscription.token) {
            return res.status(400).json({ error: 'Android subscription needs a token' });
        }
        const entry = await registerSubscription({ userId, role, platform, subscription, deviceName });
        res.status(201).json({ success: true, id: entry.id });
    } catch (err) {
        console.error('[push] register error:', err);
        res.status(500).json({ error: 'Failed to register subscription' });
    }
});

// Unregister when the user turns push off or the device is removed.
router.post('/push/unregister', async (req, res) => {
    try {
        const { userId } = req.user;
        const { platform, key } = req.body || {};
        if (!platform || !['web', 'android'].includes(platform) || !key) {
            return res.status(400).json({ error: 'platform and key are required' });
        }
        await unregisterSubscription({ userId, platform, key });
        res.json({ success: true });
    } catch (err) {
        console.error('[push] unregister error:', err);
        res.status(500).json({ error: 'Failed to unregister subscription' });
    }
});

export default router;
