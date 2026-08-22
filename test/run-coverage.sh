#!/usr/bin/env bash
# Runs every suite with coverage recording, then reports which functions no
# suite executed. Exits non-zero if any function was never run.
set -uo pipefail
cd "$(dirname "$0")/.."
rm -rf test/shots/nodecov test/shots/coverage-crawl.json test/shots/coverage-e2e.json
mkdir -p test/shots/nodecov
for t in globals units unit build-script validate-script; do
  NODE_V8_COVERAGE=test/shots/nodecov node "test/$t.mjs" > /dev/null || exit 1
done
node test/crawl.mjs --fast --coverage > /dev/null || exit 1
node test/e2e.mjs --coverage > /dev/null || exit 1
exec node test/coverage-report.mjs
