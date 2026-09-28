#!/bin/bash
# audit-public.sh — fails if forbidden strings appear in the public repo
# Used as a pre-push gate for the bch-wiki-public + bch-bot-public + bch-bot-omarchy repos.
set -e
FORBIDDEN=(
  'qpjfw956u6rc88n8ul4xxyu9fu2v94s2eylh9vtzhv'
  'bch-wallet-mainnet'
  'revenue projection'
  'jav@'
  'htmapro\.com'
)

EXIT=0
for needle in "${FORBIDDEN[@]}"; do
  hits=$(grep -rIlE "$needle" --include='*.md' --include='*.mjs' --include='*.json' --include='*.qml' . 2>/dev/null | head -5)
  if [ -n "$hits" ]; then
    echo "FORBIDDEN '$needle' found in:"
    echo "$hits"
    EXIT=1
  fi
done
if [ $EXIT -eq 0 ]; then
  echo "audit-public: clean (no forbidden strings found)"
fi
exit $EXIT
