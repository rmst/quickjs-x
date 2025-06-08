#!/bin/bash
# Run all QJSX tests

set -e
cd "$(dirname "$0")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🧪 Running QJSX Test Suite${NC}"
echo "=================================="

# Check if qjsx is built
if [ ! -f "../bin/qjsx" ]; then
    echo -e "${RED}❌ qjsx executable not found. Run 'make build' first.${NC}"
    exit 1
fi

TESTS_PASSED=0
TESTS_FAILED=0

# Function to run a test
run_test() {
    local test_script="$1"
    local test_name="$2"
    
    echo ""
    echo -e "${BLUE}Running: $test_name${NC}"
    echo "----------------------------------------"
    
    if ./"$test_script"; then
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
}

# Run individual tests
run_test "test_qjsxpath.sh" "QJSXPATH Module Resolution"
run_test "test_index_resolution.sh" "Node.js-style Index Resolution"

# Summary
echo ""
echo "=================================="
echo -e "${YELLOW}Test Results:${NC}"
echo -e "  ${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "  ${RED}Failed: $TESTS_FAILED${NC}"

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}💥 Some tests failed.${NC}"
    exit 1
fi