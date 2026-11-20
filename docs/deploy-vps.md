# Deploying Lead Desk to an Ubuntu VPS

Lead Desk runs as one Node.js process with one SQLite file. On a VPS it stays bound to
`127.0.0.1:8787`, and **Caddy** sits in front of it to provide HTTPS on your domain:

```
Browser (dashboard) ─┐
                     ├─ https://desk.example.com ─▶ Caddy :443 ─▶ node 127.0.0.1:8787 ─▶ SQLite
Extension (WhatsApp) ┘
```

> The WhatsApp Web tab still runs in **your own browser** with the extension. The VPS hosts
> the server, the dashboard, the queue and the AI calls; sending happens only while a paired
> browser has WhatsApp Web open.

You need: an Ubuntu 22.04/24.04 VPS (1 GB RAM minimum, 2 GB comfortable), SSH access, and a
domain or free subdomain pointing at the VPS IP (see "Free options" at the end).

---

## 1. DNS

Create an **A record**: `desk.example.com → <your VPS public IP>`. Check with
`ping desk.example.com` that it resolves to the VPS before continuing.

## 2. Prepare the server (as root or with sudo)

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y git curl build-essential python3 ufw unattended-upgrades

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.x

# A dedicated user that runs the app
sudo adduser --system --group --home /opt/leaddesk leaddesk

# Firewall: SSH + web only. Port 8787 stays closed to the internet.
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# Small VPS (1 GB RAM)? Add swap so the build does not run out of memory.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. Get the code onto the server

**Option A — Git (recommended).** Push the project to a *private* GitHub repo from your PC,
then on the VPS:

```bash
sudo -u leaddesk git clone https://github.com/<you>/<private-repo>.git /opt/leaddesk/app
```

(For a private repo, create a GitHub fine-grained token with read access to that repo and use
it as the password, or add a deploy key.)

**Option B — copy from your PC** (Git Bash on Windows), excluding heavy/local folders:

```bash
cd "/d/drive d/freelancing/Lead gen"
tar --exclude=node_modules --exclude=data --exclude='apps/server/data' --exclude='.git' -czf leaddesk.tgz .
scp leaddesk.tgz root@<VPS-IP>:/tmp/
# then on the VPS:
sudo mkdir -p /opt/leaddesk/app && sudo tar -xzf /tmp/leaddesk.tgz -C /opt/leaddesk/app
sudo chown -R leaddesk:leaddesk /opt/leaddesk
```

## 4. Configure `.env`

```bash
sudo -u leaddesk nano /opt/leaddesk/app/.env
```

```ini
LEAD_DESK_ADMIN_EMAIL=you@company.com
LEAD_DESK_ADMIN_PASSWORD=<12+ characters; used only on the first start>
LEAD_DESK_DATA_KEY=<output of: openssl rand -base64 32>
LEAD_DESK_COOKIE_SECURE=true
XAI_API_KEY=
LEAD_DESK_AI_EXTRA_HOSTS=
LEAD_DESK_SENDING_ENABLED=true
LEAD_DESK_AI_ENABLED=true
```

- `LEAD_DESK_COOKIE_SECURE=true` is required now that the site is served over HTTPS.
- **Moving your existing data?** Use the *same* `LEAD_DESK_DATA_KEY` as on your PC, otherwise
  the saved AI key cannot be decrypted (you would just re-enter it).

```bash
sudo chmod 600 /opt/leaddesk/app/.env
```

## 5. Install and build

```bash
cd /opt/leaddesk/app
sudo -u leaddesk npm ci
sudo -u leaddesk npm run build:web      # dashboard -> apps/server/public
sudo -u leaddesk npm run build:server   # server -> apps/server/dist
```

## 6. (Optional) Bring your existing data

On your PC, stop the server, then copy the database (the folder is the one the server ran
from, normally `apps\server\data`):

```bash
scp "/d/drive d/freelancing/Lead gen/apps/server/data/leaddesk.sqlite" root@<VPS-IP>:/tmp/
# on the VPS:
sudo mkdir -p /opt/leaddesk/app/apps/server/data
sudo mv /tmp/leaddesk.sqlite /opt/leaddesk/app/apps/server/data/
sudo chown -R leaddesk:leaddesk /opt/leaddesk/app/apps/server/data
```

Skip this to start fresh (you will do first-time setup in step 9).

## 7. Run it as a service (systemd)

```bash
sudo nano /etc/systemd/system/leaddesk.service
```

```ini
[Unit]
Description=Lead Desk
After=network-online.target
Wants=network-online.target

[Service]
User=leaddesk
Group=leaddesk
WorkingDirectory=/opt/leaddesk/app/apps/server
ExecStart=/usr/bin/node dist/index.js
Environment=NODE_ENV=production
Restart=always
RestartSec=5
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/leaddesk/app/apps/server/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /opt/leaddesk/app/apps/server/data && sudo chown -R leaddesk:leaddesk /opt/leaddesk/app/apps/server/data
sudo systemctl daemon-reload
sudo systemctl enable --now leaddesk
sudo systemctl status leaddesk          # should be "active (running)"
curl http://127.0.0.1:8787/api/v1/health   # {"ok":true,...}
```

