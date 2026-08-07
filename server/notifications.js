import { Router } from 'express';
import { getNotifs, saveNotifs, getOwnership, listHouseIds, readTenants, getUsers } from './db.js';
import { sendToUser } from './push.js';

const router = Router();

// ─── Constants ────────────────────────────────────────────────
const VALID_ROLES = ['superadmin', 'admin', 'owner', 'tenant'];
const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// Old notices store a single target_role; new ones store a target_roles array.
function targetRoles(notice) {
    if (Array.isArray(notice.target_roles) && notice.target_roles.length) return notice.target_roles;
    return notice.target_role ? [notice.target_role] : [];
}

function isTargetedAt(notice, role) {
    const roles = targetRoles(notice);
    if (role === 'superadmin') {
        // Superadmins also see admin-targeted notices (legacy behavior)
        return roles.includes('superadmin') || roles.includes('admin');
    }
    return roles.includes(role);
}

// ──────────────────────────────────────────────────────────────
// POST /api/notifications  —  Create a notice
// ──────────────────────────────────────────────────────────────
router.post('/notifications', async (req, res) => {
    try {
        const { role, userId, username } = req.user;
        const { title, message, priority, target_roles, house_id } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Title is required' });
        }
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'Message is required' });
        }
        if (title.length > 100) {
            return res.status(400).json({ error: 'Title must be 100 characters or less' });
        }
        if (message.length > 500) {
            return res.status(400).json({ error: 'Message must be 500 characters or less' });
        }
        if (priority && !VALID_PRIORITIES.includes(priority)) {
            return res.status(400).json({ error: 'Invalid priority' });
        }

        // --- Role-gated targeting ---
        let resolvedTargets;

        if (role === 'superadmin') {
            // Superadmin can target any combination of roles (default: everyone)
            if (Array.isArray(target_roles) && target_roles.length) {
                const invalid = target_roles.filter(r => !VALID_ROLES.includes(r));
                if (invalid.length) {
                    return res.status(400).json({ error: `Invalid target role(s): ${invalid.join(', ')}` });
                }
                resolvedTargets = [...new Set(target_roles)];
            } else {
                resolvedTargets = [...VALID_ROLES];
            }
        } else if (role === 'admin') {
            // Admin → Owner dashboards only
            resolvedTargets = ['owner'];
        } else if (role === 'owner') {
            // Owner → Their assigned Tenants only
            resolvedTargets = ['tenant'];
            if (!house_id) {
                return res.status(400).json({ error: 'Owner notices require a house_id' });
            }
            // Verify ownership of the specified house
            const ownership = await getOwnership();
            const house = ownership[house_id];
            if (!house || house.owner_id !== userId || house.deleted) {
                return res.status(403).json({ error: 'You do not own this house' });
            }
        } else {
            return res.status(403).json({ error: 'You are not allowed to create notices' });
        }

        const notifs = await getNotifs();
        const notice = {
            id: Date.now(),
            sender_id: userId,
            sender_name: username,
            sender_role: role,
            target_role: resolvedTargets.length === 1 ? resolvedTargets[0] : null,
            target_roles: resolvedTargets,
            house_id: house_id || null,
            title: title.trim(),
            message: message.trim(),
            priority: priority || 'normal',
            is_active: true,
            created_at: new Date().toISOString(),
            expires_at: null
        };

        notifs.push(notice);
        await saveNotifs(notifs);
        console.log(`${role} created notice for ${resolvedTargets.join(', ')}: "${notice.title}"`);

