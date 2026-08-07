# SajiloRent — House Billing & Property Management

Simple monthly billing, notices and payment tracking for houses, tenants and owners. Nepali-market focused, priced per tenant.

**Live:** https://sajilorent.onrender.com

## Features

- Tenants, owners, houses & notices per property
- Monthly bill generation & download
- Payment tracking (paid / unpaid / advance)
- Daily & monthly history per house
- Roles: SuperAdmin, Admin, Owner, Tenant
- Web + Android (Capacitor) + Windows (Electron)
- Per-tenant subscription pricing with volume discounts
- eSewa EPay payments: in-app checkout → eSewa gateway → server-verified callback auto-upgrades the account (sandbox test merchant by default)

## Tech stack

- Node.js + Express (`server/`)
- PostgreSQL on Neon (`DATABASE_URL`) with automatic JSON-file fallback (see `server/db.js`)
- bcrypt + JWT auth (`server/auth.js`)
- Capacitor 8 Android wrapper (`android/`)
- Electron desktop wrapper (`desktop/`)
- Sharp for generated icons/OG images (`scripts/`)

## Local setup

```bash
npm install
cp .env.example .env   # set DATABASE_URL (optional) and JWT_SECRET
npm run dev            # http://localhost:3000
```

Without `DATABASE_URL` the app runs on JSON files under `data/` — no DB needed.

## eSewa payments

The subscription tab ("Upgrade Plan") opens a checkout: choose plan, billing cycle and tenant count, then pay with eSewa. The owner is redirected to the gateway; the callback is verified server-side (`server/esewa.js` + `/api/subscription/esewa/success`) before the account flips to `paid` and the payment/request records are stored in Postgres (also included in backups).

- Sandbox is default: `ESEWA_MODE=sandbox`, test merchant `EPAYTEST`. No real money moves.
- For live payments register as an eSewa merchant, then in the platform env set `ESEWA_MODE=live`, `ESEWA_SCD` and `ESEWA_SECRET` (see `.env.example`). `su`/`fu` callbacks use `BASE_URL` (falls back to the Render URL).
- Manual fallback: owners without eSewa can still send a request that a SuperAdmin approves.

## Backups

```bash
npm run backup        # dumps Postgres (or JSON store) to backups/, keeps last 14
```

## Android build (release-signed)

Prereqs: JDK 21 (bundle JBR works; Android Studio's newer bundled Java may fail Gradle).

```bash
cd android
$env:JAVA_HOME = "C:\Users\shahd\.jdks\jbr-21.0.11"   # Windows example
./gradlew.bat assembleRelease
# APK: android/app/build/outputs/apk/release/app-release.apk
```

The release keystore lives at `android/keystore/` (gitignored — **back it up**, it cannot be recreated). The signed APK is copied to `public/downloads/SajiloRent-v1.0.apk` and served to app users; the landing-page install widget links to it directly.

## Desktop build (Windows)

```bash
cd desktop
npm install
npx electron-builder --win portable --config.directories.output=dist4
```

Output: `SajiloRent-windows-v1.0.0.exe`, published to GitHub releases (`v1.0.0`) and linked from the install widget.

## Deployment

Render auto-deploys from `main`. Free tier spins down on idle (~50s cold start) — the service worker (`public/sw.js`) serves a cached landing page instantly and a branded splash covers the wake-up wait.

**Keep-warm (why it may sleep):** a GitHub Actions workflow
(`.github/workflows/keep-warm.yml`) pings `https://sajilorent.onrender.com/health`
every 9 minutes and `workflow_dispatch` allows a manual trigger. It's free &
unlimited on this public repo and never auto-pauses, unlike an external cron. If
the server is still found sleeping, check the workflow's **Actions** tab for
failures, or that a deploy didn't drop the `/health` route. (An older
cron-job.org setup is documented as backup only — it auto-paused after ~30 days
without login, which is what originally let the server sleep.)

The `/health` route returns `ok` with no DB/file I/O so the pinger is cheap even
on cold start.

## Project layout

```
server/    Express API, auth, Postgres/JSON storage
public/    Web app (landing page, dashboards, install widget)
android/   Capacitor wrapper (debug + release builds)
desktop/   Electron wrapper (portable EXE)
scripts/   Icon/OG image generators, Postgres import, backup
data/      JSON fallback storage (gitignored contents)
backups/   Timestamped dumps (gitignored)
```

## Scripts

| Command                 | Purpose                                   |
|-------------------------|-------------------------------------------|
| `npm start`             | Run server                                |
| `npm run dev`           | Run with nodemon                          |
| `npm run backup`        | Dump DB to backups/                       |
| `npm run import:pg`     | Migrate legacy JSON data to Postgres      |
| `node scripts/make-og-image.mjs` | Regenerate social share card      |
| `node scripts/make-icons.mjs`    | Regenerate Android launcher icons  |
