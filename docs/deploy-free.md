# Deploying Lead Desk for free (Turso + Render + Cloudflare Pages)

This version of Lead Desk runs with **no server of your own**:

```
Browser ──▶ Cloudflare Pages (dashboard, free)
              │  /api/*  (Pages Function: functions/api/[[path]].js)
              ▼
Extension ─▶ Render free web service (Lead Desk server, Node 22)
              │  libsql:// (websocket)
              ▼
            Turso (free): control database + your desk + one database per client account
```

- **Turso** stores the data (hosted SQLite). The SQL and migrations are the same as on a VPS.
- **Render** runs the server. Its disk is wiped on every restart, so nothing is kept there.
- **Cloudflare Pages** serves the dashboard and forwards `/api/*` to Render, so the login cookie
  stays on the dashboard's own address (no CORS, no cross-site cookies).
- The **Chrome extension** talks to Render directly.

> **Simplest setup: skip Cloudflare.** `render.yaml` also builds the dashboard, so the Render
> service serves the whole app at its own address (`https://<service>.onrender.com`): login, admin
> console and client desk. Do steps 0–3 and 5–7 below; step 4 (Cloudflare Pages) is optional. Use
> the Render address everywhere (browser, extension, `LEAD_DESK_PUBLIC_URL`).

When you outgrow the free plans, move everything to a VPS with one command:
see [upgrade-to-vps.md](upgrade-to-vps.md).

## What the free plans give you (check the providers' pages; these change)

| Service | Free plan | What it means for Lead Desk |
| --- | --- | --- |
| Turso | 100 databases, 5 GB, 500M rows read and 10M rows written per month | 1 control + 1 desk + up to ~98 client accounts |
| Render | 750 instance hours/month; sleeps after 15 min without requests; ~1 min to wake | Stays awake while a paired browser has WhatsApp Web open (the extension calls every 5–10 s) |
| Cloudflare Pages | Static hosting; Functions: 100k requests/day | The dashboard and its API calls |

**Good to know:**
- When nobody has WhatsApp Web open, Render sleeps. Opening the dashboard then takes up to a minute.
  Nothing is lost: queued messages wait, and the 6-hour catch-up rule still applies.
- Free plans are for getting started, not for many paying customers. Move to a VPS (or a paid
  Render instance) before you rely on it for business.

---

## 0. Put the code on GitHub

Render and Cloudflare deploy from a Git repository. In this folder:

```powershell
git init
git add -A
git commit -m "Lead Desk cloud"
```

Create a **private** repository on GitHub and push to it (GitHub shows the two commands).

## 1. Turso: three things to create

Sign up at <https://turso.tech>. You can use the web dashboard (app.turso.tech) or the Turso CLI
(on Windows the CLI runs inside WSL). With the CLI:

```bash
turso auth login

# Two databases in your default group. Pick the group location closest to your Render region:
# render.yaml uses Render "virginia", so choose a US East location for the group.
turso db create leaddesk-main
turso db create leaddesk-control

# Their URLs (libsql://...)
turso db show leaddesk-main --url
turso db show leaddesk-control --url

# One token that can open every database in the group (main, control and all client databases)
turso group tokens create default

# A Platform API token, so Lead Desk can create a database for each new client account
turso auth api-tokens mint leaddesk

# Your organization slug (TURSO_ORG)
turso org list
```

Write down: the two URLs, the group token, the API token and the org slug.

> Only running your own desk (no client accounts)? You can skip the API token and org slug.
> Creating a client account will then show an error that names the missing settings.

## 2. (Optional) Bring your existing data

Skip this to start fresh. Otherwise, copy your current local data into Turso once:

1. Stop the old Lead Desk server on your PC.
2. Create `.env` in this folder (copy `.env.example`) and fill in:
   ```ini
   DATABASE_URL=libsql://leaddesk-main-<org>.turso.io
   CONTROL_DATABASE_URL=libsql://leaddesk-control-<org>.turso.io
   DATABASE_AUTH_TOKEN=<group token>
   TURSO_ORG=<org slug>
   TURSO_API_TOKEN=<platform API token>
   ```
3. Run the copy, pointing at the old project's data folder:
   ```powershell
   npm install
   npm -w @leaddesk/server run db:to-turso -- --from "D:\drive d\freelancing\Lead gen\apps\server\data"
   ```
   It prints a line per database with row counts. Each client account gets its own new Turso database.
4. **Use the same `LEAD_DESK_DATA_KEY` as your old `.env`** in step 3 below. Otherwise the saved
   AI key cannot be decrypted (you would just re-enter it on the AI screen).

## 3. Render: the server

1. <https://render.com> → **New → Blueprint** → connect your GitHub repository.
   Render reads `render.yaml` and proposes one free web service, `leaddesk-server`.
