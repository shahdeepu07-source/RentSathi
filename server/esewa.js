// ─── eSewa EPay v1 integration ────────────────────────────────
// Classic EPay flow: the client POSTs a hidden payment form to the eSewa
// gateway, the customer pays there, and eSewa redirects back to our
// success/failure URLs. The callback is only trusted after being verified
// server-side against the transaction lookup endpoint (transrec) using the
// merchant key (secret), so a forged callback cannot confirm a payment.
//
// Sandbox (test mode, no real money):
//   - gateway base: https://uat.esewa.com.np
//   - public test merchant: scd = EPAYTEST, secret = 8gBm/:&EnhH.1/q
// Live payments require a registered eSewa merchant (scd + secret).

const MODE = (process.env.ESEWA_MODE || 'sandbox').trim().toLowerCase();
export const ESEWA_GATEWAY = MODE === 'live'
    ? 'https://esewa.com.np'
    : 'https://uat.esewa.com.np';

export const ESEWA_SCD = (process.env.ESEWA_SCD || 'EPAYTEST').trim();
export const ESEWA_SECRET = (process.env.ESEWA_SECRET || '8gBm/:&EnhH.1/q').trim();

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

// Payment URL the browser form should POST to.
export function paymentEndpoint() {
    return `${ESEWA_GATEWAY}/epay/main`;
}

// Build the hidden-form params for the gateway.
export function paymentForm({ pid, amt }) {
    return {
        amt: String(amt),
        psc: '0',
        pdc: '0',
        txAmt: '0',
        tAmt: String(amt),
        pid,
        scd: ESEWA_SCD,
        su: `${process.env.BASE_URL || 'https://sajilorent.onrender.com'}/api/subscription/esewa/success`,
        fu: `${process.env.BASE_URL || 'https://sajilorent.onrender.com'}/api/subscription/esewa/failure`
    };
}

// Verify a completed payment with eSewa. Returns true only when eSewa
// confirms the exact amount was settled for this pid+refId.
export async function verifyTransaction({ pid, refId, amt }) {
    if (!pid || !refId || !amt) return false;
    const url = `${ESEWA_GATEWAY}/epay/transrec?amt=${encodeURIComponent(amt)}&scd=${encodeURIComponent(ESEWA_SCD)}&pid=${encodeURIComponent(pid)}&rid=${encodeURIComponent(refId)}`;
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const text = await r.text();
        const body = text.trim();
        // eSewa responds with plain text ("Success"/"Failure"/etc.) or JSON.
        if (body.includes('Success')) return true;
        try {
            const j = JSON.parse(body);
            return j?.response_code === 0 || j?.response_code === '0' || String(j?.status || '').toLowerCase() === 'success';
        } catch { /* not JSON */ }
        return false;
    } catch (err) {
        console.error('eSewa verification error:', err.message);
        return false;
    }
}