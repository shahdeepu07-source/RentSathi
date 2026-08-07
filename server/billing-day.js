import NepaliDate from 'nepali-date-converter';
import { getUsers, getNotifs, saveNotifs } from './db.js';
import { sendToUser } from './push.js';

const BillingDateConverter = NepaliDate.default || NepaliDate;

const firedMonths = new Set();
let running = false;

// True when today is the 1st day of a Bikram Sambat month.
export function isBsMonthStart() {
    try {
        const bs = new BillingDateConverter(new Date()).getBS();
        return bs && Number(bs.date) === 1;
    } catch (err) {
        console.error('[billing-day] BS conversion failed:', err.message || err);
        return false;
    }
}

function monthKey() {
    try {
        const bs = new BillingDateConverter(new Date()).getBS();
        return `${bs.year}-${bs.month}`;
    } catch {
        return String(new Date().getFullYear() + '-' + (new Date().getMonth() + 1));
    }
}

// Called from /health (kept warm every 9 minutes). Only acts once per BS
// month, and never blocks the health check.
export function maybeFireBillingDayReminder() {
    if (running) return;
    if (!isBsMonthStart()) return;
    const key = monthKey();
    if (firedMonths.has(key)) return;

    running = true;
    (async () => {
        try {
            const bs = new BillingDateConverter(new Date()).getBS();
            const monthNames = ['Baishakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin', 'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'];
            const monthName = monthNames[(Number(bs.month) || 1) - 1] || 'Billing';
            const title = `📅 Billing day — ${monthName} ${bs.year}`;
            const body = 'Generate this month\'s bills for your tenants.';

            const notifs = await getNotifs();
            notifs.push({
                id: Date.now(),
                sender_id: 0,
                sender_name: 'SajiloRent',
                sender_role: 'system',
                target_role: 'owner',
                target_roles: ['owner'],
                house_id: null,
                title,
                message: body,
                priority: 'high',
                is_active: true,
                created_at: new Date().toISOString(),
                expires_at: null
            });
            await saveNotifs(notifs);

            const users = await getUsers();
            for (const u of users) {
                if (u.role !== 'owner' || u.deleted) continue;
                await sendToUser(u.id, { title, body, url: '/index.html' })
                    .catch(e => console.error('[billing-day] push:', e.message || e));
            }

            firedMonths.add(key);
            console.log(`[billing-day] ${title} — reminder sent to owners`);
        } catch (err) {
            console.error('[billing-day] reminder error:', err.message || err);
        } finally {
            running = false;
        }
    })();
}
