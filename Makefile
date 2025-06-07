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
CFLAGS_OPT = $(CFLAGS) -O2 -flto
LDFLAGS = -g -flto -rdynamic
LIBS = -lm -ldl -lpthread

# Build directories
BIN_DIR = bin
OBJ_DIR = $(BIN_DIR)/obj

# Program name
QJSX_PROG = $(BIN_DIR)/qjsx

# QuickJS object files (built by QuickJS)
QUICKJS_OBJS = $(QUICKJS_DIR)/.obj/quickjs.o $(QUICKJS_DIR)/.obj/libregexp.o \
               $(QUICKJS_DIR)/.obj/libunicode.o $(QUICKJS_DIR)/.obj/cutils.o \
               $(QUICKJS_DIR)/.obj/quickjs-libc.o $(QUICKJS_DIR)/.obj/dtoa.o \
               $(QUICKJS_DIR)/.obj/repl.o

# Default target
all: $(QJSX_PROG)

# Create directories
$(BIN_DIR):
	mkdir -p $(BIN_DIR)

$(OBJ_DIR):
	mkdir -p $(OBJ_DIR)

# Build qjsx executable
$(QJSX_PROG): $(OBJ_DIR)/qjsx.o quickjs-deps | $(BIN_DIR)
	$(CC) $(LDFLAGS) -o $@ $(OBJ_DIR)/qjsx.o $(QUICKJS_OBJS) $(LIBS)

# Build qjsx.o from our source
$(OBJ_DIR)/qjsx.o: qjsx.c | $(OBJ_DIR)
	$(CC) $(CFLAGS_OPT) -I$(QUICKJS_DIR) -c -o $@ $<

# Build QuickJS dependencies
quickjs-deps:
	$(MAKE) -C $(QUICKJS_DIR) all

# Clean our build artifacts
clean:
	rm -rf $(BIN_DIR)

# Clean everything including QuickJS
clean-all: clean
	$(MAKE) -C $(QUICKJS_DIR) clean

# Test target
test: $(QJSX_PROG)
	@echo "Testing QJSX with QJSXPATH..."
	QJSXPATH=./test_modules $(QJSX_PROG) examples/test_qjsxpath.js
	@echo "✅ Test successful!"

# Build everything (QuickJS + qjsx)
build: quickjs-deps all

# Install qjsx
install: $(QJSX_PROG)
	mkdir -p "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QJSX_PROG) "$(DESTDIR)$(PREFIX)/bin"

# Help target
help:
	@echo "QJSX Makefile targets:"
	@echo "  all         - Build qjsx executable"
	@echo "  build       - Build QuickJS dependencies and qjsx"
	@echo "  test        - Run QJSXPATH tests"
	@echo "  clean       - Clean qjsx build artifacts"
	@echo "  clean-all   - Clean everything including QuickJS"
	@echo "  install     - Install qjsx to \$$(PREFIX)/bin"
	@echo ""
	@echo "Usage examples:"
	@echo "  make build && make test"
	@echo "  QJSXPATH=./my_modules ./bin/qjsx script.js"

.PHONY: all build clean clean-all install help quickjs-deps test