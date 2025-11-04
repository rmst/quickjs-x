#
# QJSX Makefile
#
# Builds the qjsx executable with QJSXPATH module resolution support
#

VERSION = 2024-01-13

# Compiler settings (mirroring QuickJS defaults)
CC = gcc
CFLAGS = -g -Wall -Wno-array-bounds -Wno-format-truncation -fwrapv \
         -D_GNU_SOURCE -DCONFIG_VERSION='"$(VERSION)"' -DCONFIG_BIGNUM
CFLAGS_OPT = $(CFLAGS) -O2
LDFLAGS = -g -rdynamic
LIBS = -lm -ldl -lpthread

# Build directories (can be overridden: make BIN_DIR=/tmp/build)
PLATFORM := $(shell uname -s | tr '[:upper:]' '[:lower:]')
BIN_DIR ?= bin/$(PLATFORM)

# Program names
QJSX_PROG = $(BIN_DIR)/qjsx
QJSX_NODE_PROG = $(BIN_DIR)/qjsx-node
QJSXC_PROG = $(BIN_DIR)/qjsxc

# QuickJS object files (from our copied and built QuickJS)
# Note: use our patched quickjs-libc.o to extend import.meta
QUICKJS_OBJS = $(BIN_DIR)/quickjs/.obj/quickjs.o $(BIN_DIR)/quickjs/.obj/libregexp.o \
               $(BIN_DIR)/quickjs/.obj/libunicode.o $(BIN_DIR)/quickjs/.obj/cutils.o \
               $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/quickjs/.obj/dtoa.o \
               $(BIN_DIR)/quickjs/.obj/repl.o

# Convenience symlinks
QJSX_LINK = bin/qjsx
QJSX_NODE_LINK = bin/qjsx-node
QJSXC_LINK = bin/qjsxc

# Default target
all: quickjs-deps $(QJSX_PROG) $(QJSX_NODE_PROG) $(QJSXC_PROG) convenience-links

# Create directories
$(BIN_DIR):
	mkdir -p $(BIN_DIR)

$(BIN_DIR)/obj:
	mkdir -p $(BIN_DIR)/obj

# Build qjsx executable
$(QJSX_PROG): $(BIN_DIR)/obj/qjsx.o $(BIN_DIR)/obj/quickjs-libc.o quickjs-deps | $(BIN_DIR)
	$(CC) $(LDFLAGS) -o $@ $(BIN_DIR)/obj/qjsx.o $(QUICKJS_OBJS) $(LIBS)
	chmod +x $@

# Generate qjsx.c from quickjs/qjs.c by applying the patch
$(BIN_DIR)/obj/qjsx.c: quickjs/qjs.c qjsx.patch qjsx-module-resolution.h | $(BIN_DIR)/obj
	patch -p0 < qjsx.patch -o $@ quickjs/qjs.c

