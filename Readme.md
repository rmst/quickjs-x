# Qn

(*experimental – not recommended for production*)

Qn is a lightweight JavaScript runtime built on [QuickJS](https://bellard.org/quickjs) and [libuv](https://libuv.org). It provides a subset of the Node.js API. Not every Node.js program will run on qn, but every qn program using only the `node:*` API should run on Node.js without modification.

|                            | qn                                     | Node.js                          | Bun                        |
|----------------------------|----------------------------------------|----------------------------------|----------------------------|
| JavaScript engine          | QuickJS (interpreter)                  | V8 (JIT)                         | JavaScriptCore (JIT)       |
| Binary size                | ~4 MB                                  | ~90 MB                           | ~50 MB                     |
| Build from source          | C compiler + `make`                    | GCC/Clang, Python, GN, Ninja, …  | Zig                        |
| Node.js API                | subset ([details](node/node-compatibility.md)) | reference                | most                       |
| TypeScript                 | built-in (strip + Sucrase)             | experimental strip (v22+)        | built-in                   |
| Module resolution          | Node ESM + bundler mode ([docs](module_resolution/Readme.md)) | Node ESM       | Node ESM                   |
| Bundler                    | `qn build`                             | —                                | `bun build`                |
| Watch mode                 | `qn --watch`                           | `node --watch`                   | `bun --watch`              |
| Package installer          | `qn install`                           | separate (`npm`)                 | `bun install`              |
| Standalone binary          | `qnc`                                  | `--experimental-sea`             | `bun build --compile`      |
| Shell scripting            | `qx` (zx-like)                         | —                                | built-in `$`               |
| PTY                        | `qn:pty`                               | via `node-pty` addon             | —                          |
| Closure introspection      | `qn:introspect`                        | —                                | —                          |

For a code architecture comparison with Node.js and txiki.js, see [comparison.md](comparison.md).


### Build
Building Qn, like QuickJS, should take less than a minute.

```bash
git clone --recurse-submodules https://github.com/rmst/qn.git
cd qn
make build             # builds ./bin/{qn,qx,qnc}
make install           # optional; installs to /usr/local/bin (override with PREFIX=~/.local)
```

Examples below assume the binaries are on your `PATH`. Without `make install`, prefix them with `./bin/` or add that directory to `PATH`.


### Usage

**Run a script**
```bash
qn script.js    # JavaScript
qn script.ts    # TypeScript (types stripped on load)
```

TypeScript files are transparently transformed. Type annotations are stripped while preserving source positions for accurate error messages.

**Module resolution with NODE_PATH**
```bash
NODE_PATH=./my_modules:./lib qn script.js
```

`NODE_PATH` enables bare module imports (e.g., `import foo from "foo"`) by specifying search directories. Standard `node_modules` walking with `package.json` resolution is also supported.

**Shell scripting (qx)**
```bash
qx script.js  # zx-compatible shell scripting with $ function
```

**Bundle a web frontend**
```bash
qn build src/main.tsx --outdir=dist --jsx-import-source=preact
```

Walks static imports from an entry point, transforms TS/JSX via Sucrase, resolves `node_modules` with `package.json` exports, and emits a single self-contained JS file. Side-effect CSS imports such as `import "./component.css"` are discovered through the same graph and emitted as a sibling stylesheet, e.g. `dist/main.css`; include it with a normal `<link rel="stylesheet" href="./main.css">`. No tree shaking or minification. Roughly Bun.build-compatible for simple cases.

**Watch mode** (re-run on file change)
```bash
qn --watch script.js
```

Runs the script, then restarts it whenever any file in its import graph changes. The graph is traced statically via `qn:bundle`'s `traceModuleGraph`, so `.js`, `.ts`, `.json`, `.css`, and literal-dynamic `import()` are all tracked. Computed dynamic imports aren't.


### Building Standalone Applications

`qnc` compiles JavaScript applications into standalone executables with embedded modules.

```bash
# Compile an application and embed all modules imported by main.js
NODE_PATH=./my_modules qnc -o my-app main.js

# The resulting binary is a standalone executable
./my-app
```

Use the `-D` flag to embed modules that aren't directly imported but should be available to dynamically loaded scripts:

```bash
NODE_PATH=./libs qnc -D utils -D config -o runtime bootstrap.js
./runtime external-script.js      # Can use import { ... } from "utils"
```

This is how `qn` itself is built: a minimal bootstrap with all node modules embedded using `-D` flags, creating a single native executable.


### Architecture

See [architecture.md](architecture.md) for codebase structure.

Key source files:

- `libuv/` — C modules for libuv integration (event loop, streams, fs, process, DNS, signals)
- `node/node/` — Node.js API shims in JS
- `node/qn/` — qn-specific modules (`qn:http`, libuv JS wrappers)
- `qnc/` — standalone compiler (main.c, embed.c for self-extracting support files, pack.c for build-time packing)
- `module_resolution/module-resolution.h` — shared module resolution logic
- `quickjs.patch` — applied to `quickjs/quickjs.c` (import error locations)
- `quickjs-libc.patch` — applied to `quickjs/quickjs-libc.c` (`import.meta.dirname/filename`, UTF-8 helpers)