2. Fill in the values it asks for:

   | Key | Value |
   | --- | --- |
   | `DATABASE_URL` | `libsql://leaddesk-main-…turso.io` |
   | `CONTROL_DATABASE_URL` | `libsql://leaddesk-control-…turso.io` |
   | `DATABASE_AUTH_TOKEN` | the group token |
   | `TURSO_ORG`, `TURSO_API_TOKEN` | for client accounts (optional) |
   | `LEAD_DESK_PUBLIC_URL` | leave empty for now; set it in step 4 |
   | `LEAD_DESK_ADMIN_EMAIL`, `LEAD_DESK_ADMIN_PASSWORD`, `LEAD_DESK_ADMIN_NAME` | your admin login (12+ character password). Only used when the database has no admin yet; with moved data your existing login is kept. |
   | `XAI_API_KEY`, `RAZORPAY_*` | optional, as before |

   `LEAD_DESK_DATA_KEY` is generated by Render. If you moved data in step 2, replace it with your
   old value. **Copy it somewhere safe**: you need it again for a VPS.
3. Deploy. When it is live, open `https://<service>.onrender.com/api/v1/health`. It should show
   `{"ok":true,...}`.

If the log says `CONTROL_DATABASE_URL must point at a second Turso database`, step 2's values are missing.

## 4. Cloudflare Pages: the dashboard

1. <https://dash.cloudflare.com> → **Workers & Pages → Create → Pages → Connect to Git** → your repository.
2. Build settings:

   | Setting | Value |
   | --- | --- |
   | Framework preset | None |
   | Build command | `npm run build:static` |
   | Build output directory | `apps/web/dist` |
   | Root directory | *(empty — the repository root, where `functions/` is)* |

3. Environment variables (Settings → Variables and Secrets), for **Production**:

   | Name | Value | Used for |
   | --- | --- | --- |
   | `NODE_VERSION` | `22` | the build |
   | `VITE_EXTENSION_SERVER_URL` | `https://<service>.onrender.com` | shown when pairing the extension |
   | `LEAD_DESK_API_ORIGIN` | `https://<service>.onrender.com` | the `/api` proxy |

4. Deploy. You get an address like `https://leaddesk.pages.dev`.
5. Back in Render, set `LEAD_DESK_PUBLIC_URL=https://leaddesk.pages.dev` and let it redeploy.

## 5. First login

Open your Pages address: it shows only the login screen.
- **Fresh start:** sign in with `LEAD_DESK_ADMIN_EMAIL` / `LEAD_DESK_ADMIN_PASSWORD`. Then change
  the password in Settings (the environment value is not used again).
- **Moved data:** sign in with your existing email/password.

There is **no setup or sign-up page**. The admin login is created in the database:
on the first start of an empty database from `LEAD_DESK_ADMIN_EMAIL` + `LEAD_DESK_ADMIN_PASSWORD`,
or with `npm run admin:create -- --email you@company.com`. The admin then creates every client
login in the admin panel (**Admin → New client**) and gives the person their email and password.

## 6. Connect the Chrome extension

1. `npm run build:extension`, then load or reload `apps/extension/dist` in `chrome://extensions`.
2. Dashboard → **Connection → Pair New Device**. The dialog shows the **server address for the
   extension**: your Render address.
3. In the extension popup, set **Server Address** to that Render address (not the Pages address),
   enter the code and click **Pair Extension**. Chrome asks to allow the site: click **Allow**.
4. Refresh WhatsApp Web. The dashboard header turns green.

The extension uses Render directly so its polling never counts against the Pages Functions quota.

## 7. Razorpay webhook (only if you sell subscriptions)

Set the webhook URL in Razorpay to
`https://<service>.onrender.com/api/v1/billing/razorpay/webhook` with the same secret as
`RAZORPAY_WEBHOOK_SECRET`.

---

## Updating

Push to GitHub. Render and Cloudflare Pages both redeploy automatically. Database migrations run
when the server starts (on every database, including client accounts as they are opened).

## Backups

Turso keeps point-in-time restore for your databases (1 day on the free plan; check your plan).
For your own copy at any time, run the VPS export on your PC. It does not change the cloud data:

```powershell
npm -w @leaddesk/server run db:to-local -- --out "D:\leaddesk-backup-2026-11-20"
```

## Troubleshooting

| Problem | Check |
| --- | --- |
| Dashboard shows `proxy_not_configured` | `LEAD_DESK_API_ORIGIN` is set in Pages and starts with `https://`. Redeploy Pages after changing variables. |
| Every page load is slow at first | Render was asleep (no browser with WhatsApp Web open). It wakes in about a minute. |
| Logged out immediately after login | `LEAD_DESK_COOKIE_SECURE=true` on Render, and you use the Pages `https://` address. |
| "Creating client accounts on Turso needs …" | Set `TURSO_API_TOKEN` and `TURSO_ORG` on Render. |
| Login locked for everyone after a few wrong passwords | `TRUST_PROXY=true` must be set on Render (it is in `render.yaml`). |
| AI key "cannot be decrypted" | `LEAD_DESK_DATA_KEY` differs from the one the key was saved with. Re-enter the key, or restore the old value. |
| Render suspended near month end | 750 free hours are shared by all free services in the workspace. Run only this one. |

## Optional: keep Render awake

Render only sleeps when nothing calls it, so normally you do not need this. If you want the
dashboard to open instantly even when no browser is open, a free uptime pinger (for example
cron-job.org or UptimeRobot) can call `https://<service>.onrender.com/api/v1/health` every
10 minutes. One service running all month uses about 744 of the 750 free hours.
