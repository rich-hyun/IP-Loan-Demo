#!/usr/bin/env bash
# Separate Mustsem database. Public settings only; never signs transactions.
set -euo pipefail
mvp_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mvp_workspace="$(cd -- "$mvp_script_dir/../.." && pwd)"
cd "$mvp_workspace"
export IPLOAN_RPC_URL="${IPLOAN_RPC_URL:-https://block.mustree.kr}"
export IPLOAN_CHAIN_ID="${IPLOAN_CHAIN_ID:-7601}"
export IPLOAN_ZERO_GAS_PRICE="${IPLOAN_ZERO_GAS_PRICE:-0}"
# The v3 Manager deployed from admin.html; the server refuses any other contract version.
if [[ -z "${IPLOAN_MANAGER_ADDRESS:-}" ]]; then echo 'Set IPLOAN_MANAGER_ADDRESS to the v3 Manager address' >&2; exit 1; fi
export IPLOAN_MANAGER_ADDRESS
# Separate DB per Manager: applications are bound to the contract they were registered on.
export IPLOAN_DB_PATH="${IPLOAN_DB_PATH:-$mvp_workspace/server/iploan-mustsem-v3.db}"
if [[ "$IPLOAN_CHAIN_ID" != "7601" ]]; then echo 'Mustsem chainId must be 7601' >&2; exit 1; fi
if [[ "$IPLOAN_DB_PATH" == *iploan-sepolia-mvp.db ]]; then echo 'Never reuse the Sepolia DB for Mustsem' >&2; exit 1; fi
exec server/.venv/bin/python -m gunicorn --bind 127.0.0.1:5001 --workers 1 --threads 4 --timeout 660 --access-logfile - server.app:app
