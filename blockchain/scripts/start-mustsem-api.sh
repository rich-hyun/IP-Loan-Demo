#!/usr/bin/env bash
# Separate Mustsem database. Public settings only; never signs transactions.
set -euo pipefail
mvp_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mvp_workspace="$(cd -- "$mvp_script_dir/../.." && pwd)"
cd "$mvp_workspace"
export IPLOAN_RPC_URL="${IPLOAN_RPC_URL:-https://block.mustree.kr}"
export IPLOAN_CHAIN_ID="${IPLOAN_CHAIN_ID:-7601}"
export IPLOAN_ZERO_GAS_PRICE="${IPLOAN_ZERO_GAS_PRICE:-0}"
# HTTPS media Manager verified on Mustsem 7601 (deployments/mustsem-https.json).
export IPLOAN_MANAGER_ADDRESS="${IPLOAN_MANAGER_ADDRESS:-0x65C40E399b145A9f9021652192C3e781dadbD2FA}"
# Separate DB per Manager: applications are bound to the contract they were registered on.
export IPLOAN_DB_PATH="${IPLOAN_DB_PATH:-$mvp_workspace/server/iploan-mustsem-https.db}"
if [[ "$IPLOAN_CHAIN_ID" != "7601" ]]; then echo 'Mustsem chainId must be 7601' >&2; exit 1; fi
if [[ "$IPLOAN_DB_PATH" == *iploan-sepolia-mvp.db ]]; then echo 'Never reuse the Sepolia DB for Mustsem' >&2; exit 1; fi
exec server/.venv/bin/python -m gunicorn --bind 127.0.0.1:5001 --workers 1 --threads 4 --timeout 660 --access-logfile - server.app:app
