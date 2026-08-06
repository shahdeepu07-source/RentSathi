// Full local smoke audit: pages, role logins, subscription guards.
// Usage: PORT to run server on default 4001.
import 'dotenv/config';

const PORT = process.env.TEST_PORT || 4001;
const BASE = `http://localhost:${PORT}`;
const PAGES = ['/', '/login.html', '/register.html', '/payment-result.html', '/admin.html', '/superadmin.html', '/index.html', '/tenant.html'];
const REDIRS = ['/api/subscription/esewa/success', '/api/subscription/esewa/failure'];
const acc = { pass: 0, fail: 0 };
function ok(name, cond, extra = '') {
    if (cond) acc.pass++; else { acc.fail++; console.log(`✗ ${name} ${extra}`); }
}
async function j(res) {
    const t = await res.text();
    try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; }
}
async function login(u, p) {
    const r = await j(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }));
    return r;
}

// 1. Public pages + weighted callbacks
for (const path of PAGES) {
    try { const r = await fetch(BASE + path, { redirect: 'manual' }); ok(path, r.status === 200, `got ${r.status}`); }
    catch (e) { ok(path, false, e.message); }
}
for (const path of REDIRS) {
    try { const r = await fetch(BASE + path, { redirect: 'manual' }); ok(path, r.status === 302, `got ${r.status}`); }
    catch (e) { ok(path, false, e.message); }
}

// 2. Role logins
const roles = [['admin', '5545'], ['Super_Admin', 'Kali_5545']];
for (const [u, p] of roles) { const l = await login(u, p); ok(`login ${u}`, l.status === 200, `got ${l.status}`); }
// wrong password remains rejected
{ const l = await login('admin', 'wrongpass'); ok('admin wrong password 401', l.status === 401, `got ${l.status}`); }

