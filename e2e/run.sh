#!/usr/bin/env bash
# Builds both projects, runs the end-to-end check and tears everything down.
set -euo pipefail
cd "$(dirname "$0")"
trap 'docker compose logs --tail=40 relay scheduling > e2e-logs.txt 2>&1 || true; docker compose down --volumes > /dev/null 2>&1' EXIT
docker compose up --detach --build --wait relay-db relay scheduling-db receiver
docker compose up --detach --build scheduling
node check.mjs
