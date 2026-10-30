#!/usr/bin/env bash
# Typecheck, test, build and deploy the staging site (https://gamba-stg.0x9.ca):
# practice runs of single games, on its own Worker and database.
#   ./deploy-staging.sh              full run: tsc, vitest, build, D1 migrations, wrangler deploy
#   ./deploy-staging.sh --skip-tests skip vitest (the slow step)
# First time only, once the Worker exists: set its session secret with
#   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET --env staging
set -euo pipefail
cd "$(dirname "$0")"

skip_tests=0
for arg in "$@"; do
	case "$arg" in
		--skip-tests) skip_tests=1 ;;
		-h|--help) sed -n '2,7p' "$0"; exit 0 ;;
		*) echo "unknown option: $arg" >&2; exit 2 ;;
	esac
done

echo "==> typecheck"
npx tsc -b

if [ "$skip_tests" -eq 0 ]; then
	echo "==> tests"
	npx vitest run
fi

# The Cloudflare Vite plugin bakes the environment into the build, so deploying
# needs no --env of its own.
export CLOUDFLARE_ENV=staging

echo "==> build"
npx vite build

echo "==> database migrations"
npx wrangler d1 migrations apply gambadle-staging --remote --env staging

echo "==> deploy"
npx wrangler deploy 2>&1 | tee /tmp/gambadle-staging-deploy.log
echo
grep "Current Version ID" /tmp/gambadle-staging-deploy.log || echo "warning: no Version ID found in output" >&2
