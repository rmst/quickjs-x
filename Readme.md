# quickjs-x

Quickjs with additional features


### Build

```bash
git clone --recurse-submodules https://github.com/rmst/quickjs-x.git
cd quickjs-x
make build  # Builds ./bin/qjsx, ./bin/qjsx-node, and ./bin/qjsxc
```

You can build in an alternative directory:
```bash
make BIN_DIR=/tmp/qjsx-build build
```

### Usage

**Basic JavaScript execution:**
```bash
./bin/qjsx script.js
```

**With Node.js compatibility modules:**
```bash
./bin/qjsx-node script.js  # Self-contained executable with node:fs, node:child_process
```

**Module resolution with QJSXPATH:**
```bash
QJSXPATH=./my_modules:./lib ./bin/qjsx app.js
```

Similar to Node.js's `NODE_PATH`, QJSXPATH enables bare module imports (e.g., `import foo from "foo"`) by specifying search directories.

### Building Standalone Applications

Use `qjsxc` to compile JavaScript applications into standalone native executables with embedded modules.

#### Basic Usage
```bash
# Compile an application with embedded modules
QJSXPATH=./my_modules ./bin/qjsxc -o my-app main.js

# The resulting binary is a standalone executable
./my-app                          # Run your application
```

#### Embedding Additional Modules
Use the `-D` flag to embed modules that aren't directly imported but should be available to dynamically loaded scripts:

```bash
# Embed modules for dynamic loading
QJSXPATH=./libs ./bin/qjsxc -D utils -D config -o runtime bootstrap.js

# External scripts can now import these modules
./runtime external-script.js      # Can use import { ... } from "utils"
```

This is how `qjsx-node` is built - it compiles a minimal bootstrap with all node modules embedded using `-D` flags, creating a single native executable that can run any script with Node.js compatibility.

### Architecture

QJSX uses a minimal patch-based approach to extend QuickJS with QJSXPATH module resolution:

- **`qjsx.patch`**: Patch applied to `quickjs/qjs.c` during build
- **`qjsxc.patch`**: Patch applied to `quickjs/qjsc.c` during build
- **`quickjs-libc.patch`**: Patch applied to `quickjs/quickjs-libc.c` during build
- **`qjsx-module-resolution.h`**: Shared module resolution logic for QJSXPATH support

The patches add:
1. Custom module loader (`qjsx_loader`) that implements QJSXPATH resolution
2. Node.js-style index.js resolution for all imports
3. Colon-to-slash translation (e.g., `node:fs` → `node/fs`)
4. `import.meta.dirname` and `import.meta.filename`

All original QuickJS features are preserved. The generated files maintain full compatibility with upstream QuickJS.
