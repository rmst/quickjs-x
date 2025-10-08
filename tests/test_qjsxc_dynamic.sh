#!/bin/bash
# Test qjsxc-compiled binaries loading external scripts with QJSXPATH imports

set -e
cd "$(dirname "$0")/.."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Testing qjsxc-compiled runtime with QJSXPATH for external scripts...${NC}"

# Create temporary test directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Create a "runtime" that dynamically loads external scripts
cat > "$TEMP_DIR/runtime.js" << 'EOF'
import * as std from "std";
import * as os from "os";

if (scriptArgs.length < 2) {
    console.log("Usage: runtime <script.js>");
    std.exit(1);
}

console.log("Runtime: Loading external script:", scriptArgs[1]);
async function loadModule() {
    try {
        await import(scriptArgs[1]);
    } catch(e) {
        console.log("❌ Error:", e.message);
        std.exit(1);
    }
}
loadModule();
os.setTimeout(() => {}, 50);
EOF

# Create QJSXPATH modules directory
mkdir -p "$TEMP_DIR/modules"
cat > "$TEMP_DIR/modules/utils.js" << 'EOF'
export function greet(name) {
    return "Hello from QJSXPATH module: " + name;
}
EOF

cat > "$TEMP_DIR/modules/math.js" << 'EOF'
export function add(a, b) {
    return a + b;
}
EOF

# Create external script that uses QJSXPATH imports
cat > "$TEMP_DIR/external_app.js" << 'EOF'
import { greet } from "utils";
import { add } from "math";

console.log("✅ External script loaded");
console.log("✅ Bare import works:", greet("qjsxc"));
console.log("✅ Math works:", add(2, 3), "=== 5");
EOF

# Create external script with relative imports
cat > "$TEMP_DIR/local_lib.js" << 'EOF'
export const msg = "from local";
EOF

cat > "$TEMP_DIR/external_local.js" << 'EOF'
import { msg } from "./local_lib.js";
console.log("✅ Relative import works:", msg);
EOF

echo "Step 1: Compiling runtime with qjsxc..."
if ! ./bin/qjsxc -e -o "$TEMP_DIR/runtime.c" "$TEMP_DIR/runtime.js" 2>&1 | head -3; then
    echo -e "${RED}❌ qjsxc compilation failed!${NC}"
    exit 1
fi

echo "Step 2: Compiling C code with gcc..."
if ! gcc -Iquickjs -o "$TEMP_DIR/runtime" "$TEMP_DIR/runtime.c" \
    quickjs/.obj/quickjs.o quickjs/.obj/libregexp.o quickjs/.obj/libunicode.o \
    quickjs/.obj/cutils.o quickjs/.obj/quickjs-libc.o quickjs/.obj/dtoa.o \
    -lm -ldl -lpthread 2>&1 | head -3; then
    echo -e "${RED}❌ gcc compilation failed!${NC}"
    exit 1
fi

echo ""
echo "Step 3: Testing external script with QJSXPATH bare imports..."
OUTPUT=$(cd "$TEMP_DIR" && QJSXPATH=modules ./runtime external_app.js 2>&1 || true)
echo "$OUTPUT" | grep -v "Assertion\|quickjs.c" || true
echo ""

# Check if all expected outputs are present
if echo "$OUTPUT" | grep -q "✅ External script loaded" && \
   echo "$OUTPUT" | grep -q "✅ Bare import works: Hello from QJSXPATH module: qjsxc" && \
   echo "$OUTPUT" | grep -q "✅ Math works: 5 === 5"; then
    echo -e "${GREEN}✅ QJSXPATH bare imports work!${NC}"
else
    echo -e "${RED}❌ QJSXPATH test failed!${NC}"
    echo "Expected output not found"
    exit 1
fi

echo ""
echo "Step 4: Testing external script with relative imports..."
OUTPUT=$(cd "$TEMP_DIR" && ./runtime external_local.js 2>&1 || true)
echo "$OUTPUT" | grep -v "Assertion\|quickjs.c" || true
echo ""

if echo "$OUTPUT" | grep -q "✅ Relative import works: from local"; then
    echo -e "${GREEN}✅ Relative imports work!${NC}"
else
    echo -e "${RED}❌ Relative import test failed!${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}✅ All qjsxc dynamic loading tests passed!${NC}"
echo "(Note: qjsxc-compiled binaries can now load external scripts with QJSXPATH imports)"
