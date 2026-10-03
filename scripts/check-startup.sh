#!/usr/bin/env bash
# Definitive check: does each script actually RUN, not just parse?
# node --check does not resolve identifiers, which is exactly how the missing
# import slipped through. Running it is the only real test.
cd "$(dirname "$0")/.."
export BCH_WALLET_DIR=/nonexistent   # so nothing can sign or broadcast

fail=0
for f in balance utxos swap send send-token sweep add-liquidity round-trip \
         stake address history; do
  [ -f "scripts/$f.mjs" ] || continue
  out=$(timeout 30 node "scripts/$f.mjs" --help 2>&1 | head -2 | tr '\n' ' ')
  if echo "$out" | grep -qE 'is not defined|ReferenceError|SyntaxError'; then
    echo "  BROKEN $f: $out"
    fail=1
  else
    echo "  ok     $f"
  fi
done

echo
echo "=== the two the grep checker flagged, verified directly ==="
for f in swap utxos; do
  out=$(timeout 30 node "scripts/$f.mjs" --help 2>&1 | head -2 | tr '\n' ' ')
  echo "  $f: ${out:0:110}"
done

echo
[ "$fail" -eq 0 ] && echo "ALL SCRIPTS START" || echo "FIX NEEDED"
