#
# QJSX Makefile
# 
# Builds the qjsx executable with QJSXPATH module resolution support
#

QUICKJS_DIR = quickjs
VERSION = 2024-01-13

# Compiler settings (mirroring QuickJS defaults)
CC = gcc
CFLAGS = -g -Wall -Wno-array-bounds -Wno-format-truncation -fwrapv \
         -D_GNU_SOURCE -DCONFIG_VERSION='"$(VERSION)"' -DCONFIG_BIGNUM
CFLAGS_OPT = $(CFLAGS) -O2
LDFLAGS = -g -rdynamic
LIBS = -lm -ldl -lpthread

# Build directories (can be overridden: make BIN_DIR=/tmp/build)
BIN_DIR ?= bin
OBJ_DIR ?= $(BIN_DIR)/obj

# Program names
QJSX_PROG = $(BIN_DIR)/qjsx
QJSX_NODE_PROG = $(BIN_DIR)/qjsx-node
QJSXC_PROG = $(BIN_DIR)/qjsxc

# QuickJS object files (built by QuickJS)
QUICKJS_OBJS = $(QUICKJS_DIR)/.obj/quickjs.o $(QUICKJS_DIR)/.obj/libregexp.o \
               $(QUICKJS_DIR)/.obj/libunicode.o $(QUICKJS_DIR)/.obj/cutils.o \
               $(QUICKJS_DIR)/.obj/quickjs-libc.o $(QUICKJS_DIR)/.obj/dtoa.o \
               $(QUICKJS_DIR)/.obj/repl.o

# Default target
all: $(QJSX_PROG) $(QJSX_NODE_PROG) $(QJSXC_PROG)

# Create directories
$(BIN_DIR):
	mkdir -p $(BIN_DIR)

$(OBJ_DIR):
	mkdir -p $(OBJ_DIR)

# Build qjsx executable
$(QJSX_PROG): $(OBJ_DIR)/qjsx.o quickjs-deps | $(BIN_DIR)
	$(CC) $(LDFLAGS) -o $@ $(OBJ_DIR)/qjsx.o $(QUICKJS_OBJS) $(LIBS)
	chmod +x $@

# Generate qjsx.c from quickjs/qjs.c by applying the patch
$(OBJ_DIR)/qjsx.c: $(QUICKJS_DIR)/qjs.c qjsx.patch qjsx-module-resolution.h | $(OBJ_DIR)
	patch -p0 < qjsx.patch -o $@ $(QUICKJS_DIR)/qjs.c

# Build qjsx.o from the patched source
$(OBJ_DIR)/qjsx.o: $(OBJ_DIR)/qjsx.c qjsx-module-resolution.h | $(OBJ_DIR)
	$(CC) $(CFLAGS_OPT) -I. -I$(QUICKJS_DIR) -c -o $@ $<

# Build qjsxc executable
$(QJSXC_PROG): $(OBJ_DIR)/qjsxc.o quickjs-deps | $(BIN_DIR)
	$(CC) $(LDFLAGS) -o $@ $(OBJ_DIR)/qjsxc.o $(QUICKJS_OBJS) $(LIBS)
	chmod +x $@
	cp $(QUICKJS_DIR)/*.h $(BIN_DIR)/
	cp $(QUICKJS_DIR)/libquickjs.a $(BIN_DIR)/ 2>/dev/null || true

# Generate embedded header from qjsx-module-resolution.h
qjsx-module-resolution-embedded.h: qjsx-module-resolution.h embed-header.sh
	./embed-header.sh

# Generate qjsxc.c from quickjs/qjsc.c by applying the patch
$(OBJ_DIR)/qjsxc.c: $(QUICKJS_DIR)/qjsc.c qjsxc.patch qjsx-module-resolution.h qjsx-module-resolution-embedded.h | $(OBJ_DIR)
	patch -p0 < qjsxc.patch -o $@ $(QUICKJS_DIR)/qjsc.c

# Build qjsxc.o from the patched source
$(OBJ_DIR)/qjsxc.o: $(OBJ_DIR)/qjsxc.c qjsx-module-resolution.h | $(OBJ_DIR)
	$(CC) $(CFLAGS_OPT) -DCONFIG_CC=\"$(CC)\" -DCONFIG_PREFIX=\"/usr/local\" -I. -I$(QUICKJS_DIR) -c -o $@ $<

# Build qjsx-node (standalone executable with embedded node modules)
$(QJSX_NODE_PROG): qjsx-node-bootstrap.js node/* $(QJSXC_PROG) | $(BIN_DIR)
	QJSXPATH=node ./bin/qjsxc -D node/fs -D node/process -D node/child_process -D node/crypto -o $@ qjsx-node-bootstrap.js

# Build QuickJS dependencies
quickjs-deps:
	$(MAKE) -C $(QUICKJS_DIR) all

# Clean our build artifacts
clean:
	rm -rf $(BIN_DIR)

# Clean everything including QuickJS
clean-all: clean
	$(MAKE) -C $(QUICKJS_DIR) clean

# Test targets
test: $(QJSX_PROG) $(QJSX_NODE_PROG) $(QJSXC_PROG)
	@echo "Running QJSX test suite..."
	./tests/run_all.sh

test-qjsxpath: $(QJSX_PROG)
	./tests/test_qjsxpath.sh

test-index: $(QJSX_PROG)
	./tests/test_index_resolution.sh

test-qjsx-node: $(QJSX_NODE_PROG)
	./tests/test_qjsx_node.sh

test-qjsxc: $(QJSXC_PROG)
	./tests/test_qjsxc.sh

test-qjsxc-dynamic: $(QJSXC_PROG)
	./tests/test_qjsxc_dynamic.sh

# Build everything (QuickJS + qjsx)
build: quickjs-deps all

# Install qjsx, qjsx-node, and qjsxc
install: $(QJSX_PROG) $(QJSX_NODE_PROG) $(QJSXC_PROG)
	mkdir -p "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QJSX_PROG) "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QJSX_NODE_PROG) "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QJSXC_PROG) "$(DESTDIR)$(PREFIX)/bin"

# Help target
help:
	@echo "QJSX Makefile targets:"
	@echo "  all         - Build qjsx, qjsx-node, and qjsxc executables"
	@echo "  build       - Build QuickJS dependencies and all programs"
	@echo "  test        - Run all tests"
	@echo "  test-qjsxpath - Run QJSXPATH module resolution tests"
	@echo "  test-index  - Run Node.js-style index.js resolution tests"
	@echo "  test-qjsx-node - Run qjsx-node Node.js compatibility tests"
	@echo "  test-qjsxc  - Run qjsxc compiler with QJSXPATH tests"
	@echo "  clean       - Clean build artifacts"
	@echo "  clean-all   - Clean everything including QuickJS"
	@echo "  install     - Install all programs to \$$(PREFIX)/bin"
	@echo ""
	@echo "Usage examples:"
	@echo "  make build && make test"
	@echo "  QJSXPATH=./my_modules ./bin/qjsx script.js"
	@echo "  QJSXPATH=./my_modules ./bin/qjsxc -o app.c app.js"

.PHONY: all build clean clean-all install help quickjs-deps test test-qjsxpath test-index test-qjsx-node test-qjsxc test-qjsxc-dynamic
