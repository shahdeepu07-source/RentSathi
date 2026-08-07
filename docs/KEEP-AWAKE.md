# Keeping SajiloRent awake on Render (free tier)

## Problem

The Render free tier **spins the service down after ~15 minutes of no
traffic**. When a user opens the app after that idle gap they wait several
seconds (cold start) while the server boots again. The app itself already
has `/health` and `/ping` endpoints that do a light DB check, so waking it
up is just a matter of hitting the URL — no code change needed.

## Fix (no code): an external uptime/cron pinger

Use a free cron service to request the health endpoint every few minutes so
the server is always warm.

### cron-job.org (recommended, free)

1. Sign up / log in at https://cron-job.org
2. Click **Create cronjob**
3. **URL**: `https://sajilorent.onrender.com/health`
4. **Schedule**: every **5–10 minutes** (the exact interval doesn't matter —
   the important thing is to keep it above the ~15 min idle timeout).
   Example: every 5 minutes.
5. Enable **Send request as GET** (default).
6. Optionally add a request timeout of ~30s and enable **follow redirects**.
7. Save, and the app will stay awake as long as the cron is running.

### Alternatives
- **UptimeRobot** (https://uptimerobot.com) — free plan allows a 5-minute
  interval uptime monitor pointed at the same `/health` URL.
- **Paid Render instance** — `render.com` paid web services (~$7/month on the
  Starter plan) never sleep and get better response times, but are not
  required.

## Notes

- The `/health` endpoint does a trivial DB-free check, so the pinger costs
  essentially nothing on the Neon side.
- Re-trigger in case the cron job is deleted or paused: just re-create it
  following the steps above.
- If the app is ever moved off the free tier (paid Render instance or
  another always-on host), this pinger can be removed.