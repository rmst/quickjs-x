#!/bin/sh
# Test Node.js-style index.js resolution functionality

set -e
cd "$(dirname "$0")/.."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

printf "%b\n" "${BLUE}Testing Node.js-style index.js resolution...${NC}"

# Create temporary test directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Create test modules structure
mkdir -p "$TEMP_DIR/simple_module"

# Module with index.js (directory import)
cat > "$TEMP_DIR/simple_module/index.js" << 'EOF'
export const type = "directory";
EOF

# Direct file without extension (.js resolution)
cat > "$TEMP_DIR/direct_file.js" << 'EOF'
export const type = "file";
EOF

# Test script  
cat > "$TEMP_DIR/test_script.js" << 'EOF'
// Test Node.js-style resolution for relative imports
import { type as dirType } from "./simple_module";  // Should resolve to ./simple_module/index.js
import { type as fileType } from "./direct_file";   // Should resolve to ./direct_file.js

console.log("✅ Index.js resolution successful:", dirType, fileType);
EOF

# Run the test
echo "Creating test structure:"
echo "  - simple_module/index.js (directory → index.js resolution)"
echo "  - direct_file.js (name → name.js resolution)"
echo ""

if ${QJSX_BIN_DIR}/qjsx "$TEMP_DIR/test_script.js"; then
    printf "%b\n" "${GREEN}✅ Index.js resolution test passed!${NC}"
    exit 0
else
    printf "%b\n" "${RED}❌ Index.js resolution test failed!${NC}"
    exit 1
fi