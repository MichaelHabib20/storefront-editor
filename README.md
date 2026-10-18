# storefront-editor

The AI editor behind the admin's **AI Designer** page. A merchant chats in the admin; the backend forwards each
request here; the editor changes that store's copy of the storefront code with Claude, checks it (types, rules,
tests, screenshots on phone and desktop), serves a preview, and publishes the store's site.

```
Admin (AI Designer page) ──► Backend (Laravel, /api/admin/...) ──x-editor-key──► storefront-editor (this, port 4300)
Merchant's browser ──────────────────────────────────────────────► preview URLs + live chat events (/stores/:id/events)
storefront-editor ──► git worktree per store (headless-storefront-demo, branch store/<id>) ──► vercel deploy
```

Related repos:
- Storefront (the "starter"): https://github.com/MichaelHabib20/headless-storefront-demo — `main` is shared by every
  store; each store's own design lives on its branch `store/<id>` (seif: `store/seif`).
- Backend: `el-dokan/saas-ecommerce-backend`, branch `feature/headless-v3-shop-checkout` (calls this service).
- Admin: `el-dokan/supercommerce-admin`, branch `feature/ai-designer` (the AI Designer page).

## Server requirements

- Linux VM, about 4 vCPU and 8–16 GB RAM (each active store runs a Next.js preview, builds and a headless browser).
- Node.js 20+, git, and Chromium for Playwright (`npx playwright install --with-deps chromium`).
- The Vercel CLI (`npm i -g vercel`) for publishing.
- A process manager (systemd or pm2) so the service restarts by itself.
- HTTPS on fixed hostnames through a reverse proxy (nginx/Caddy), e.g. `editor.<domain>` → `127.0.0.1:4300` and
  `preview-<store>.<domain>` → that store's preview port (3301–3399). Turn proxy buffering off for
  `/stores/:id/events` (server-sent events).

## Install

The editor expects the storefront repo next to it (or set `EDITOR_STARTER_REPO`):

```sh
git clone https://github.com/MichaelHabib20/headless-storefront-demo
git clone <this repo> storefront-editor

cd headless-storefront-demo && npm ci && git branch store/seif origin/store/seif && cd ..
cd storefront-editor && npm ci && npx playwright install --with-deps chromium
npm test            # node --test test/
```

## Configuration (environment variables)

| Variable | Required | What |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API key (spend is limited per store in `config/ai.json`) |
| `EDITOR_PORT` | no (4300) | Port of the HTTP API |
| `EDITOR_SERVICE_KEY` | yes | Shared secret the backend sends as `x-editor-key` (same value as the backend's `STOREFRONT_EDITOR_KEY`) |
| `EDITOR_TEAM_KEY` | for the team reports page | Second key for `/team/...` (backend `STOREFRONT_EDITOR_TEAM_KEY`) |
| `EDITOR_PREVIEW_PUBLIC_URLS` | yes on a server | Public address per preview port, e.g. `{"3301":"https://preview-seif.<domain>"}` |
| `EDITOR_TEST_LOGIN_PHONE` / `EDITOR_TEST_LOGIN_PASSWORD` | no | A **test** customer the bug-finding browser signs in with |
| `SEIF_SC_API_KEY` (one per store, name set in the store record) | if the store's API needs it | The store's storefront API key, passed to its previews |
| `VERCEL_TOKEN` | for publishing | Lets `vercel deploy` run without an interactive login |
| `EDITOR_STARTER_REPO`, `EDITOR_WORKSPACES_DIR`, `EDITOR_DATA_DIR` | no | Paths (defaults: `../headless-storefront-demo`, `./workspaces`, `./data`) |

Everything else (checks, preview mode, timeouts, port range) is in `src/config.mjs` with defaults.

Never commit keys. `data/` (chats, spend ledger, reports, uploads, `stores.json`) and `workspaces/` are git-ignored;
back up `data/` — it is the service's state.

## First start

```sh
npm start   # or: systemd/pm2 running `node src/server.mjs` with the variables above
```

1. Create the store copy (reuses the existing `store/seif` branch):
   `curl -X POST -H "x-editor-key: $EDITOR_SERVICE_KEY" -H "Content-Type: application/json" -d '{"id":"seif","apiUrl":"https://staging-seif.witheldokan.com","apiKeyEnv":"SEIF_SC_API_KEY"}' https://editor.<domain>/stores`
2. Publishing: make a folder linked to the store's Vercel project once (`mkdir -p /srv/publish/seif && cd $_ && vercel link`),
   then add `"publish": {"dir": "/srv/publish/seif", "siteUrl": "https://<store site>"}` to the store's record in
   `data/stores.json` and restart.
3. Point the backend at the service: in the backend environment set `STOREFRONT_EDITOR_URL` and
   `STOREFRONT_EDITOR_PUBLIC_URL` to `https://editor.<domain>`, `STOREFRONT_EDITOR_KEY` / `STOREFRONT_EDITOR_TEAM_KEY`
   to the same keys, `STOREFRONT_EDITOR_STORE_ID=seif`, then redeploy the backend.
4. Check: `curl -H "x-editor-key: $EDITOR_SERVICE_KEY" https://editor.<domain>/stores/seif/budget` → 200, then send a
   message from the admin's AI Designer page (`/store-front/ai-designer`).

## Notes

- One change runs at a time per store; a second request gets "busy".
- The AI may only edit the files allowed in `config/ai.json` (`files.editable`), never the locked ones.
- API list: the header comment of `src/server.mjs`.