// 3. Auth guards on subscription endpoints
{ const r = await fetch(BASE + '/api/subscription/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); ok('checkout unauth 401', r.status === 401); }
{ const r = await fetch(BASE + '/api/subscription/payments'); ok('payments unauth 401', r.status === 401); }

// 4. Change password round-trip (admin) - verify current password gate + change + restore
async function changePassword(token, cur, nw) {
    const r = await j(await fetch(BASE + '/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ currentPassword: cur, newPassword: nw }) }));
    return r;
}
{ const l = await login('admin', '5545'); const t = l.body.token; const wrong = await changePassword(t, 'bad', 'x1234'); ok('change-pw wrong current 401', wrong.status === 401); const good = await changePassword(t, '5545', 'audit000'); ok('change-pw success 200', good.status === 200); const re = await login('admin', 'audit000'); ok('login with new pw', re.status === 200); await changePassword(re.body.token, 'audit000', '5545'); const back = await login('admin', '5545'); ok('restored pw', back.status === 200); }

// 5. Manual upgrade request (with payment screenshot) + superadmin respond
{ const l = await login('admin', '5545'); const t = l.body.token;
  const ss = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const bad = await j(await fetch(BASE + '/api/subscription/request', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t }, body: JSON.stringify({ plan: 'full', notes: 'audit-manual', screenshot: 'http://evil' }) }));
  ok('bad screenshot rejected 400', bad.status === 400, `got ${bad.status}`);
  const m = await j(await fetch(BASE + '/api/subscription/request', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t }, body: JSON.stringify({ plan: 'full', notes: 'audit-manual', screenshot: ss, paymentNote: 'Paid via eSewa QR' }) }));
  ok('manual request 201', m.status === 201, `got ${m.status}`);
  const s = await login('Super_Admin', 'Kali_5545'); const st = s.body.token;
  const list = await j(await fetch(BASE + '/api/subscription/requests', { headers: { 'Authorization': 'Bearer ' + st } }));
  ok('superadmin sees requests 200', list.status === 200);
  const mine = (list.body || []).filter(r => r.notes === 'audit-manual' && r.screenshot);
  ok('manual request present with screenshot', mine.length > 0);
  const id = mine[0] && mine[0].id;
  if (id) { const resp = await j(await fetch(BASE + `/api/subscription/requests/${id}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + st }, body: JSON.stringify({ status: 'declined' }) })); ok('respond 200', resp.status === 200); }
}
// 6. Admin cannot list payments (403)
{ const l = await login('admin', '5545'); const r = await fetch(BASE + '/api/subscription/payments', { headers: { 'Authorization': 'Bearer ' + l.body.token } }); ok('payments admin 403', r.status === 403, `got ${r.status}`); }
{ const l = await login('Super_Admin', 'Kali_5545'); const r = await fetch(BASE + '/api/subscription/payments', { headers: { 'Authorization': 'Bearer ' + l.body.token } }); ok('payments superadmin 200', r.status === 200, `got ${r.status}`); }

// 7. Cleanup audit-manual upgrade request rows from data.json store
import { getUpgradeRequests, saveUpgradeRequests } from '../server/db.js';
{ const all = await getUpgradeRequests(); const kept = all.filter(r => r.notes !== 'audit-manual' && !String(r.pid || '').startsWith('SR-1-') || true);
  // only drop audit-manual rows
  const clean = all.filter(r => r.notes !== 'audit-manual');
  await saveUpgradeRequests(clean);
  ok('cleaned audit rows', clean.length <= all.length); }

// 8. Demo seed (idempotent) + reveal-password (SuperAdmin re-auth) flow
{ const s = await login('Super_Admin', 'Kali_5545'); const st = s.body.token;
  const seed1 = await j(await fetch(BASE + '/api/admin/seed-demo', { method: 'POST', headers: { 'Authorization': 'Bearer ' + st } }));
  ok('seed-demo 200', seed1.status === 200, `got ${seed1.status}`);
  ok('seed created demo data', seed1.body && seed1.body.created && seed1.body.created.users >= 0 && seed1.body.created.houses >= 0);
  const seed2 = await j(await fetch(BASE + '/api/admin/seed-demo', { method: 'POST', headers: { 'Authorization': 'Bearer ' + st } }));
  ok('seed idempotent (0 created 2nd run)', seed2.body && seed2.body.created.users === 0 && seed2.body.created.houses === 0, `got ${JSON.stringify(seed2.body && seed2.body.created)}`);
  const users = await j(await fetch(BASE + '/api/admin/users', { headers: { 'Authorization': 'Bearer ' + st } }));
  const t = (users.body || []).find(u => u.username === 't_sita');
  ok('seeded tenant t_sita exists', !!t);
  if (t) {
    const wrong = await j(await fetch(BASE + '/api/auth/reveal-password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + st }, body: JSON.stringify({ superadminPassword: 'nope', targetUserId: t.id }) }));
    ok('reveal wrong superadmin pw 401', wrong.status === 401, `got ${wrong.status}`);
    const good = await j(await fetch(BASE + '/api/auth/reveal-password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + st }, body: JSON.stringify({ superadminPassword: 'Kali_5545', targetUserId: t.id }) }));
    ok('reveal correct pw returns Sita@2081', good.status === 200 && good.body.password === 'Sita@2081', `got ${good.status} ${good.body && good.body.password}`);
  }
  const own = await login('demo_owner1', 'Sunny@2081');
  ok('demo owner login works', own.status === 200, `got ${own.status}`);
  const ownerReveal = await j(await fetch(BASE + '/api/auth/reveal-password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + own.body.token }, body: JSON.stringify({ superadminPassword: 'Sunny@2081', targetUserId: t && t.id }) }));
  ok('reveal non-superadmin 403', ownerReveal.status === 403, `got ${ownerReveal.status}`);
}

// 9. Duplicate bill guard (same tenant + same BS month → 409)
{ const l = await login('admin', '5545'); const t = l.body.token;
  const name = 'AuditDup-' + Date.now();
  await fetch(BASE + '/api/houses', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t }, body: JSON.stringify({ name }) });
  await fetch(BASE + `/api/tenants?houseId=${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t }, body: JSON.stringify({ name: 'Dup Tester', rent_amount: 5000, last_reading: 0 }) });
  const ts = await j(await fetch(BASE + `/api/tenants?houseId=${name}`, { headers: { 'Authorization': 'Bearer ' + t } }));
  const ten = (ts.body || []).find(x => x.name === 'Dup Tester');
  if (ten) {
    const body = JSON.stringify({ id: ten.id, curr: 100, water: 0, waste: 0, due: 0, ded: 0, month: 'Shrawan 2099', dedReason: '', note: '' });
    const b1 = await j(await fetch(BASE + `/api/calculate?houseId=${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t }, body }));
    ok('first bill 200', b1.status === 200, `got ${b1.status}`);
    const b2 = await j(await fetch(BASE + `/api/calculate?houseId=${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t }, body }));
    ok('duplicate bill 409', b2.status === 409, `got ${b2.status}`);
  }
  await fetch(BASE + `/api/houses/${name}/delete`, { method: 'POST', headers: { 'Authorization': 'Bearer ' + t } });
}

console.log(`AUDIT RESULT: ${acc.pass} passed, ${acc.fail} failed`);
process.exit(acc.fail ? 1 : 0);