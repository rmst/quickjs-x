#!/bin/sh
# Test QJSXPATH module resolution functionality

set -e
cd "$(dirname "$0")/.."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

printf "%b\n" "${BLUE}Testing QJSXPATH module resolution...${NC}"

# Create temporary test directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Create test modules structure
mkdir -p "$TEMP_DIR/modules/math"
mkdir -p "$TEMP_DIR/modules/utils"

# Math module (as directory with index.js)
cat > "$TEMP_DIR/modules/math/index.js" << 'EOF'
export const name = "math";
EOF

# Utils module (as direct file)  
cat > "$TEMP_DIR/modules/utils.js" << 'EOF'
export const name = "utils";
EOF

# Test script
cat > "$TEMP_DIR/test_script.js" << 'EOF'
// Test bare imports via QJSXPATH resolution
import { name as mathName } from "math";      // Should resolve to modules/math/index.js
import { name as utilsName } from "utils";    // Should resolve to modules/utils.js

console.log("✅ QJSXPATH imports successful:", mathName, utilsName);
EOF

# Run the test
echo "Creating test modules:"
echo "  - modules/math/index.js (directory import)"
echo "  - modules/utils.js (direct file import)"
echo "Setting QJSXPATH=$TEMP_DIR/modules"
echo ""

if QJSXPATH="$TEMP_DIR/modules" ./bin/qjsx "$TEMP_DIR/test_script.js"; then
    printf "%b\n" "${GREEN}✅ QJSXPATH test passed!${NC}"
    exit 0
else
    printf "%b\n" "${RED}❌ QJSXPATH test failed!${NC}"
    exit 1
fi