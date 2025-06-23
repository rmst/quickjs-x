#!/bin/bash
# Test qjsx-compile with custom arguments and % substitution

set -e
cd "$(dirname "$0")/.."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Testing qjsx-compile with custom arguments and % substitution...${NC}"

# Create temporary test directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Create test app structure with nested directories
mkdir -p "$TEMP_DIR/app_libs/subdir/nested"

# Create a main.js that will be auto-executed
cat > "$TEMP_DIR/app_libs/main.js" << 'EOF'
// Import utility from same directory and nested file
import { appName } from "./utils.js";
import { nestedValue } from "./subdir/nested/config.js";

console.log("🚀 Auto-launched app from %");
console.log("✅ App name:", appName);
console.log("📁 Nested value:", nestedValue);
console.log("📝 Auto-launch test successful!");

// Create a global variable to prove the script ran
globalThis.AUTO_LAUNCH_SUCCESS = true;
EOF

# Create a utility module
cat > "$TEMP_DIR/app_libs/utils.js" << 'EOF'
export const appName = "TestApp";
export const version = "1.0.0";
EOF

# Create a nested config file to test path handling
cat > "$TEMP_DIR/app_libs/subdir/nested/config.js" << 'EOF'
export const nestedValue = "nested/path/test";
export const configPath = "subdir/nested/config.js";
EOF

# Build self-extracting script that auto-runs main.js
echo "Creating self-extracting app with auto-launch:"
echo "  - Module directory: $TEMP_DIR/app_libs"
echo "  - Auto-launch script: %/subdir/../main.js"
echo ""

if ./qjsx-compile "$TEMP_DIR/test-app" "$TEMP_DIR/app_libs" '%/subdir/../main.js'; then
    echo ""
    echo "Testing the auto-launching app..."
    
    # Run the app (should auto-execute main.js)
    OUTPUT=$("$TEMP_DIR/test-app" 2>&1)
    if [ $? -eq 0 ]; then
        echo "App output:"
        echo "$OUTPUT"
        
        # Check if the expected output is present
        if echo "$OUTPUT" | grep -q "Auto-launch test successful!"; then
            echo -e "${GREEN}✅ qjsx-compile custom arguments test passed!${NC}"
            exit 0
        else
            echo -e "${RED}❌ Expected output not found in app execution${NC}"
            exit 1
        fi
    else
        echo -e "${RED}❌ Auto-launching app failed to execute${NC}"
        echo "Error output: $OUTPUT"
        exit 1
    fi
else
    echo -e "${RED}❌ Failed to build self-extracting app${NC}"
    exit 1
fi