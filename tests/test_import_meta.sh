#!/bin/sh
# Minimal test for import.meta.dirname in modules

set -e
cd "$(dirname "$0")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

printf "%b\n" "${BLUE}Testing import.meta (dirname, filename)...${NC}"

TEMP_DIR=$(mktemp -d)
TEMP_DIR=$(realpath "$TEMP_DIR")
trap "rm -rf $TEMP_DIR" EXIT

# Entry module prints its dirname and filename
cat > "$TEMP_DIR/entry.mjs" << 'EOF'
console.log('ENTRY_DIR', import.meta.dirname);
console.log('ENTRY_FILE', import.meta.filename);
EOF

# Imported module prints its dirname and filename
mkdir -p "$TEMP_DIR/sub"
cat > "$TEMP_DIR/sub/mod.mjs" << 'EOF'
export const show = () => {
  console.log('MOD_DIR', import.meta.dirname);
  console.log('MOD_FILE', import.meta.filename);
};
show();
EOF
cat > "$TEMP_DIR/runner.mjs" << 'EOF'
import './sub/mod.mjs';
EOF

# Resolve qjsx path
QJS_BIN="${QJSX_BIN_DIR}/qjsx"
if [ ! -x "$QJS_BIN" ]; then
  echo "qjsx not found at $QJS_BIN" >&2
  echo "Build first, e.g.: BIN_DIR=\$(mktemp -d)/bin make build" >&2
  exit 1
fi

# Run entry module
ENTRY_OUT=$("$QJS_BIN" -m "$TEMP_DIR/entry.mjs")
ENTRY_DIR_GOT=$(printf "%s" "$ENTRY_OUT" | awk '/^ENTRY_DIR /{sub(/^ENTRY_DIR /, ""); print; exit}')
ENTRY_FILE_GOT=$(printf "%s" "$ENTRY_OUT" | awk '/^ENTRY_FILE /{sub(/^ENTRY_FILE /, ""); print; exit}')

if [ "${ENTRY_DIR_GOT}" != "${TEMP_DIR}" ]; then
  printf "%b\n" "${RED}❌ entry.mjs dirname mismatch${NC}"
  echo "Expected: $TEMP_DIR"
  echo "Got:      $ENTRY_DIR_GOT"
  exit 1
fi

if [ "${ENTRY_FILE_GOT}" != "${TEMP_DIR}/entry.mjs" ]; then
  printf "%b\n" "${RED}❌ entry.mjs filename mismatch${NC}"
  echo "Expected: $TEMP_DIR/entry.mjs"
  echo "Got:      $ENTRY_FILE_GOT"
  exit 1
fi

# Run imported module
MOD_OUT=$("$QJS_BIN" -m "$TEMP_DIR/runner.mjs")
MOD_DIR_GOT=$(printf "%s" "$MOD_OUT" | awk '/^MOD_DIR /{sub(/^MOD_DIR /, ""); print; exit}')
MOD_FILE_GOT=$(printf "%s" "$MOD_OUT" | awk '/^MOD_FILE /{sub(/^MOD_FILE /, ""); print; exit}')

if [ "${MOD_DIR_GOT}" != "${TEMP_DIR}/sub" ]; then
  printf "%b\n" "${RED}❌ mod.mjs dirname mismatch${NC}"
  echo "Expected: $TEMP_DIR/sub"
  echo "Got:      $MOD_DIR_GOT"
  exit 1
fi

if [ "${MOD_FILE_GOT}" != "${TEMP_DIR}/sub/mod.mjs" ]; then
  printf "%b\n" "${RED}❌ mod.mjs filename mismatch${NC}"
  echo "Expected: $TEMP_DIR/sub/mod.mjs"
  echo "Got:      $MOD_FILE_GOT"
  exit 1
fi

printf "%b\n" "${GREEN}✅ import.meta dirname + filename work${NC}"
exit 0
