#!/bin/bash
# Test QJSXPATH module resolution with colon characters in module names

set -e
cd "$(dirname "$0")/.."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Testing QJSXPATH module resolution with colon characters...${NC}"

# Create temporary test directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Create test modules structure with colon characters
mkdir -p "$TEMP_DIR/modules/hello:mypackage"
mkdir -p "$TEMP_DIR/modules/scope:nested:module"

# Module with colon in name (as directory with index.js)
cat > "$TEMP_DIR/modules/hello:mypackage/index.js" << 'EOF'
export const name = "hello:mypackage";
export const type = "directory";
EOF

# Module with colon as direct file
cat > "$TEMP_DIR/modules/scope:nested:module.js" << 'EOF'
export const name = "scope:nested:module";  
export const type = "file";
EOF

# Test script
cat > "$TEMP_DIR/test_colon_script.js" << 'EOF'
// Test bare imports with colon characters via QJSXPATH resolution
import { name as pkg1Name, type as pkg1Type } from "hello:mypackage";
import { name as pkg2Name, type as pkg2Type } from "scope:nested:module";

console.log("✅ Colon module imports successful:");
console.log(`  - ${pkg1Name} (${pkg1Type})`);
console.log(`  - ${pkg2Name} (${pkg2Type})`);
EOF

# Run the test
echo "Creating test modules with colon characters:"
echo "  - modules/hello:mypackage/index.js (directory import)"
echo "  - modules/scope:nested:module.js (direct file import)"
echo "Setting QJSXPATH=$TEMP_DIR/modules"
echo ""

if QJSXPATH="$TEMP_DIR/modules" ./bin/qjsx "$TEMP_DIR/test_colon_script.js"; then
    echo -e "${GREEN}✅ Colon module names test passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Colon module names test failed!${NC}"
    exit 1
fi