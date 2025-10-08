# qjsx-node

Standalone QuickJS executable with embedded Node.js-compatible modules.

## Building

Built automatically via `make build`. The build:
- Compiles `qjsx-node-bootstrap.js` with `qjsxc`
- Embeds all modules from `qjsx-node/node/` directory
- Uses `QJSXPATH=./qjsx-node` for module resolution

Note: `node:*` imports (e.g., `node:fs`, `node:process`) are normalized to `node/*` paths, so QJSXPATH must point to the parent directory containing the `node/` folder.

## Usage

```bash
./bin/qjsx-node script.js
```

The executable includes built-in support for:
- `node:fs` - File system operations
- `node:process` - Process information
- `node:child_process` - Child process spawning
- `node:crypto` - Cryptographic operations
