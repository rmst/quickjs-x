# Module Resolution

Shared module resolution for the qn interpreter, the qnc compiler, and standalone compiled binaries. Implemented in `module-resolution.h`.

## Design invariant

qn and qnc must select the same module for the same importer, specifier, environment, and filesystem. Both therefore call `qn_module_normalizer`; qnc does not maintain a JavaScript copy of path, package, or extension resolution. Environment-specific policy can be supplied through resolver-context callbacks: currently qn and qnc both use this only for the final tsconfig/jsconfig `paths` fallback, after normal package and filesystem lookup. Compile mode also reports canonical resolutions through a callback so qnc can generate the standalone import map.

Keep core resolution changes in `module-resolution.h` and cover them in `qnc-parity.test.js`. This prevents the interpreter and compiler from drifting while leaving source transforms and build orchestration in JavaScript.

## Import Specifiers

| Type | Example | How it resolves |
|------|---------|-----------------|
| **Bare** | `lodash`, `node:fs` | NODE_PATH dirs, then `node_modules` walking |
| **Relative** | `./foo`, `../bar` | Against importing module's directory |
| **Absolute** | `/path/to/foo` | Used directly |

## Resolution Steps

### 1. Colon-to-slash translation

`node:fs` becomes `node/fs`. This lets NODE_PATH handle Node.js-style module specifiers without any special cases.

### 2. Bare import resolution

Tried in order until one succeeds:

1. **NODE_PATH**: search each directory in the `NODE_PATH` environment variable for the exact name, `.js`, `.ts`, `/index.js`, and `/index.ts`
2. **node_modules walking**: walk up from the importing file, check `node_modules/<pkg>/` with `package.json` resolution (`exports` field with subpath and conditional support, then `main` field)
3. **Extension probing** (bundler mode only): try the exact name, `.js`, `.ts`, `/index.js`, and `/index.ts`
4. **Policy fallback**: consult tsconfig/jsconfig `paths` and `baseUrl`

### 3. Filesystem path resolution

For relative and absolute imports:

1. Resolve `./` and `../` against the importing module's directory
2. **Extension probing** (bundler mode only): try `.js`, `.ts`, `/index.js`, and `/index.ts`
3. **Symlink resolution**: `realpath()` to canonical path

Relative imports resolve against the **real location** (after symlink resolution) of the importing file, matching Node.js ESM behavior.

## Resolution Modes

**Bundler mode** (default): extension probing enabled, more lenient.

**Node mode** (`QN_MODULE_RESOLUTION=node`): explicit extensions are required and NODE_PATH lookup is disabled, matching Node.js ESM resolution more closely. `node_modules` package resolution and colon-to-slash translation still apply.


## Standalone Compiled Binaries

`qnc` compiles JavaScript into standalone executables. All imported modules are embedded in the binary. The module resolution system handles three distinct contexts:

### Namespaces

Embedded and disk modules live in separate namespaces in QuickJS's module cache:

- `embedded://lib/utils.js` — an embedded module
- `/home/user/lib/utils.js` — a disk module

These can never collide, even if they refer to the same original file.

### Compile time (qnc)

The compiler resolves all imports on the filesystem and assigns each module an `embedded://` prefixed name:

- **CWD-relative paths**: files under the working directory get short names like `embedded://lib/utils.js` (the CWD prefix is stripped after `realpath`)
- **Absolute paths**: files outside CWD keep their full path, e.g. `embedded:///opt/shared/lib.js`
- **C modules** (`std`, `os`): kept as plain names without the prefix

An **import map** records every filesystem-backed `(importer, specifier)` resolution. Bare and absolute imports inherently require it; relative imports are also recorded because extension probing, symlink canonicalization, or CWD-relativization can produce a name that runtime path arithmetic cannot reconstruct after the source tree has been removed.

### Runtime (standalone binary)

When a standalone binary resolves an import, it proceeds in this order:

1. **`file://` protocol**: `import("file:///path/to/mod.js")` strips the prefix and forces disk loading, bypassing the embedded namespace entirely
2. **Import map**: if the importer is embedded, look up the `(base, specifier)` pair — this handles bare imports and other compile-time-only resolutions
3. **`embedded://<input>` fallback**: for bare imports (from any base), check import map entries recorded from `-D` flags — this lets dynamically loaded disk scripts access embedded modules
4. **Embedded list**: for filesystem path imports from an embedded base, check if the resolved name exists in the embedded module list
5. **Disk fallback**: resolve on the filesystem via NODE_PATH, node_modules, or realpath

### The `-D` flag

`-D <name>` embeds a module not directly imported by the entry point, making it available to dynamically loaded scripts at runtime. See [qnc.md](../qnc.md) for details.

### The `file://` protocol

Embedded code can force disk loading with the `file://` prefix:

```js
// From inside an embedded module:
const mod = await import("file:///path/to/plugin.js")
```

This is necessary because embedded importers check the embedded namespace first for filesystem path imports. Without `file://`, a disk file at a path matching an embedded module name would be shadowed by the embedded version.

The `qn` bootstrap uses `file://` when loading user scripts to prevent this shadowing.

## Native Module Embedding

When qnc encounters a `.so` import, it can automatically compile the native C sources and statically link them into the binary. At runtime, `import ... from './sqlite_native.so'` resolves to the embedded module — no dlopen, no `.so` file needed.

See [qnc.md](../qnc.md) for the full specification: package structure, `package.json` `"qnc"` field format, symbol collision handling, and the `--link`/`-M` flags.

## Debugging

```bash
QN_MODULE_DEBUG=1 ./bin/qn script.js
```

Shows normalizer inputs, realpath results, import map hits, and final resolved names.
