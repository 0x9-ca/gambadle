#!/usr/bin/env bash
# Typecheck, test, build and deploy Gambadle.
#   ./deploy.sh              full run: tsc, vitest, build, D1 migrations, wrangler deploy
#   ./deploy.sh --skip-tests skip vitest (the slow step)
#   ./deploy.sh --build-only build without deploying
set -euo pipefail
cd "$(dirname "$0")"

skip_tests=0
build_only=0
for arg in "$@"; do
	case "$arg" in
		--skip-tests) skip_tests=1 ;;
		--build-only) build_only=1 ;;
		-h|--help) sed -n '2,5p' "$0"; exit 0 ;;
		*) echo "unknown option: $arg" >&2; exit 2 ;;
	esac
done

echo "==> typecheck"
npx tsc -b

if [ "$skip_tests" -eq 0 ]; then
	echo "==> tests"
	npx vitest run
fi

echo "==> build"
npx vite build

if [ "$build_only" -eq 1 ]; then
	echo "Built; not deploying."
	exit 0
fi

echo "==> database migrations"
npx wrangler d1 migrations apply gambadle --remote

echo "==> deploy"
npx wrangler deploy 2>&1 | tee /tmp/gambadle-deploy.log
echo
grep "Current Version ID" /tmp/gambadle-deploy.log || echo "warning: no Version ID found in output" >&2
