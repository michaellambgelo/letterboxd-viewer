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
ACCESS_TEAM_DOMAIN = "<your-team>.cloudflareaccess.com"
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

## 5. Verify

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
npm test        # node:test — feed parsing, entity decoding, username rules
```

`ADMIN_DEV_BYPASS` is passed on the command line, never committed as a var, so it
cannot ride along into a deploy. It exists because `wrangler dev` rewrites
`request.url` to the custom domain declared in `wrangler.toml`, leaving the Worker
no reliable way to detect a local run on its own.

To point the local static site at the local Worker:

```bash
cd ~/Workspace/letterboxd-viewer && python3 -m http.server 8000
open 'http://localhost:8000/rolodex.html?api=http://localhost:8788'
```

The `?api=` override is honored **only** on localhost — on the deployed site it
would let a crafted link repoint the page at an attacker-controlled JSON source.

## Operating notes

- **`wrangler kv key` defaults to local in v4.** Pass `--remote` when inspecting or
  seeding production KV, or you will silently edit the local simulator:
  ```bash
  npx wrangler kv key get rolodex:v1 --binding ROLODEX --remote
  ```
- **KV keys:** `rolodex:v1` is the ordered curated list and the only source of
  truth. `snapshot:<user>` (no TTL) and `avatar:<user>` (24h TTL) are derived
  caches — safe to delete at any time; they refill on the next request.
- **Removing someone** in the admin also deletes their snapshot and avatar keys,
  so re-adding them starts clean.
- **The rolodex page is public.** Everything on it is already public on Letterboxd,
  but it does publish the list of who you follow closely alongside their recent
  watches. If you ever want someone curated but not featured, add a
  `public: true|false` flag to the entry shape, the admin form, and the
  `/rolodex` filter.
