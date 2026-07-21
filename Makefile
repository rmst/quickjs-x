#
# Qn Makefile
#
# Builds qn, qx, and qnc executables
#

VERSION = 2024-01-13

# Install prefix (override with: make install PREFIX=~/.local)
PREFIX ?= /usr/local

# Platform detection (used for build dirs and conditional flags)
PLATFORM := $(shell uname -s | tr '[:upper:]' '[:lower:]')

# Compiler settings
CC = gcc
CFLAGS = -Wall -Wno-array-bounds -fwrapv \
         -D_GNU_SOURCE -DCONFIG_VERSION='"$(VERSION)"' -DCONFIG_BIGNUM

# GCC-specific warning flags (Clang doesn't support these)
ifneq (,$(findstring gcc,$(shell $(CC) --version 2>/dev/null)))
CFLAGS += -Wno-format-truncation
endif

# Sandbox support (comment out to disable if upstream QuickJS breaks compatibility)
CFLAGS += -DUSE_SANDBOX

CFLAGS_OPT = $(CFLAGS) -O2

# Build directories (can be overridden: make BIN_DIR=/tmp/build)
BIN_DIR ?= bin/$(PLATFORM)

# Program names
QN_PROG = $(BIN_DIR)/qn
QX_PROG = $(BIN_DIR)/qx
QNC_PROG = $(BIN_DIR)/qnc

# Convenience symlinks
QN_LINK = bin/qn
QX_LINK = bin/qx
QNC_LINK = bin/qnc

# Default target
all: $(QN_PROG) $(QX_PROG) $(QNC_PROG) convenience-links

# Create directories
$(BIN_DIR):
	mkdir -p $(BIN_DIR)

$(BIN_DIR)/obj:
	mkdir -p $(BIN_DIR)/obj

# Build qnc (JS-based compiler, self-contained binary)
# qnc is a small C wrapper that extracts embedded support files and execs
# qjs to run qnc.js. The qnc-pack tool appends the archive at build time.
QJS_PROG = $(BIN_DIR)/quickjs/qjs
QNC_ENGINE = $(BIN_DIR)/qnc-engine.so
QNC_PACK = $(BIN_DIR)/qnc-pack

# All sources packed into qnc (JS, C, H, package.json).
# $(shell find ...) is re-evaluated every make invocation, catching new/removed files.
QNC_EMBED_SOURCES := $(shell find node/ qx/ vendor/ws/ -name '*.js' -o -name '*.c' -o -name '*.h' -o -name 'package.json') \
                     $(shell find libuv/ -name '*.c' -o -name '*.h') \
                     $(shell find vendor/libuv/include -name '*.h') \
                     $(shell find vendor/miniz -maxdepth 1 \( -name 'miniz*.c' -o -name 'miniz*.h' \)) \
                     $(shell find vendor/miniz_shim/ -name '*.h') \
                     $(shell find quickjs/ -name '*.c' -o -name '*.h') \
                     module_resolution/module-resolution.h exit-handler.h \
                     introspect/introspect.h sandboxed-worker/sandboxed-worker.h

# Build vanilla qjs from upstream QuickJS (for bootstrapping qnc.js)
$(QJS_PROG): $(BIN_DIR)/quickjs/.patched
	$(MAKE) -C $(BIN_DIR)/quickjs qjs

# Build qnc-engine.so native module (bytecode compilation API for JS)
QNC_ENGINE_LDFLAGS = -shared
ifeq ($(PLATFORM),darwin)
QNC_ENGINE_LDFLAGS += -undefined dynamic_lookup
endif
$(QNC_ENGINE): qnc/engine.c module_resolution/module-resolution.h $(BIN_DIR)/quickjs/.patched | $(BIN_DIR)
	$(CC) -Wall -O2 -fPIC $(QNC_ENGINE_LDFLAGS) -D_GNU_SOURCE -I. -I$(BIN_DIR)/quickjs -o $@ $<

# Build qnc-pack tool (used at build time to embed support files)
$(QNC_PACK): qnc/pack.c qnc/embed.h | $(BIN_DIR)
	$(CC) $(CFLAGS_OPT) -I. -o $@ $<

# Build qnc: compile wrapper, then pack all support files into it
$(QNC_PROG): qnc/wrapper.c qnc/embed.h $(QJS_PROG) $(QNC_ENGINE) qnc/qnc.js $(BIN_DIR)/obj/quickjs-libc.c $(QNC_PACK) $(QNC_EMBED_SOURCES) | $(BIN_DIR)
	$(CC) $(CFLAGS_OPT) -Iqnc -o $@ qnc/wrapper.c
	$(QNC_PACK) $@ \
		qjs:$(QJS_PROG) \
		qnc-engine.so:$(QNC_ENGINE) \
		qnc.js:qnc/qnc.js \
		quickjs.h:$(BIN_DIR)/quickjs/quickjs.h \
		quickjs-libc.h:$(BIN_DIR)/quickjs/quickjs-libc.h \
		cutils.h:$(BIN_DIR)/quickjs/cutils.h \
		list.h:$(BIN_DIR)/quickjs/list.h \
		module_resolution/module-resolution.h:module_resolution/module-resolution.h \
		exit-handler.h:exit-handler.h \
		introspect/introspect.h:introspect/introspect.h \
		introspect/introspect.c:introspect/introspect.c \
		sandboxed-worker/sandboxed-worker.h:sandboxed-worker/sandboxed-worker.h \
		sandboxed-worker/sandboxed-worker.c:sandboxed-worker/sandboxed-worker.c \
		$$(find $(BIN_DIR)/quickjs/ -name '*.h' | sed 's|$(BIN_DIR)/||; s|.*|&:$(BIN_DIR)/&|') \
		quickjs/quickjs.c:$(BIN_DIR)/quickjs/quickjs.c \
		quickjs/libregexp.c:$(BIN_DIR)/quickjs/libregexp.c \
		quickjs/libunicode.c:$(BIN_DIR)/quickjs/libunicode.c \
		quickjs/cutils.c:$(BIN_DIR)/quickjs/cutils.c \
		quickjs/dtoa.c:$(BIN_DIR)/quickjs/dtoa.c \
		quickjs/quickjs-libc.c:$(BIN_DIR)/obj/quickjs-libc.c \
		$$(find vendor/libuv/src -name '*.c' | sed 's|.*|&:&|') \
		$$(find vendor/libuv/include -name '*.h' | sed 's|.*|&:&|') \
		$$(find vendor/libuv/src -name '*.h' | sed 's|.*|&:&|') \
		$$(find libuv/ -name '*.c' -o -name '*.h' | sed 's|.*|&:&|') \
		$$(find vendor/miniz -maxdepth 1 \( -name 'miniz*.c' -o -name 'miniz*.h' \) | sed 's|.*|&:&|') \
		$$(find vendor/miniz_shim/ -name '*.h' | sed 's|.*|&:&|') \
		$$(find node/ qx/ vendor/ws/ vendor/sucrase-js/ vendor/bearssl/ \( -name '*.js' -o -name '*.c' -o -name '*.h' -o -name 'package.json' \) | sed 's|.*|js/&:&|')

