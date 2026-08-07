// ─── eSewa ePay v2 integration ────────────────────────────────
// ePay v2 flow: the client POSTs a signed hidden payment form to the
// eSewa gateway; the customer pays there; eSewa redirects back to our
// success/failure URLs with a base64-encoded `data` payload containing a
// signed JSON response. The callback is only trusted after (1) the HMAC
// signature on the payload verifies and (2) the transaction status lookup
// confirms status=COMPLETE with the exact amount.
//
// Sandbox (test mode, no real money):
//   - gateway base: https://rc-epay.esewa.com.np
//   - public test merchant: product_code = EPAYTEST, secret = 8gBm/:&EnhH.1/q
// Live payments require a registered eSewa merchant (product code + secret).

import { createHmac } from 'node:crypto';

const MODE = (process.env.ESEWA_MODE || 'sandbox').trim().toLowerCase();
export const ESEWA_GATEWAY = MODE === 'live'
    ? 'https://epay.esewa.com.np'
    : 'https://rc-epay.esewa.com.np';

export const ESEWA_SCD = (process.env.ESEWA_SCD || 'EPAYTEST').trim();
export const ESEWA_SECRET = (process.env.ESEWA_SECRET || '8gBm/:&EnhH.1/q').trim();

// Never silently sign live payments with the public sandbox secret.
if (MODE === 'live' && (!process.env.ESEWA_SECRET || !process.env.ESEWA_SCD)) {
    throw new Error('ESEWA_MODE=live requires ESEWA_SECRET and ESEWA_SCD to be set. Refusing to start with sandbox credentials.');
}

// ─── Tiered per-tenant pricing (NPR) — must mirror the landing page ───
// [minTenants, ratePerTenantPerMonth]
const TIERS = {
    self: [
        [1, 100], [2, 90], [4, 80], [7, 70], [11, 60], [16, 55]
    ],
    full: [
        [1, 250], [2, 225], [4, 200], [7, 175], [11, 150], [16, 140]
    ]
};

function rateFor(svc, tenantCount) {
    const tiers = TIERS[svc];
    let rate = tiers[0][1];
    for (const [min, r] of tiers) {
        if (tenantCount >= min) rate = r;
    }
    return rate;
}

export const MONTHS_BILLED = { monthly: 1, yearly: 10 }; // yearly = 2 months free

export function computeAmount({ plan, cycle, tenants }) {
    const rate = rateFor(plan, tenants);
    const months = MONTHS_BILLED[cycle] || 1;
    return { amt: rate * tenants * months, rate, months };
}

// base64 HMAC-SHA256 of `message` using the merchant secret.
export function hmacSha256Base64(secret, message) {
    return createHmac('sha256', secret).update(message).digest('base64');
}

// Payment URL the browser form should POST to.
export function paymentEndpoint() {
    return `${ESEWA_GATEWAY}/api/epay/main/v2/form`;
}

// Build the hidden-form params for the gateway (ePay v2).
export function paymentForm({ pid, amt }) {
    const total = String(amt);
    const base = process.env.BASE_URL || 'https://sajilorent.onrender.com';
    // The `pid` query param gives the callbacks a way to match the payment
    // even when eSewa omits the signed `data` payload (e.g. user cancels).
    const successUrl = `${base}/api/subscription/esewa/success?pid=${encodeURIComponent(pid)}`;
    const failureUrl = `${base}/api/subscription/esewa/failure?pid=${encodeURIComponent(pid)}`;
    const signature = hmacSha256Base64(ESEWA_SECRET,
        `total_amount=${total},transaction_uuid=${pid},product_code=${ESEWA_SCD}`);
    return {
        amount: total,
        tax_amount: '0',
        total_amount: total,
        transaction_uuid: pid,
        product_code: ESEWA_SCD,
        product_service_charge: '0',
        product_delivery_charge: '0',
        success_url: successUrl,
        failure_url: failureUrl,
        signed_field_names: 'total_amount,transaction_uuid,product_code',
        signature
    };
}

// Decode + verify the base64 `data` payload eSewa appends to our success/
// failure URLs. Returns the parsed object when the signature is valid,
// otherwise null (never trust an unverifiable callback).
export function verifyResponseData(dataParam) {
    if (!dataParam) return null;
    let raw;
    try {
        raw = Buffer.from(dataParam, 'base64').toString('utf8');
    } catch {
        return null;
    }
    let obj;
    try {
        obj = JSON.parse(raw);
    } catch {
        return null;
    }
    const fields = obj.signed_field_names;
    if (!fields || typeof fields !== 'string' || !obj.signature) return null;
    const names = fields.split(',');
    if (!names.every(f => Object.prototype.hasOwnProperty.call(obj, f))) return null;
    const message = names.map(f => String(obj[f])).join(',');
    const expected = hmacSha256Base64(ESEWA_SECRET, message);
    if (expected !== obj.signature) return null;
    return obj;
}

// Server-to-server status lookup for a transaction.
// Returns { status, total_amount, ref_id, ... } or null on failure.
export async function checkTransactionStatus({ transaction_uuid, total_amount }) {
    if (!transaction_uuid) return null;
    const url = `${ESEWA_GATEWAY}/api/epay/transaction/status/?product_code=${encodeURIComponent(ESEWA_SCD)}&transaction_uuid=${encodeURIComponent(transaction_uuid)}&total_amount=${encodeURIComponent(String(total_amount))}`;
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) return null;
        const j = await r.json();
        return j && typeof j === 'object' ? j : null;
    } catch (err) {
        console.error('eSewa status lookup error:', err.message);
        return null;
    }
}
