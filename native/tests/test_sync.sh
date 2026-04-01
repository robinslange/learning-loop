#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE="${1:-debug}"
BINARY="$NATIVE_DIR/target/$PROFILE/ll-search"
DB="$HOME/brain/brain/.vault-search/vault-index.db"
VAULT="$HOME/brain/brain"
EXPORT="/tmp/ll-search-test-export.db"

if [ ! -f "$BINARY" ]; then
  echo "Binary not found at $BINARY"
  echo "Usage: $0 [debug|release]"
  exit 1
fi

echo "=== ll-search sync integration test ==="

echo "1. Export"
$BINARY export "$DB" "$EXPORT" "$VAULT"
echo "   $(sqlite3 "$EXPORT" "SELECT tier, COUNT(*) FROM notes GROUP BY tier")"

echo "2. Sync"
$BINARY sync "$DB" "$VAULT" 2>&1 | head -20

echo "3. Index --sync"
$BINARY index "$VAULT" "$DB" --sync 2>&1 | head -20

echo "4. Download binary"
$BINARY download-binary --version v1.5.0 --dest /tmp/ll-search-download-test.tar.gz 2>&1
ls -lh /tmp/ll-search-download-test.tar.gz

echo "=== PASS ==="
