# QuickJS-x

QuickJS-x is [QuickJS](https://bellard.org/quickjs) with a few, additional features patched in:

1. Custom module loader implementing `QJSXPATH` (like `NODE_PATH`) resolution, to specify additional paths for imports.

2. Node.js-style `index.js` resolution for all imports:

	`... from "./module_dir"` → `... from "./module_dir/index.js"`

3. Colon-to-slash translation (useful for our Node.js shim):

	`... from "node:fs"` → `... from "node/fs"`

4. We add `import.meta.dirname` and `import.meta.filename`.

5. We also provide an additional binary `qjsx-node`, making a small subset of the Node.js standard library available (e.g. parts of `node:fs`, `node:child_process`, see `qjsx-node` directory).

All original QuickJS features are preserved.


### Build
Building QuickJS-x, like QuickJS, should take less than a minute.

```bash
git clone --recurse-submodules https://github.com/rmst/quickjs-x.git
cd quickjs-x
make build  # Builds ./bin/qjsx, ./bin/qjsx-node, and ./bin/qjsxc
```


### Usage

**Basic JavaScript execution like QuickJS**
```bash
./bin/qjsx script.js
```

**Module resolution with QJSXPATH**
```bash
# script.js can import all modules in ./mymodules and ./lib.
QJSXPATH=./my_modules:./lib ./bin/qjsx script.js
```

This works like `NODE_PATH` in Node.js. `QJSXPATH` enables bare module imports (e.g., `import foo from "foo"`) by specifying search directories.

**With Node.js compatibility modules**
```bash
./bin/qjsx-node script.js
```

`script.js` can use a subset of node:fs, node:child_process, etc (see `qjsx-node/node`)


### Building Standalone Applications

`qjsxc` can be used to compile JavaScript applications into standalone executables with embedded modules.

#### Basic Usage
```bash
# Compile an application and embeddes all modules imported by main.js
QJSXPATH=./my_modules ./bin/qjsxc -o my-app main.js

# The resulting binary is a standalone executable
./my-app                          # (runs your application)
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
The following files are used to compile the `qjsx` binary:

- `qjsx.patch` is applied to `quickjs/qjs.c`
- `qjsxc.patch` is applied to `quickjs/qjsc.c`
- `quickjs-libc.patch` is applied to `quickjs/quickjs-libc.c`
- `qjsx-module-resolution.h` contains shared module resolution logic for QJSXPATH support, etc
