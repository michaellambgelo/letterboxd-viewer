#!/usr/bin/env bash
# deploy-branch: main
set -euo pipefail

# letterboxd-viewer deploy targets:
#   site   — static frontend; push to main triggers .github/workflows/deploy.yml
#            (GitHub Pages). The data pipeline cron commits to main too, so the
#            router's behind-upstream check matters here.
#   worker — rolodex Worker (worker/), deployed directly with wrangler.
# Empty DEPLOY_TARGET runs both in sequence (site first).

target="${DEPLOY_TARGET:-${1:-}}"

run_site() {
  echo "::deploy:target=site:start"
  echo "::deploy:target=site:watch=deploy.yml"
  if [[ "${DEPLOY_DRY_RUN:-}" = 1 ]]; then
    echo "would: git push origin main"
  else
    git push origin main
  fi
  echo "::deploy:target=site:url=https://letterboxd.michaellamb.dev"
  echo "::deploy:target=site:end:status=ok"
}

run_worker() {
  echo "::deploy:target=worker:start"
  if [[ "${DEPLOY_DRY_RUN:-}" = 1 ]]; then
    (cd worker && npx wrangler deploy --dry-run)
  else
    (cd worker && npx wrangler deploy)
  fi
  echo "::deploy:target=worker:url=https://rolodex.michaellamb.dev"
  echo "::deploy:target=worker:end:status=ok"
}

case "$target" in
  "")     run_site; run_worker ;;
  site)   run_site ;;
  worker) run_worker ;;
  *)
    echo "unknown target: $target (expected: site, worker)" >&2
    exit 2
    ;;
esac