# Patch quickjs-libc (adds import.meta.dirname, sandbox support, introspection)
$(BIN_DIR)/obj/quickjs-libc.c: quickjs/quickjs-libc.c quickjs-libc.patch introspect/introspect.patch | $(BIN_DIR)/obj
	patch -p0 < quickjs-libc.patch -o $@ quickjs/quickjs-libc.c
	patch -p0 < introspect/introspect.patch $@

# qnc includes all default modules (node:*, qn:*, qx, ws, etc.) automatically.
# Use --no-default-modules to build a minimal binary with only explicit -D modules.
QNC_FLAGS = --cache-dir $(BIN_DIR)/obj/qnc

# Version info embedded at build time
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
GIT_DIRTY := $(shell git diff --quiet 2>/dev/null && echo 0 || echo 1)
QNC_VERSION_ENV = QNC_GIT_COMMIT=$(GIT_COMMIT)
ifneq ($(GIT_DIRTY),0)
QNC_VERSION_ENV += QNC_GIT_DIRTY=1 QNC_BUILD_TIME=$(shell date -u +%Y-%m-%dT%H:%M:%SZ)
endif

# Build qn (qnc carries all embedded sources; rebuild triggers through $(QNC_PROG) dep)
$(QN_PROG): node/bootstrap.js $(QNC_PROG) | $(BIN_DIR)
	$(QNC_VERSION_ENV) $(QNC_PROG) $(QNC_FLAGS) -o $@ node/bootstrap.js

# Build qx (qnc carries all embedded sources; rebuild triggers through $(QNC_PROG) dep)
$(QX_PROG): qx/bootstrap.js $(QNC_PROG) | $(BIN_DIR)
	$(QNC_VERSION_ENV) $(QNC_PROG) $(QNC_FLAGS) -o $@ qx/bootstrap.js

# Create convenience symlinks in bin/ directory
convenience-links: $(QN_PROG) $(QX_PROG) $(QNC_PROG)
	@mkdir -p bin
	@ln -sf $(PLATFORM)/qn $(QN_LINK)
	@ln -sf $(PLATFORM)/qx $(QX_LINK)
	@ln -sf $(PLATFORM)/qnc $(QNC_LINK)

# Build QuickJS by copying it to our bin dir, patching, and building
# Uses a sentinel file to track when patch was applied, so changes to
# quickjs.patch trigger a re-copy and re-patch
$(BIN_DIR)/quickjs/.patched: quickjs.patch $(wildcard quickjs/*.c quickjs/*.h) | $(BIN_DIR)
	@echo "Copying QuickJS to $(BIN_DIR)/quickjs..."
	@rm -rf $(BIN_DIR)/quickjs
	@cp -r quickjs $(BIN_DIR)/quickjs
	@echo "Applying quickjs.patch..."
	@patch -p0 -d $(BIN_DIR) < quickjs.patch
	@touch $@

quickjs-deps: $(BIN_DIR)/quickjs/.patched

# Clean build artifacts
clean:
	find $(BIN_DIR) -name .DS_Store -delete 2>/dev/null; rm -rf $(BIN_DIR)

# Clean all platforms
clean-all:
	find bin/ -name .DS_Store -delete 2>/dev/null; rm -rf bin/

# Build everything (QuickJS + qn)
build: quickjs-deps all

# Install qn, qx, and qnc
install: $(QN_PROG) $(QX_PROG) $(QNC_PROG)
	mkdir -p "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QN_PROG) "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QX_PROG) "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QNC_PROG) "$(DESTDIR)$(PREFIX)/bin"

# Help target
help:
	@echo "Qn Makefile targets:"
	@echo "  all         - Build qn, qx, and qnc executables"
	@echo "  build       - Build QuickJS dependencies and all programs"
	@echo "  clean       - Clean build artifacts"
	@echo "  clean-all   - Clean everything including QuickJS"
	@echo "  install     - Install all programs to \$$(PREFIX)/bin"
	@echo ""
	@echo "Usage examples:"
	@echo "  make build"
	@echo "  ./bin/qn script.js     # Node.js-compatible runtime"
	@echo "  ./bin/qx script.js     # zx-compatible shell scripting"
	@echo "  NODE_PATH=./my_modules ./bin/qnc -o app.c app.js"

.PHONY: all build clean clean-all install help quickjs-deps convenience-links
