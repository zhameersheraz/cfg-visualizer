#!/usr/bin/env bash
# Smoke test for the CFG Visualizer API.
#
# Usage:
#   ./test_api.sh /path/to/some_binary [function_address]
#
# Defaults to dumping the first function in the binary. Exits non-zero on any
# HTTP failure or empty payload.

set -euo pipefail

BINARY="${1:-}"
FUNC_ADDR="${2:-}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"

if [[ -z "$BINARY" ]]; then
    echo "Usage: $0 <binary> [function_address]" >&2
    exit 2
fi
if [[ ! -f "$BINARY" ]]; then
    echo "No such file: $BINARY" >&2
    exit 2
fi

echo "==> Health check"
curl -fsS "$BASE_URL/healthz" | python3 -m json.tool

echo "==> Uploading $BINARY"
UPLOAD_JSON=$(curl -fsS -F "file=@${BINARY}" "$BASE_URL/upload")
echo "$UPLOAD_JSON" | python3 -m json.tool

SID=$(echo "$UPLOAD_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["session_id"])')

# If user didn't specify a function, grab the first one from the upload response.
if [[ -z "$FUNC_ADDR" ]]; then
    FUNC_ADDR=$(echo "$UPLOAD_JSON" \
        | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["functions"][0]["address"])')
fi

echo "==> Fetching CFG for $FUNC_ADDR (session $SID)"
curl -fsS "$BASE_URL/function/$FUNC_ADDR?session_id=$SID" | python3 -m json.tool

echo "==> Fetching overview graph"
curl -fsS "$BASE_URL/overview?session_id=$SID" | python3 -m json.tool | head -n 60

echo "==> Cleaning up session"
curl -fsS -X DELETE "$BASE_URL/session/$SID"
echo
echo "OK"
