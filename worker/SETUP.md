# Setup runbook — letterboxd-rolodex Worker

One-time manual steps. The code is already in place; this is the Cloudflare side.
Order matters: create the KV namespaces and deploy first, then attach Access (you
need the deployed hostname before the Access application can point at it).

## 1. KV namespaces

```bash
cd ~/Workspace/letterboxd-viewer/worker
npm install
npx wrangler kv namespace create ROLODEX             # paste id         -> wrangler.toml
npx wrangler kv namespace create ROLODEX --preview   # paste preview_id -> wrangler.toml
```

## 2. First deploy

```bash
npx wrangler deploy    # binds rolodex.michaellamb.dev
curl -s https://rolodex.michaellamb.dev/health       # {"ok":true}
curl -s https://rolodex.michaellamb.dev/rolodex      # {"...","profiles":[]}
```

At this point `/admin` is **unprotected but non-functional** — the Worker refuses
every admin request because `ACCESS_AUD` is still a placeholder, so it fails
closed. Step 3 makes it work.

## 3. Cloudflare Access — path-scoped to /admin

This mirrors **App B** in `~/Workspace/now-store/SETUP.md`, *not* App A. now-store
gates its whole hostname because it has no public surface; here `GET /rolodex` must
stay public for the GitHub Pages site, so only `/admin` is gated.

In **Zero Trust → Access**:

1. **Settings → Authentication →** confirm **One-time PIN** is enabled.
2. **Applications → Add → Self-hosted**, application domain
   `rolodex.michaellamb.dev`, **path = `/admin`** (covers `/admin/*`).
3. Policy: **Action = Allow**, **Include → Emails → `lambm07@gmail.com`**.
4. Leave the rest of the hostname public.
5. From the application's **Overview** tab, copy the **Application Audience (AUD)
   tag**.

## 4. Wire the Access identity into the Worker

Both values are non-secret (they identify, they don't authorize), so they live in
`wrangler.toml` rather than as secrets:

```toml
[vars]
ACCESS_TEAM_DOMAIN = "michaellamb.cloudflareaccess.com"
ACCESS_AUD = "<application audience tag from step 3.5>"
```

Then redeploy:

```bash
npx wrangler deploy
```

The Worker verifies the `Cf-Access-Jwt-Assertion` signature against
`https://$ACCESS_TEAM_DOMAIN/cdn-cgi/access/certs` and checks `aud`, `iss` and
`exp` on every admin request — so a removed or misconfigured Access application
fails closed instead of silently exposing the write API.

## 5. GitHub token (admin Pipeline and Diary tags tabs)

Those two tabs read and write this repo through the GitHub API. Create a
fine-grained token scoped to this repository only, with **Contents** and
**Actions** read/write, and store it as a secret:

```bash
npx wrangler secret put GITHUB_TOKEN
```

Without it every write from those tabs answers 503; the rest of the admin works.

## 6. Verify

```bash
# public read stays open
curl -s -o /dev/null -w '%{http_code}\n' https://rolodex.michaellamb.dev/rolodex   # 200

# admin is gated (302 to the Access login, or 403)
curl -s -o /dev/null -w '%{http_code}\n' https://rolodex.michaellamb.dev/admin     # 302 or 403

# the write API is gated too, not just the HTML
curl -s -X POST https://rolodex.michaellamb.dev/admin/api/profiles \
  -H 'Content-Type: application/json' -d '{"username":"test"}'                     # {"error":"unauthorized"}
```

Then open <https://rolodex.michaellamb.dev/admin> in a browser, complete the
one-time PIN, and add the first profile. **Preview feed** confirms a handle
resolves before you save it.

## Local development

```bash
npm run dev     # wrangler dev --var ADMIN_DEV_BYPASS:true  (port 8788)
npm test        # node:test — feed parsing, history merge, admin endpoints (fake KV, stubbed fetch)
```

`ADMIN_DEV_BYPASS` is passed on the command line, never committed as a var, so it
cannot ride along into a deploy. It exists because `wrangler dev` rewrites
`request.url` to the custom domain declared in `wrangler.toml`, leaving the Worker
no reliable way to detect a local run on its own.

To point the local static site at the local Worker:

```bash
cd ~/Workspace/letterboxd-viewer && npx serve -p 8000
open 'http://localhost:8000/rolodex?api=http://localhost:8788'
```

**Use `npx serve`, not `python3 -m http.server`.** Navigation hrefs are
extension-less (`/rolodex`), which GitHub Pages resolves to `rolodex.html` but
Python's `http.server` does not — under it `/rolodex` 404s and the in-page nav
links appear broken even though the deployed site is fine. Port 8000 matters
either way: it's the origin on the Worker's CORS allowlist.

The `?api=` override is honored **only** on localhost — on the deployed site it
would let a crafted link repoint the page at an attacker-controlled JSON source.

## Operating notes

- **`wrangler kv key` defaults to local in v4.** Pass `--remote` when inspecting or
  seeding production KV, or you will silently edit the local simulator:
  ```bash
  npx wrangler kv key get rolodex:v1 --binding ROLODEX --remote
  ```
- **KV keys:** `rolodex:v1` is the curated list and the only source of truth
  (display order is derived on read, not stored). `snapshot:<user>` (no TTL),
  `avatar:<user>` (24h TTL) and `stats:live:v1` are derived caches — safe to
  delete at any time; they refill on the next request. `history:<user>` is not
  a cache: it holds every diary entry seen in that member's feed and only
  regrows from what is still in the ~50-item window. `rolodex:prev` is the list
  as it was before the last import, for the admin's one-step undo.
- **Removing someone** in the admin also deletes their snapshot, avatar and
  history keys, so re-adding them starts clean.
- **Cron:** `wrangler.toml` schedules `0 */3 * * *`, refreshing 1/8 of the
  rolodex per run. It deploys with the Worker; nothing to set up.
- **The rolodex page is public.** Everything on it is already public on Letterboxd,
  but it does publish the list of who you follow closely alongside their recent
  watches. If you ever want someone curated but not featured, add a
  `public: true|false` flag to the entry shape, the admin form, and the
  `/rolodex` filter.
