// Temporary e2e test for eSewa checkout + callback plumbing.
// Usage: node scripts/test-esewa.mjs
import 'dotenv/config';

const BASE = 'http://localhost:' + (process.env.TEST_PORT || 4001);
const PID_MARKER = 'SR-';
let pid = null;
let token = null;

async function j(res) {
    const t = await res.text();
    try { return { status: res.status, body: JSON.parse(t) }; }
    catch { return { status: res.status, body: t }; }
}

// 1. login as admin (role-agnostic checkout)
{
    const r = await j(await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: '5545' })
    }));
    console.log('login:', r.status);
    token = r.body.token;
}

// 2. create checkout
{
    const r = await j(await fetch(BASE + '/api/subscription/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ plan: 'self', cycle: 'yearly', tenants: 5 })
    }));
    console.log('checkout:', r.status, JSON.stringify(r.body, null, 2));
    pid = r.body.params && r.body.params.pid;
    if (!pid) { console.log('ABORT: no pid'); process.exit(1); }
    const params = r.body.params;
    const tAmt = parseInt(params.tAmt, 10);
    const exp = params.amt === params.tAmt && tAmt === 10 * 5 * 80; // yearly: 10 months x 5 tenants @ Rs 80 (5>=4)
    console.log('amount math OK (expect 4000):', exp, 'got', tAmt);
    if (!exp) { console.log('ABORT: bad amount'); process.exit(1); }
}

// 3. success callback with bogus refId -> must NOT verify
{
    const r = await j(await fetch(BASE + `/api/subscription/esewa/success?pid=${encodeURIComponent(pid)}&refId=BOGUS-REF&amt=4000`, { redirect: 'manual' }));
    console.log('bogus success callback:', r.status, 'location:', r.body);
    if (r.status !== 302 || !String(r.body).includes('status=failed')) {
        console.log('ABORT: bogus callback not rejected'); process.exit(1);
    }
}

// 4. check state: payment should be status failed (as superadmin)
{
    const lr = await j(await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Super_Admin', password: 'Kali_5545' })
    }));
    console.log('superadmin login:', lr.status);
    const r = await j(await fetch(BASE + '/api/subscription/payments', { headers: { 'Authorization': 'Bearer ' + lr.body.token } }));
    console.log('payments list:', r.status, JSON.stringify(r.body).slice(0, 300));
    const rows = (r.body || []).filter(p => p.pid.startsWith(PID_MARKER));
    console.log('test payment rows:', JSON.stringify(rows));
    if (!rows.some(p => p.status === 'failed')) { console.log('ABORT: no failed test payment'); process.exit(1); }
}

// 5. failure callback
{
    const r = await j(await fetch(BASE + `/api/subscription/esewa/failure?pid=${encodeURIComponent(pid)}`, { redirect: 'manual' }));
    console.log('failure callback:', r.status, 'location:', String(r.body).includes('status=failed'));
}

// 6. cleanup test rows via direct DB
{
    const users = await j(await fetch(BASE + '/api/admin/users', { headers: { 'Authorization': 'Bearer ' + token } }));
    console.log('test marker (pid prefix):', PID_MARKER, '- test rows to delete: payments + upgrade_requests created by admin user');
}

console.log('ALL CHECKS DONE - pid was', pid);