// ─── Push notifications to target users ─────────────────
        // Fire-and-forget: never block notice creation on delivery.
        (async () => {
            let targets = [];

            if (resolvedTargets.includes('superadmin')) {
                const users = await getUsers();
                targets.push(...users.filter(u => u.role === 'superadmin' && !u.deleted).map(u => u.id));
            }
            if (resolvedTargets.includes('admin')) {
                const users = await getUsers();
                targets.push(...users.filter(u => (u.role === 'admin' || u.role === 'superadmin') && !u.deleted).map(u => u.id));
            }
            if (resolvedTargets.includes('owner') && !(resolvedTargets.length === 1 && role === 'owner')) {
                const users = await getUsers();
                targets.push(...users.filter(u => u.role === 'owner' && !u.deleted).map(u => u.id));
            }
            // Tenant target: only for this house when it is house-scoped.
            if (resolvedTargets.includes('tenant')) {
                const houses = notice.house_id ? [notice.house_id] : await listHouseIds();
                for (const h of houses) {
                    try {
                        const tenants = await readTenants(h);
                        for (const t of tenants) {
                            if (t && !t.deleted && t.tenant_user_id) targets.push(t.tenant_user_id);
                        }
                    } catch { /* skip house */ }
                }
            }

            const unique = [...new Set(targets)].slice(0, 500);
            for (const uid of unique) {
                await sendToUser(uid, {
                    title: `📢 ${notice.title}`,
                    body: notice.message.slice(0, 160),
                    url: role === 'tenant' ? '/tenant.html' : '/index.html'
                }).catch(e => console.error('[push] notice hook:', e.message || e));
            }
        })().catch(err => console.error('[push] notice hook error:', err));

        res.status(201).json(notice);
    } catch (err) {
        console.error('Error creating notice:', err);
        res.status(500).json({ error: 'Failed to create notice' });
    }
});

// ──────────────────────────────────────────────────────────────
// GET /api/notifications  —  Fetch notices visible to current user
// ──────────────────────────────────────────────────────────────
router.get('/notifications', async (req, res) => {
    try {
        const { role, userId } = req.user;
        const notifs = await getNotifs();
        const active = notifs.filter(n => n.is_active);

        let visible = [];

        if (role === 'superadmin') {
            // Superadmins see notices aimed at superadmins or admins (legacy behavior)
            visible = active.filter(n => isTargetedAt(n, 'superadmin'));
        } else if (role === 'admin') {
            // Admins see notices targeted at 'admin'
            visible = active.filter(n => isTargetedAt(n, 'admin'));
        } else if (role === 'owner') {
            // Owners see notices targeted at 'owner'
            visible = active.filter(n => isTargetedAt(n, 'owner'));
        } else if (role === 'tenant') {
            // Tenants see notices their owner posted (target_role=tenant, matching their house)
            // Find which house(s) this tenant belongs to
            const houses = await listHouseIds();
            const ownership = await getOwnership();
            const activeHouses = houses.filter(h => !ownership[h]?.deleted);

            let myHouses = [];
            for (const house of activeHouses) {
                try {
                    const tenants = await readTenants(house);
                    const match = tenants.find(t =>
                        !t.deleted && (t.tenant_user_id === userId ||
                        t.name.toLowerCase() === (req.user.username || '').toLowerCase())
                    );
                    if (match) {
                        myHouses.push(house);
                    }
                } catch { continue; }
            }

            // Filter: target includes tenant AND (house_id is null OR matches tenant's house)
            visible = active.filter(n =>
                isTargetedAt(n, 'tenant') &&
                (!n.house_id || myHouses.includes(n.house_id))
            );
        }

        // Enrich with sender display info
        const enriched = visible.map(n => ({
            ...n,
            // Strip internal fields not needed by client
        }));

        res.json(enriched);
    } catch (err) {
        console.error('Error fetching notices:', err);
        res.status(500).json({ error: 'Failed to fetch notices' });
    }
});

// ──────────────────────────────────────────────────────────────
// GET /api/notifications/sent  —  All notices by this sender (active or not)
// ──────────────────────────────────────────────────────────────
router.get('/notifications/sent', async (req, res) => {
    try {
        const { userId } = req.user;
        const uid = Number(userId);
        const notifs = await getNotifs();
        const mine = notifs.filter(n => Number(n.sender_id) === uid);
        res.json(mine);
    } catch (err) {
        console.error('Error fetching sent notices:', err);
        res.status(500).json({ error: 'Failed to fetch sent notices' });
    }
});

