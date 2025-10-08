# quickjs-x

Quickjs with additional features


### Build

```bash
git clone --recurse-submodules https://github.com/rmst/quickjs-x.git
cd quickjs-x
make build  # Builds ./bin/qjsx and ./bin/qjsx-node
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

### Building Self-Extracting Applications

Use `qjsx-compile` to create portable, self-contained executables that embed both the qjsx runtime and your modules:

#### Basic Usage
```bash
# Create a self-contained runtime with your modules
./qjsx-compile bin/my-runtime my_modules/

# The resulting binary works like qjsx but with embedded modules
./bin/my-runtime script.js        # Run any script with access to embedded modules
./bin/my-runtime --help          # Show qjsx help
```

This creates a portable executable that contains qjsx + your modules. Scripts can import from the embedded modules using QJSXPATH resolution (e.g., `import utils from "utils"`).

#### Auto-Launching Applications
```bash
# Create an application that automatically runs a specific script
./qjsx-compile bin/my-app app_modules/ '%/main.js --production'

# The resulting binary is a complete application
./bin/my-app                     # Automatically runs main.js with --production flag
./bin/my-app extra args          # main.js gets extra args appended
```

The `%` placeholder expands to the temporary directory containing your extracted modules at runtime. This allows you to create single-file applications that automatically execute your main script with predefined arguments.