# Deploying the collector to a VPS

**Why deploy:** a laptop sleeps; the mission is gap-free collection of post-fee, oracle-labeled
market data (see `docs/research/`). A small always-on VPS ends the gaps. It also improves quote
freshness: Polymarket's infrastructure is US-East, so a US-East VPS sees the book seconds-fresher
than European home internet.

**Threat model reminder:** this is a paper system. There are no keys, no funds, nothing to steal
except data — the only assets to protect are the dashboard login and the server itself.

## Recommended setup

- **Provider/region:** Hetzner Cloud (Ashburn, VA) or DigitalOcean (NYC) — ~$5–8/month,
  2GB RAM is plenty for the Docker path; 1GB works for the bare path.
- **OS:** Ubuntu 24.04.
- **Hardening (5 minutes):** SSH keys only (`PasswordAuthentication no`), `ufw allow OpenSSH &&
  ufw enable` — and nothing else open. The app binds to 127.0.0.1 only; the dashboard is reached
  through an SSH tunnel, never the public internet.

## Path A — Docker (canonical: Postgres + Redis, split processes)

```bash
# on the VPS
apt install -y docker.io docker-compose-v2 git
git clone <your-repo-remote> /opt/b5p && cd /opt/b5p
cp .env.example .env
# REQUIRED edits in .env:
#   SESSION_SECRET=$(openssl rand -hex 32)
#   OPERATOR_PASSWORD_HASH=...   # generate locally: pnpm --filter @b5p/api hash-password -- 'yourpass'
docker compose -f infra/docker-compose.prod.yml up -d --build
```

> Note: the Docker build is untested on the development Mac (no Docker installed there);
> expect to shake it out on first deploy. The bare path below is exactly what runs in dev.

## Path B — Bare VPS (10 minutes, identical to the dev setup)

```bash
# on the VPS, as a non-root user "b5p"
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22.21.1 && corepack enable && corepack prepare pnpm@9.15.4 --activate
git clone <your-repo-remote> /opt/b5p && cd /opt/b5p
pnpm install && pnpm db:migrate && pnpm db:seed
# set real credentials in .env (SESSION_SECRET, OPERATOR_PASSWORD_HASH)
sudo cp infra/b5p-collector.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now b5p-collector
```

Embedded PGlite lives in `/opt/b5p/data/pglite`. Adjust node paths in the unit file if the
version differs.

## Accessing the dashboard

```bash
# from your Mac — forwards web AND the API websocket
ssh -L 3000:127.0.0.1:3000 -L 8787:127.0.0.1:8787 <user>@<vps>
# then open http://localhost:3000 as usual
```

## Care and feeding

- **Backups:** Docker path: `docker exec <postgres-ctr> pg_dump -U b5p b5p | gzip > backup.sql.gz`
  (cron it weekly). Bare path: tar `data/pglite` while the service is stopped, or rely on
  research exports.
- **Updates:** `git pull && docker compose -f infra/docker-compose.prod.yml up -d --build`
  (or `pnpm install && systemctl restart b5p-collector`).
- **Disk:** tick tables grow ~200–400MB/month; a 20GB VPS disk lasts years. Retention/compaction
  is still manual (see `docs/limitations.md`).
- **Weekly cadence:** check the dashboard via tunnel — decisions count, fill-conditioned P&L on
  the late-snipe experiment, and any `fee_schedule` health events (a fee change is the signal to
  rerun the calibration study).

## Migrating your Mac's already-collected data (optional)

The Mac's PGlite dir (`data/pglite`) can be tarred and restored onto the VPS bare-path setup
as-is before first start. For the Docker path, export/import via `pg_dump`-compatible SQL is not
yet scripted — simplest is to start fresh on the VPS and keep the Mac archive for research.

## Jurisdiction note

Reading public market data and paper trading engage no Polymarket terms around trading. If live
trading ever becomes justified, jurisdiction and geo-restriction questions must be answered
first — see `docs/live-trading-checklist.md`; a US-hosted server executing trades has its own
legal surface distinct from where you live.
