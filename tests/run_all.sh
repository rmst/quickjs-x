#!/bin/sh
# Run all QJSX tests

set -e
cd "$(dirname "$0")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

printf "%b\n" "${YELLOW}🧪 Running QJSX Test Suite${NC}"
echo "=================================="

# Check if qjsx is built
if [ ! -f "../bin/qjsx" ]; then
    printf "%b\n" "${RED}❌ qjsx executable not found. Run 'make build' first.${NC}"
    exit 1
fi

TESTS_PASSED=0
TESTS_FAILED=0

# Function to run a test
run_test() {
    echo ""
    printf "%b\n" "${BLUE}Running: $2${NC}"
    echo "----------------------------------------"

    if ./"$1"; then
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
}

# Run individual tests
run_test "test_qjsxpath.sh" "QJSXPATH Module Resolution"
run_test "test_index_resolution.sh" "Node.js-style Index Resolution"
run_test "test_qjsx_node.sh" "qjsx-node Node.js Compatibility"
run_test "test_qjsx_compile_args.sh" "qjsx-compile Custom Arguments"
run_test "test_qjsxc.sh" "qjsxc Compiler with QJSXPATH"
run_test "test_qjsxc_dynamic.sh" "qjsxc Dynamic Script Loading"

# Summary
echo ""
echo "=================================="
printf "%b\n" "${YELLOW}Test Results:${NC}"
printf "%b\n" "  ${GREEN}Passed: $TESTS_PASSED${NC}"
printf "%b\n" "  ${RED}Failed: $TESTS_FAILED${NC}"

if [ $TESTS_FAILED -eq 0 ]; then
    printf "%b\n" "${GREEN}🎉 All tests passed!${NC}"
    exit 0
else
    printf "%b\n" "${RED}💥 Some tests failed.${NC}"
    exit 1
fi