# Build qjsx.o from the patched source
$(BIN_DIR)/obj/qjsx.o: $(BIN_DIR)/obj/qjsx.c qjsx-module-resolution.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build qjsxc executable
$(QJSXC_PROG): $(BIN_DIR)/obj/qjsxc.o $(BIN_DIR)/obj/quickjs-libc.o quickjs-deps | $(BIN_DIR)
	$(CC) $(LDFLAGS) -o $@ $(BIN_DIR)/obj/qjsxc.o $(QUICKJS_OBJS) $(LIBS)
	chmod +x $@
	cp $(BIN_DIR)/quickjs/*.h $(BIN_DIR)/
	cp $(BIN_DIR)/quickjs/libquickjs.a $(BIN_DIR)/

# Generate embedded header from qjsx-module-resolution.h
qjsx-module-resolution-embedded.h: qjsx-module-resolution.h embed-header.sh
	./embed-header.sh

# Generate qjsxc.c from quickjs/qjsc.c by applying the patch
$(BIN_DIR)/obj/qjsxc.c: quickjs/qjsc.c qjsxc.patch qjsx-module-resolution.h qjsx-module-resolution-embedded.h | $(BIN_DIR)/obj
	patch -p0 < qjsxc.patch -o $@ quickjs/qjsc.c

# Build qjsxc.o from the patched source
$(BIN_DIR)/obj/qjsxc.o: $(BIN_DIR)/obj/qjsxc.c qjsx-module-resolution.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -DCONFIG_CC=\"$(CC)\" -DCONFIG_PREFIX=\"/usr/local\" -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Patch and build quickjs-libc (adds import.meta.dirname)
$(BIN_DIR)/obj/quickjs-libc.c: quickjs/quickjs-libc.c quickjs-libc.patch | $(BIN_DIR)/obj
	patch -p0 < quickjs-libc.patch -o $@ quickjs/quickjs-libc.c

$(BIN_DIR)/obj/quickjs-libc.o: $(BIN_DIR)/obj/quickjs-libc.c | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build qjsx-node (standalone executable with embedded node modules)
$(QJSX_NODE_PROG): qjsx-node-bootstrap.js qjsx-node/node/* $(QJSXC_PROG) quickjs-deps | $(BIN_DIR)
	QJSXPATH=./qjsx-node $(QJSXC_PROG) -D node:fs -D node:process -D node:child_process -D node:crypto -o $@ qjsx-node-bootstrap.js

# Create convenience symlinks in bin/ directory
convenience-links: $(QJSX_PROG) $(QJSX_NODE_PROG) $(QJSXC_PROG)
	@mkdir -p bin
	@ln -sf $(PLATFORM)/qjsx $(QJSX_LINK)
	@ln -sf $(PLATFORM)/qjsx-node $(QJSX_NODE_LINK)
	@ln -sf $(PLATFORM)/qjsxc $(QJSXC_LINK)

# Build QuickJS by copying it to our bin dir and building it there
quickjs-deps: | $(BIN_DIR)
	@if [ ! -d "$(BIN_DIR)/quickjs" ]; then \
		echo "Copying QuickJS to $(BIN_DIR)/quickjs..."; \
		cp -r quickjs $(BIN_DIR)/quickjs; \
	fi
	$(MAKE) -C $(BIN_DIR)/quickjs .obj/quickjs.o .obj/libregexp.o .obj/libunicode.o .obj/cutils.o .obj/dtoa.o .obj/repl.o libquickjs.a

# Clean build artifacts
clean:
	rm -rf $(BIN_DIR)

# Clean all platforms
clean-all:
	rm -rf bin/

# Test targets
test: $(QJSX_PROG) $(QJSX_NODE_PROG) $(QJSXC_PROG)
	@echo "Running QJSX test suite..."
	QJSX_BIN_DIR=$(BIN_DIR) ./tests/run_all.sh

test-qjsxpath: $(QJSX_PROG)
	QJSX_BIN_DIR=$(BIN_DIR) ./tests/test_qjsxpath.sh

test-index: $(QJSX_PROG)
	QJSX_BIN_DIR=$(BIN_DIR) ./tests/test_index_resolution.sh

test-qjsx-node: $(QJSX_NODE_PROG)
	QJSX_BIN_DIR=$(BIN_DIR) ./tests/test_qjsx_node.sh

test-qjsxc: $(QJSXC_PROG)
	QJSX_BIN_DIR=$(BIN_DIR) ./tests/test_qjsxc.sh

test-qjsxc-dynamic: $(QJSXC_PROG)
	QJSX_BIN_DIR=$(BIN_DIR) ./tests/test_qjsxc_dynamic.sh

test-import-meta: $(QJSX_PROG)
	QJSX_BIN_DIR=$(BIN_DIR) ./tests/test_import_meta.sh

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

.PHONY: all build clean clean-all install help quickjs-deps test test-qjsxpath test-index test-qjsx-node test-qjsxc test-qjsxc-dynamic convenience-links
