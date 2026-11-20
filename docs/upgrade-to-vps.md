# Moving from the free cloud setup to a VPS

The same code runs in both places. Only the environment changes:

| | Free cloud | VPS |
| --- | --- | --- |
| Data | Turso (`DATABASE_URL=libsql://…`) | SQLite files (`data/leaddesk.sqlite`, `data/control.sqlite`, `data/tenants/*.sqlite`) |
| Server | Render | Node on the VPS, Caddy in front (HTTPS) |
| Dashboard | Cloudflare Pages, proxying `/api` | Served by the server itself |
| Backups | Turso point-in-time restore | Daily file backups in `data/backups/` (14 kept) |

## 1. Prepare the VPS

Follow [deploy-vps.md](deploy-vps.md) steps 1–5 (DNS, packages, code, `.env`, build), with
this `.env`:

```ini
LEAD_DESK_DATA_KEY=<the same value as on Render — required to keep the saved AI key>
LEAD_DESK_COOKIE_SECURE=true
LEAD_DESK_PUBLIC_URL=https://desk.example.com
# no DATABASE_URL / CONTROL_DATABASE_URL: the data lives in apps/server/data/
```

Do not start the service yet.

## 2. Copy the data out of Turso

Pause sending first so nothing changes during the copy: in Render, set
`LEAD_DESK_SENDING_ENABLED=false` (or close WhatsApp Web).

On the VPS, run the export with the **Turso** settings given only to this one command (they are
not in `.env`):

```bash
cd /opt/leaddesk/app
sudo -u leaddesk env \
  DATABASE_URL='libsql://leaddesk-main-<org>.turso.io' \
  CONTROL_DATABASE_URL='libsql://leaddesk-control-<org>.turso.io' \
  DATABASE_AUTH_TOKEN='<group token>' \
  npm -w @leaddesk/server run db:to-local -- --out data
```

`--out data` is resolved from `apps/server`, so the files land in `apps/server/data/`, where the
server looks for them. You get `leaddesk.sqlite`, `control.sqlite` and `tenants/<account>.sqlite`
for every client account. Each account's database location is rewritten to its local file.

(You can also run it on your PC and copy the `data` folder to the VPS with `scp`.)

## 3. Start on the VPS

Continue with [deploy-vps.md](deploy-vps.md) steps 7–8 (systemd, Caddy). Then:

1. Open `https://desk.example.com` and sign in with your usual email and password.
2. Re-pair the extension: popup → **Unpair**, then pair with `https://desk.example.com`.
3. Razorpay: change the webhook URL to `https://desk.example.com/api/v1/billing/razorpay/webhook`.

## 4. Switch the cloud off

When the VPS has run fine for a few days:
- Render: suspend or delete the service.
- Cloudflare Pages: delete the project (or point it elsewhere).
- Turso: keep the databases a while as a backup, then delete them.

## Going the other way (VPS → Turso)

`npm -w @leaddesk/server run db:to-turso -- --from data` copies the local files into the Turso
databases named in `.env`. See step 2 of [deploy-free.md](deploy-free.md).