Logs: `journalctl -u leaddesk -f` (also `apps/server/data/logs/`).

## 8. HTTPS with Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
sudo nano /etc/caddy/Caddyfile
```

```caddy
desk.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

Caddy gets and renews the Let's Encrypt certificate automatically. Open
`https://desk.example.com` — you should see the Lead Desk login page.

## 9. First login

- **Fresh install:** sign in with `LEAD_DESK_ADMIN_EMAIL` / `LEAD_DESK_ADMIN_PASSWORD`, then change
  the password in Settings. (Or create the admin with `npm run admin:create -- --email you@company.com`.)
- **Copied data:** sign in with your existing password.

There is **no setup or sign-up page**. The admin login is created in the database:
on the first start of an empty database from `LEAD_DESK_ADMIN_EMAIL` + `LEAD_DESK_ADMIN_PASSWORD`,
or with `npm run admin:create -- --email you@company.com`. The admin then creates every client
login in the admin panel (**Admin → New client**) and gives the person their email and password.

## 10. Connect the extension to the VPS

On your PC (the extension code is already updated to accept an https server):

1. `npm run build:extension`, then reload **Lead Desk Connector** in `chrome://extensions`.
2. Open the extension popup → **Unpair / Disconnect** if it was paired with the local server.
3. In the dashboard at `https://desk.example.com` → **Connection** → **Pair New Device**.
4. In the popup, set **Server Address** to `https://desk.example.com`, enter the code, click
   **Pair Extension**. Chrome asks to allow access to that site — click **Allow**.
5. Refresh WhatsApp Web. The dashboard header turns green: **Sender connected**.

Stop the local server on your PC afterwards so only one desk is in use.

## Updating later

```bash
cd /opt/leaddesk/app
sudo -u leaddesk git pull            # or copy the new files (step 3B)
sudo -u leaddesk npm ci
sudo -u leaddesk npm run build:web && sudo -u leaddesk npm run build:server
sudo systemctl restart leaddesk
```

Database migrations run automatically on start. A daily backup is written to
`apps/server/data/backups/` (14 kept). Copy them off the server now and then:

```bash
scp root@<VPS-IP>:/opt/leaddesk/app/apps/server/data/backups/*.sqlite ./leaddesk-backups/
```

## Troubleshooting

| Problem | Check |
| --- | --- |
| `https://` does not load | DNS points at the VPS? `sudo ufw status` shows 80/443? `journalctl -u caddy -e` |
| 502 Bad Gateway | `sudo systemctl status leaddesk`, `journalctl -u leaddesk -e` |
| Login works but you are logged out at once | `LEAD_DESK_COOKIE_SECURE=true` and you are on `https://` |
| Setup says secret invalid | `.env` edited? `sudo systemctl restart leaddesk` |
| Extension cannot pair | Address must be `https://…` with no path; click **Allow** when Chrome asks |
| Oracle Cloud: nothing reachable | Open 80/443 in the VCN **Security List** *and* in the instance's iptables (see below) |

---

## Free options

**Free servers that can run this (it needs a persistent disk — SQLite):**

- **Oracle Cloud "Always Free"** — Ampere (ARM) VM; since mid-2026 the free allowance is reported
  as 2 CPUs / 12 GB RAM in total (it was 4 / 24), plus about 200 GB disk. Needs a card for verification; popular regions are sometimes "out of
  capacity" (retry or pick another region). Oracle may reclaim *idle* Always-Free VMs; a
  running Lead Desk usually is not idle, and upgrading the account to Pay-As-You-Go (still
  free for these shapes) stops reclamation.
  Oracle's Ubuntu images block ports with iptables in addition to the cloud firewall:
  ```bash
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```
  and add ingress rules for TCP 80 and 443 in the VCN Security List.
- **Google Cloud free tier** — one `e2-micro` VM (2 vCPU burst, 1 GB RAM, 30 GB disk) in
  `us-west1`, `us-central1` or `us-east1`. Works; add the swap file from step 2.

**Free domain:** [DuckDNS](https://www.duckdns.org) gives `yourname.duckdns.org` pointing at
your VPS IP; Caddy can issue HTTPS for it like any domain.

**No server at all:** this version also runs on free cloud services with the data in Turso
instead of local files — see [deploy-free.md](deploy-free.md). Moving from there to a VPS later:
[upgrade-to-vps.md](upgrade-to-vps.md).

**No VPS at all:** keep running Lead Desk on your PC as today. Since the WhatsApp Web tab has to
run on a computer anyway, a VPS mainly buys you an always-on server and dashboard access from
other devices.
