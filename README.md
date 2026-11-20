# Lead Desk

WhatsApp lead desk. See `ARCHITECTURE.md` for the full architecture specification.

## Where it can run

The same code runs in three places; only the environment changes.

| Setup | Data | Guide |
| --- | --- | --- |
| Your own PC | SQLite files in `apps/server/data/` | sections below |
| **Free cloud**: Turso + Render + Cloudflare Pages | Turso (hosted SQLite) | [docs/deploy-free.md](docs/deploy-free.md) |
| VPS | SQLite files, Caddy for HTTPS | [docs/deploy-vps.md](docs/deploy-vps.md); moving from the cloud: [docs/upgrade-to-vps.md](docs/upgrade-to-vps.md) |

The database layer (`apps/server/src/db.ts`) picks the engine from `DATABASE_URL`:
a `libsql://` URL uses Turso, anything else (or nothing) uses a local SQLite file.

Tests: `npm test` runs the suite on local SQLite; `npm run test:libsql` runs the same suite
through the Turso client (against local temp files, no Turso account needed).

---

## 1. Local Run & Deployment (This Windows PC Only)

Lead Desk runs as **one local Node 22 process** on this Windows PC. There is no remote VPS, no Caddy reverse proxy, no systemd unit, and no public hostname. The desk listens strictly on loopback (`http://127.0.0.1:8787`).

### Prerequisites
- Node.js 22 LTS
- Google Chrome or Brave Browser

### Setup & First Run

1. **Install dependencies:**
   ```powershell
   npm install
   ```

2. **Configure environment:**
   ```powershell
   cp .env.example .env
   ```
   Configure the following in `.env`:
   - `LEAD_DESK_ADMIN_EMAIL` / `LEAD_DESK_ADMIN_PASSWORD`: the admin login, created on the first start of an empty database (no setup page).
   - `LEAD_DESK_DATA_KEY`: 32-byte encryption key (used for AES-256-GCM encryption of provider keys).
   - `LEAD_DESK_COOKIE_SECURE=false`: Required for local HTTP loopback (`127.0.0.1`).
   - `XAI_API_KEY`: (Optional) Seeds the AI API key on boot if not already configured.

3. **Build the system:**
   ```powershell
   npm run build
   ```

4. **Start the server:**
   ```powershell
   npm -w @leaddesk/server run start
   # Or for development with live reload:
   # npm run dev:server
   # npm run dev:web
   ```

5. **Open Dashboard:**
   Visit `http://127.0.0.1:8787` in your browser.
   Sign in with the admin email and password. There is no sign-up: the admin creates client logins under **Admin → New client** and hands over the email and password.
   Forgot the admin password? `npm run admin:reset-password -- --email you@company.com` prints a new one.

---

## 2. Load the Extension (Unpacked)

1. Build the extension:
   ```powershell
   npm run build:extension
   ```
2. In Chrome or Brave:
   - Navigate to `chrome://extensions`
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked**
   - Select `apps\extension\dist` in this folder
3. Click the Lead Desk puzzle icon in your browser toolbar:
   - Type server origin: `http://127.0.0.1:8787`
   - In the Dashboard (`/connection`), click **Pair New Device** to generate an 8-character pairing code.
   - Enter the pairing code in the extension popup and click **Pair**.
4. Open WhatsApp Web (`https://web.whatsapp.com`) and log in. Once authenticated and ready, the extension will acquire the sender lease and show the green "Sender connected" chip on your dashboard.

---

## 3. Disconnect Playbook

When your laptop sleeps, the WhatsApp tab closes, or the network drops:

- **Due rows stay safely queued**: Lead Desk never drops messages. The server queue is the durable source of truth.
- **6-Hour Catch-up Expiration**: Messages queued but unable to send for more than 6 hours automatically move to `expired` status via the server-side queue sweeper, preventing a burst of stale messages from sending when the laptop wakes up.
- **Header Chip Indicators**:
  - `Sender connected` (Green): Extension is active, tab is eligible, and lease is held.
  - `Reconnecting` (Yellow): 30-second grace period is active while tab recovers.
  - `Standby` (Blue): Paired device is standby (another device holds sender lease).
  - `Extension quiet` (Orange): No heartbeat received for > 45 seconds.
  - `Not paired` (Grey): No paired devices found.
- **Resolution Steps**:
  1. Open WhatsApp Web on the sender browser.
  2. Click the Lead Desk extension popup and inspect the status:
     - `QR`: Scan the QR code to re-authenticate WhatsApp Web.
     - `CONFLICT`: Another WhatsApp Web tab or session was opened elsewhere. Close the competing session and refresh.
     - `WhatsApp UI not ready`: Wait for WhatsApp Web chat list (`#pane-side`) to finish loading.
     - Grey/Unpaired: Pair the extension again from the `/connection` dashboard page.

---

## 4. Backups and Database Reliability

- **Automated SQLite Backups**: The server runs an automatic daily backup schedule using `better-sqlite3`'s native online backup API (`db.backup(...)`), writing clean snapshots to `data/backups/leaddesk-YYYYMMDD.sqlite`.
- **Retention**: The backup service automatically retains the 14 most recent daily backups and prunes older ones.
- **Restoration**: To restore from a backup, stop the server, replace `data/leaddesk.sqlite` with the selected `data/backups/leaddesk-YYYYMMDD.sqlite` file, and delete any leftover `-wal` and `-shm` files.

---

## 5. Security & Observability

- **Single Process Principle**: Only run one server process at a time against `data/leaddesk.sqlite`. Double-writers or multiple server instances against WAL-mode SQLite on Windows are prohibited.
- **Content Security Policy (CSP)**:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'`
- **Structured JSON Logs**: Logs are written to stdout and `data/logs/leaddesk.log` using `pino` with daily rotation (keeping 14 log files).
- **Zero Secret Leakage**: Message bodies, operator passwords, session cookies, and API keys are never logged at `info` level. Extension bundles contain no secrets or `.env` files.
