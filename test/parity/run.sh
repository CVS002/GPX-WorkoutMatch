#!/bin/sh
# Python ↔ TypeScript parity test: replays the original Python app's answers to
# a full wizard scenario (627 requests + jobs) against the Netlify port.
#
#   sh test/parity/run.sh            (needs python3 with fastapi + httpx, node)
set -e
cd "$(dirname "$0")/../.."
OUT=test/.build/parity
mkdir -p "$OUT"
python3 test/parity/fixtures.py "$OUT/fix"
python3 test/parity/mocks.py "$OUT/fix" 18711 18712 > "$OUT/mocks.log" 2>&1 &
MOCKS=$!
trap 'kill $MOCKS 2>/dev/null' EXIT
sleep 2
python3 test/parity/oracle.py "$OUT/fix" "$OUT/work" 18711 18712 > "$OUT/oracle.log" 2>&1
tail -1 "$OUT/oracle.log"
npx esbuild test/run.ts --bundle --platform=node --format=esm --outfile=test/.build/run.mjs --log-level=warning
node test/.build/run.mjs "$OUT/fix" "$OUT/work" 18711 18712
