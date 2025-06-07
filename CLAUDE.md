# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Goals

This repo provides QJSX - QuickJS with Node.js-style module resolution via QJSXPATH. Set `QJSXPATH=./my_modules:./lib` and import bare module names like `import foo from "foo"` which resolves to `./my_modules/foo/index.js`, `./my_modules/foo.js`, or `./my_modules/foo`.

## Project Architecture

This is quickjs-x, a fork of the QuickJS JavaScript engine that extends it with a subset of the Node.js API and ES6 import mechanisms. The project maintains the core QuickJS architecture while adding Node.js compatibility features.

### Core Components

- **quickjs/**: Contains the main QuickJS engine source code (C/C++)
  - `quickjs.c/.h`: Core JavaScript engine implementation
  - `quickjs-libc.c/.h`: Standard library bindings (std, os modules)
  - `qjs.c`: Main interpreter executable
  - `qjsc.c`: JavaScript-to-C compiler
  - `repl.js`: Read-eval-print loop implementation

- **Standard Modules**:
  - `std`: Standard I/O, file operations, sprintf functionality
  - `os`: Operating system interface and utilities


### Development Commands

```bash
# Build QJSX (builds QuickJS dependencies + qjsx)
make build

# Test QJSXPATH functionality  
make test

# Clean QJSX build artifacts
make clean

# Clean everything including QuickJS
make clean-all

# Install qjsx executable  
make install

# Show help
make help
```

### Key Executables

- **`qjsx`**: Enhanced JavaScript interpreter with QJSXPATH module resolution
- `qjs`: Original QuickJS interpreter (in quickjs/ directory)


### QJSXPATH Module Resolution

QJSX extends QuickJS with Node.js-style module resolution:

**Environment Variable**: Set `QJSXPATH` to colon-separated module search paths
**Resolution Strategy** for bare imports like `import foo from "foo"`:
1. `$QJSXPATH/foo/index.js`
2. `$QJSXPATH/foo.js` 
3. `$QJSXPATH/foo` (if file exists)

**Example**:
```bash
QJSXPATH=./my_modules:./lib ./qjsx script.js
```

**Fallback**: Relative/absolute imports work normally (`./`, `../`, `/`)