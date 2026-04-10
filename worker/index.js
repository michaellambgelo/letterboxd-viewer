/**
 * Letterboxd Viewer — Trigger Worker
 *
 * Cloudflare Worker that acts as a secure proxy for GitHub Actions workflow_dispatch.
 * Holds the GitHub PAT as an environment secret so it never appears in client-side code.
 *
 * Environment variables (set via wrangler secret / Cloudflare dashboard):
 *   GITHUB_TOKEN  — Fine-grained PAT with Actions: write on this repo only
 *   REPO_OWNER    — GitHub repo owner (e.g. "michaellambgelo")
 *   REPO_NAME     — GitHub repo name  (e.g. "letterboxd-viewer")
 *
 * Endpoints:
 *   POST /trigger   { username: string } → triggers the RSS download workflow
 *   OPTIONS /trigger                     → CORS preflight
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const USERNAME_RE = /^[a-zA-Z0-9_-]{1,50}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname !== '/trigger') {
      return json({ error: 'Not found' }, 404);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    // Parse and validate body
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { username } = body;

    if (!username || !USERNAME_RE.test(username)) {
      return json({ error: 'Invalid or missing username' }, 400);
    }

    const triggeredAt = new Date().toISOString();

    // Dispatch the GitHub Actions workflow
    const ghUrl = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/actions/workflows/download-data-and-assets.yml/dispatches`;

    let ghResp;
    try {
      ghResp = await fetch(ghUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'letterboxd-viewer-worker/1.0',
        },
        body: JSON.stringify({
          ref: 'last-four-watched',
          inputs: { username },
        }),
      });
    } catch (err) {
      return json({ error: `GitHub API unreachable: ${err.message}` }, 502);
    }

    if (!ghResp.ok) {
      const detail = await ghResp.text().catch(() => '');
      return json({ error: `GitHub dispatch failed (${ghResp.status})`, detail }, 502);
    }

    // GitHub returns 204 No Content on success — no run_id yet.
    // The browser will poll GET /actions/runs?event=workflow_dispatch to find it.
    return json({ status: 'triggered', username, triggeredAt });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