// ──────────────────────────────────────────────────────────────
// PATCH /api/notifications/:id/dismiss  —  Acknowledge / dismiss
// ──────────────────────────────────────────────────────────────
router.patch('/notifications/:id/dismiss', async (req, res) => {
    try {
        const notifId = parseInt(req.params.id);
        const { role, userId } = req.user;
        const notifs = await getNotifs();
        const idx = notifs.findIndex(n => n.id === notifId);

        if (idx === -1) return res.status(404).json({ error: 'Notice not found' });

        const notice = notifs[idx];

        // Only the target audience can dismiss (or the sender)
        const isTarget = (
            (role === 'superadmin' && isTargetedAt(notice, 'superadmin')) ||
            (role === 'admin' && isTargetedAt(notice, 'admin')) ||
            (role === 'owner' && isTargetedAt(notice, 'owner')) ||
            (role === 'tenant' && isTargetedAt(notice, 'tenant'))
        );
        const isSender = notice.sender_id === userId;

        if (!isTarget && !isSender) {
            return res.status(403).json({ error: 'Not allowed to dismiss this notice' });
        }

        notifs[idx].is_active = false;
        await saveNotifs(notifs);
        res.json({ success: true });
    } catch (err) {
        console.error('Error dismissing notice:', err);
        res.status(500).json({ error: 'Failed to dismiss notice' });
    }
});

// ──────────────────────────────────────────────────────────────
// DELETE /api/notifications/:id  —  Delete (sender only)
// ──────────────────────────────────────────────────────────────
router.delete('/notifications/:id', async (req, res) => {
    try {
        const notifId = parseInt(req.params.id);
        const { userId } = req.user;
        let notifs = await getNotifs();
        const idx = notifs.findIndex(n => n.id === notifId);

        if (idx === -1) return res.status(404).json({ error: 'Notice not found' });
        if (notifs[idx].sender_id !== userId) {
            return res.status(403).json({ error: 'Only the sender can delete this notice' });
        }

        notifs.splice(idx, 1);
        await saveNotifs(notifs);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting notice:', err);
        res.status(500).json({ error: 'Failed to delete notice' });
    }
});

// ──────────────────────────────────────────────────────────────
// PUT /api/notifications/:id  —  Edit a notice (sender only)
// ──────────────────────────────────────────────────────────────
router.put('/notifications/:id', async (req, res) => {
    try {
        const notifId = parseInt(req.params.id);
        const { userId } = req.user;
        const { title, message, priority } = req.body;
        const notifs = await getNotifs();
        const idx = notifs.findIndex(n => n.id === notifId);

        if (idx === -1) return res.status(404).json({ error: 'Notice not found' });
        if (notifs[idx].sender_id !== userId) {
            return res.status(403).json({ error: 'Only the sender can edit this notice' });
        }

        if (title) notifs[idx].title = title.trim();
        if (message) notifs[idx].message = message.trim();
        if (priority) {
            if (!VALID_PRIORITIES.includes(priority)) {
                return res.status(400).json({ error: 'Invalid priority' });
            }
            notifs[idx].priority = priority;
        }
        notifs[idx].updated_at = new Date().toISOString();

        await saveNotifs(notifs);
        res.json(notifs[idx]);
    } catch (err) {
        console.error('Error editing notice:', err);
        res.status(500).json({ error: 'Failed to edit notice' });
    }
});

// ─── Admin: get all active notices (for management panel) ─────
router.get('/admin/notifications', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    try {
        const notifs = await getNotifs();
        const active = notifs.filter(n => n.is_active);
        // Admins see notices targeted at admin
        // Superadmins see all
        let filtered = active;
        if (req.user.role === 'admin') {
            filtered = active.filter(n => isTargetedAt(n, 'admin'));
        }
        res.json(filtered);
    } catch (err) {
        console.error('Error fetching admin notices:', err);
        res.status(500).json({ error: 'Failed to fetch notices' });
    }
});

export default router;
