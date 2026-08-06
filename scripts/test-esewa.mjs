// E2E test for eSewa ePay v2 checkout + callback plumbing (local, sandbox API).
// Usage: PORT to run server on default 4001. Sandbox merchant EPAYTEST/8gBm/:&EnhH.1/q.
// Covers: checkout shape + signature math, signed-callback acceptance path
// (signature valid, but no real transaction -> status lookup NOT_FOUND -> rejected),
// garbage-callback rejection, failure callback, payment state.
import 'dotenv/config';
import { createHmac } from 'node:crypto';

const BASE = 'http://localhost:' + (process.env.TEST_PORT || 4001);
const SECRET = '8gBm/:&EnhH.1/q';
let pid = null;
let token = null;

async function j(res) {
    const t = await res.text();
    try { return { status: res.status, body: JSON.parse(t) }; }
    catch { return { status: res.status, body: t }; }
}
function sign(message) { return createHmac('sha256', SECRET).update(message).digest('base64'); }

// Build a base64 `data` payload exactly like eSewa does on redirect
function fakeEsewaData({ transaction_uuid, total_amount, status = 'COMPLETE', transaction_code = '000TEST' }) {
    const obj = {
        transaction_code,
        status,
        total_amount: total_amount + '.0',
        transaction_uuid,
        product_code: 'EPAYTEST',
        signed_field_names: 'transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names'
    };
    const message = obj.signed_field_names.split(',').map(f => String(obj[f])).join(',');
    obj.signature = sign(message);
    return Buffer.from(JSON.stringify(obj)).toString('base64');
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

// 2. create checkout -> v2 params
{
    const r = await j(await fetch(BASE + '/api/subscription/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ plan: 'self', cycle: 'yearly', tenants: 5 })
    }));
    console.log('checkout:', r.status);
    const params = r.body.params;
    if (!params || !params.transaction_uuid || !params.signature || !params.total_amount) {
        console.log('ABORT: missing v2 fields', JSON.stringify(params)); process.exit(1);
    }
    pid = params.transaction_uuid;
    const expAmt = 10 * 5 * 80; // yearly: 10 months x 5 tenants @ Rs 80 (5>=4)
    console.log('amount math OK (expect 4000):', params.amount === String(expAmt) && params.total_amount === String(expAmt), 'got', params.total_amount);
    const expSig = sign(`total_amount=${expAmt},transaction_uuid=${pid},product_code=EPAYTEST`);
    console.log('request signature OK:', params.signature === expSig);
    console.log('signed_field_names OK:', params.signed_field_names === 'total_amount,transaction_uuid,product_code');
    if (String(params.total_amount) !== String(expAmt) || params.signature !== expSig) { console.log('ABORT: bad checkout'); process.exit(1); }
}

// 3. success callback with a VALID signed payload but NO real transaction
//    -> signature verifies, status lookup returns NOT_FOUND -> must fail
{
    const data = fakeEsewaData({ transaction_uuid: pid, total_amount: 4000 });
    const r = await j(await fetch(BASE + `/api/subscription/esewa/success?data=${encodeURIComponent(data)}`, { redirect: 'manual' }));
    console.log('valid-sig/nonexistent-tx callback:', r.status, '->', String(r.body).includes('status=failed') ? 'rejected' : 'ACCEPTED');
    if (r.status !== 302 || !String(r.body).includes('status=failed')) { console.log('ABORT: NOT rejected'); process.exit(1); }
}

// 4. garbage / tampered callback -> signature mismatch -> must fail
{
    const r = await j(await fetch(BASE + `/api/subscription/esewa/success?data=${encodeURIComponent('bm90IGpzb24=')}`, { redirect: 'manual' }));
    console.log('garbage callback:', r.status, '->', String(r.body).includes('status=failed') ? 'rejected' : 'ACCEPTED');
    if (r.status !== 302 || !String(r.body).includes('status=failed')) { console.log('ABORT: garbage NOT rejected'); process.exit(1); }
}

// 5. payment state: row exists and was marked failed (no phantom paid)
{
    const lr = await j(await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Super_Admin', password: 'Kali_5545' })
    }));
    const r = await j(await fetch(BASE + '/api/subscription/payments', { headers: { 'Authorization': 'Bearer ' + lr.body.token } }));
    const rows = (r.body || []).filter(p => p.pid === pid);
    console.log('payment row:', JSON.stringify(rows));
    if (!rows.length || rows[0].status !== 'failed') { console.log('ABORT: payment not failed'); process.exit(1); }
}

// 6. failure callback with a valid signed payload -> marks failed + redirect
{
    const data = fakeEsewaData({ transaction_uuid: pid, total_amount: 4000, status: 'CANCEL' });
    const r = await j(await fetch(BASE + `/api/subscription/esewa/failure?data=${encodeURIComponent(data)}`, { redirect: 'manual' }));
    console.log('failure callback:', r.status, '->', String(r.body).includes('status=failed') ? 'redirected' : '?');
    if (r.status !== 302) { console.log('ABORT: failure callback not redirect'); process.exit(1); }
}

// 7. cleanup test rows
{
    const users = await j(await fetch(BASE + '/api/admin/users', { headers: { 'Authorization': 'Bearer ' + token } }));
    console.log('cleanup: remove payment rows with pid', pid);
    const { getPayments, savePayments, getUpgradeRequests, saveUpgradeRequests } = await import('../server/db.js');
    await savePayments((await getPayments()).filter(p => p.pid !== pid));
    await saveUpgradeRequests((await getUpgradeRequests()).filter(r => r.pid !== pid));
    console.log('cleanup done');
}

console.log('ALL CHECKS DONE - pid was', pid);
process.exit(0);
