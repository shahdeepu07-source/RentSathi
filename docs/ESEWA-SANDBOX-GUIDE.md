# eSewa Sandbox Walkthrough (no PAN needed)

SajiloRent is wired to the **eSewa test gateway** (`uat.esewa.com.np`). The test
merchant is already built in, so you can run the *entire* buy-a-subscription
flow today with **no real money and no company documents** (no PAN, no
registration, no bank account).

- Test merchant ID: `EPAYTEST`
- Test secret: `8gBm/:&EnhH.1/q`

You only need PAN/company docs later, **when** you want real money to reach you
(see "Going live" at the end).

---

## 1. What happens to the money? Nothing.

Every payment in sandbox mode is simulated. The eSewa sandbox shows you its
test payment page; you pick any test "wallet"/"bank", pretend to pay, and
eSewa calls back into SajiloRent to confirm. No real charge, no settlement.

## 2. Sandbox configuration (already done)

| Setting       | Value                       | Where                 |
|---------------|-----------------------------|-----------------------|
| `ESEWA_MODE`  | `sandbox` (default)         | `.env` (local) / Render env |
| `ESEWA_SCD`   | `EPAYTEST` (default fallback)| `server/esewa.js`     |
| `ESEWA_SECRET`| `8gBm/:&EnhH.1/q` (default) | `server/esewa.js`     |

The default values in `server/esewa.js` are used unless your `.env` overrides
them — so the app works even on a fresh checkout with no env vars.

## 3. What happens in the code (one page right after another)

1. Owner dashboard → "Upgrade Plan" → pick plan, cycle, tenants → the modal
   shows the tiered price (see `computeAmount`: self/full, monthly/1mo,
   yearly/10mo) → **Pay with eSewa**.
2. `POST /api/subscription/checkout` (`server/index.js:998`) creates:
   - a **payment record** (status `pending`) in the payments store, and
   - an **upgrade request** (`pending_payment`, `via: 'esewa'`).
   It responds `{ url, params }` where `url` is the gateway endpoint and
   `params` are the signed form fields (`amt`, `tAmt`, `pid`, `scd`, `su`, `fu`).
3. The browser POSTs that hidden form to `https://uat.esewa.com.np/epay/main`
   (`server/esewa.js` `paymentEndpoint`). eSewa opens its test checkout.
4. eSewa redirects to our public callback
   - success: `/api/subscription/esewa/success?refId=..&pid=..&amt=..`
   - failure: `/api/subscription/esewa/failure?pid=..`
5. On success, the server verifies against eSewa's
   `https://uat.esewa.com.np/epay/transrec` (`verifyTransaction`) to confirm
   the exact `pid + refId + amount` settled — a forged callback is rejected.
6. Verified → invoice marked `paid`, upgrade request approved, the owner's
   `subscription_status` flips to `paid` with plan/cycle/tenants saved, and the
   browser lands on `payment-result.html?status=success`.

## 4. Try it now (5-minute demo)

1. Open `https://sajilorent.onrender.com/login.html` (or install the APK/EXE).
2. Log in as an owner on trial, or register a brand-new owner account.
3. Open the **Upgrade Plan** box and pick e.g. Self-service, Monthly, 1 tenant
   (should show Rs 100).
4. Click **Pay with eSewa**.
5. On the eSewa test page, pick "Test ..." credentials if it asks, or just
   complete with any test payment — it will look like a real wallet.
6. eSewa redirects back → you should see the green **payment successful** page.
7. As SuperAdmin, open **Revenue & Invoices**: the invoice shows
   `SR-<userid>-<ts>`, plan, cycle, amount, `paid`, and the eSewa ref ID.

To see the failure branch, just click **Cancel/Back** on the eSewa page — the
invoice is marked `failed` and the owner stays expired (still blocked from
actions until they pay).

## 5. How an owner is unblocked in sandbox on a real browser

Two paths, both supported:

- **Automatic**: eSewa success callback flips status to `paid` instantly.
- **Manual**: if a payment is approved offline, SuperAdmin → Users →
  manage subscription → **Activate** sets status `active`.

An owner with status `expired` can still log in but every write action shows
the "Your subscription has ended" popup until status is back to `active` or
`paid`.

## 6. Going live (later, needs PAN)

| Requirement            | Minimum needed                              | Time   |
|------------------------|---------------------------------------------|--------|
| Sole-proprietor PAN    | Citizenship copy + PAN from IRD Nepal (free) | 1-2 days |
| eSewa merchant account | Apply at `pay.esewa.com.np` with PAN       | ~1-2 weeks |
| Bank account           | Either sole-proprietor or company account   | 1-3 days |

Then flip to live:

```
ESEWA_MODE=live
ESEWA_SCD=<your merchant code>
ESEWA_SECRET=<your secret>
BASE_URL=https://sajilorent.onrender.com
```

Test on live with a small amount first, and keep the sandbox defaults in
`server/esewa.js` as a fallback until you verify one real payment.

---

No PAN? No problem — everything in this doc until "Going live" requires only
the test merchant. Start the demo today; register a PAN whenever the business
is ready.