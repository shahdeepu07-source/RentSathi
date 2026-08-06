# eSewa Sandbox Walkthrough (no PAN needed)

> **Status note (current):** the eSewa sandbox's Google reCAPTCHA quota is
> exhausted ("This site is exceeding reCAPTCHA Enterprise free quota"), so the
> sandbox login page cannot complete payments right now. The **Pay with eSewa**
> button in the app is therefore stubbed as *"eSewa — update coming soon"* and
> the live demo path is the **QR + screenshot manual flow** below. The eSewa v2
> integration code remains fully wired and tested; re-enable the button
> (`upg-pay` in `public/index.html`) when the sandbox recovers or for live mode.

SajiloRent is wired to the **eSewa ePay v2 test gateway**
(`rc-epay.esewa.com.np`). The test merchant is already built in, so you can
run the *entire* buy-a-subscription flow today with **no real money and no
company documents** (no PAN, no registration, no bank account).

- Test merchant ID (`product_code`): `EPAYTEST`
- Test secret: `8gBm/:&EnhH.1/q`
- Test OTP on the sandbox checkout: `123456`

You only need PAN/company docs later, **when** you want real money to reach you
(see "Going live" at the end).

---

## 0. Current live path: QR + screenshot manual payment

1. Owner dashboard → Upgrade Plan → pick plan/cycle/tenants → **Pay by eSewa QR →**.
2. The owner's personal eSewa QR (`public/assets/esewa-qr.png` — replace it
   with your real QR screenshot; edit the eSewa ID text in `index.html` if
   needed) plus the exact amount is shown.
3. The owner pays via the eSewa app, attaches a screenshot (SS) of their
   payment history, and sends the request.
4. SuperAdmin → upgrade requests → sees the thumbnail (click to zoom), notes
   and amount → **Approve** → owner activated, `MAN-<id>` invoice recorded.

## 1. What happens to the money? Nothing.

Every payment in sandbox mode is simulated. The eSewa sandbox shows you its
test payment page; you log in with any test credential (OTP `123456`),
pretend to pay, and eSewa calls back into SajiloRent to confirm. No real
charge, no settlement.

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
2. `POST /api/subscription/checkout` (`server/index.js`) creates:
   - a **payment record** (status `pending`, `pid` = `SR-<userid>-<ts>`) in
     the payments store, and
   - an **upgrade request** (`pending_payment`, `via: 'esewa'`).
   It responds `{ url, params }` where `url` is the v2 form endpoint
   (`https://rc-epay.esewa.com.np/api/epay/main/v2/form`) and `params` are the
   signed fields: `amount`, `tax_amount`, `total_amount`, `transaction_uuid`
   (our `pid`), `product_code`, `product_service_charge`,
   `product_delivery_charge`, `success_url`, `failure_url`,
   `signed_field_names` = `total_amount,transaction_uuid,product_code`, and
   `signature` = base64(HMAC-SHA256(secret,
   `total_amount=..,transaction_uuid=..,product_code=..`)).
3. The browser POSTs that hidden form to the gateway
   (`server/esewa.js` `paymentEndpoint`). eSewa opens its test checkout and
   redirects back to our public callbacks with a base64 `data` payload:
   - success: `/api/subscription/esewa/success?data=<base64 JSON>`
   - failure: `/api/subscription/esewa/failure?data=<base64 JSON>`
4. On success the server:
   - decodes `data` and verifies the payload `signature` (HMAC-SHA256 over
     the values of `signed_field_names` in order) — a forged callback is
     rejected,
   - matches `transaction_uuid` to the payment and `total_amount` to the
     invoice,
   - confirms with eSewa's status lookup
     `https://rc-epay.esewa.com.np/api/epay/transaction/status/?product_code=..&transaction_uuid=..&total_amount=..`
     that status is `COMPLETE` with the exact amount.
5. Verified → invoice marked `paid` (with `refId` = `transaction_code`), the
   upgrade request is approved, the owner's `subscription_status` flips to
   `paid` with plan/cycle/tenants saved, and the browser lands on
   `payment-result.html?status=success`.

## 4. Try it now (5-minute demo)

1. Open `https://sajilorent.onrender.com/login.html` (or install the APK/EXE).
2. Log in as an owner on trial, or register a brand-new owner account.
3. Open the **Upgrade Plan** box and pick e.g. Self-service, Monthly, 1 tenant
   (should show Rs 100).
4. Click **Pay with eSewa**.
5. On the eSewa test page, log in with the sandbox test credential (OTP
   `123456`) and complete the payment — it will look like a real wallet.
6. eSewa redirects back → you should see the green **payment successful** page.
7. As SuperAdmin, open **Revenue & Invoices**: the invoice shows
   `SR-<userid>-<ts>`, plan, cycle, amount, `paid`, and the eSewa ref ID.

To see the failure branch, just click **Cancel/Back** on the eSewa page — the
invoice is marked `failed` and the owner stays expired (still blocked from
actions until they pay).

## 5. How an owner is unblocked in sandbox on a real browser

Two paths, both supported:

- **Automatic**: eSewa success callback flips status to `paid` instantly.
- **Manual**: SuperAdmin approves the offline/manual upgrade request — the
  owner is activated and a `MAN-<reqid>` invoice is recorded.

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