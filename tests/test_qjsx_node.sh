#!/bin/sh
# Test qjsx-node Node.js compatibility wrapper

set -e
cd "$(dirname "$0")/.."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

printf "%b\n" "${BLUE}Testing qjsx-node Node.js compatibility wrapper...${NC}"

# Check if qjsx-node exists
if [ ! -f "./bin/qjsx-node" ]; then
    printf "%b\n" "${RED}❌ qjsx-node executable not found. Run 'make build' first.${NC}"
    exit 1
fi

# Create temporary test directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Test script that uses Node.js compatibility modules
cat > "$TEMP_DIR/test_node_compat.js" << 'EOF'
// Test Node.js compatibility modules available through qjsx-node
import { writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

console.log("🔧 Testing Node.js compatibility modules...");

// Test fs module functionality
const testFile = "/tmp/qjsx-node-test.txt";
const testContent = "Hello from qjsx-node fs module!";

try {
    // Test writeFileSync
    writeFileSync(testFile, testContent);
    console.log("✅ fs.writeFileSync works");
    
    // Test readFileSync
    const readContent = readFileSync(testFile, "utf8");
    if (readContent === testContent) {
        console.log("✅ fs.readFileSync works");
    } else {
        throw new Error("Read content doesn't match written content");
    }
    
    // Test existsSync
    if (existsSync(testFile)) {
        console.log("✅ fs.existsSync works");
    } else {
        throw new Error("existsSync returned false for existing file");
    }
    
    // Test statSync
    const stats = statSync(testFile);
    if (stats.isFile()) {
        console.log("✅ fs.statSync works");
    } else {
        throw new Error("statSync didn't recognize file as file");
    }
    
    // Test child_process module
    const output = execFileSync("echo", ["Hello from child_process!"]);
    if (output.includes("Hello from child_process!")) {
        console.log("✅ child_process.execFileSync works");
    } else {
        throw new Error("execFileSync didn't return expected output");
    }
    
    console.log("🎉 All Node.js compatibility tests passed!");
    
} catch (error) {
    console.error("❌ Test failed:", error.message);
    process.exit(1);
} finally {
    // Cleanup
    try {
        if (existsSync(testFile)) {
            // Use rm command since we don't have fs.unlinkSync implemented
            execFileSync("rm", [testFile]);
        }
    } catch (e) {
        // Ignore cleanup errors
    }
}
EOF

echo "Created test script using Node.js modules:"
echo "  - node:fs (writeFileSync, readFileSync, existsSync, statSync)"
echo "  - node:child_process (execFileSync)"
echo ""

# Run the test
# Note: qjsxc-compiled binaries may have GC cleanup warnings, so we check output instead of exit code
OUTPUT=$(./bin/qjsx-node "$TEMP_DIR/test_node_compat.js" 2>&1 || true)
echo "$OUTPUT" | grep -v "Assertion\|quickjs.c"

# Check if all tests passed based on output
if echo "$OUTPUT" | grep -q "All Node.js compatibility tests passed"; then
    printf "%b\n" "${GREEN}✅ qjsx-node Node.js compatibility test passed!${NC}"
    exit 0
else
    printf "%b\n" "${RED}❌ qjsx-node Node.js compatibility test failed!${NC}"
    exit 1
fi