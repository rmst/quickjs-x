import * as std from 'std';
import * as os from 'os';

// Process object that mimics Node.js process module
const process = {
  // Command line arguments
  argv: [...scriptArgs],  // TODO: maybe we have to unwrap these
  
  // Environment variables - using Proxy to allow dynamic read/write
  env: new Proxy({}, {
    get: (_, p) => typeof p === 'string' ? std.getenv(p) : undefined,
    set: (_, p, v) => typeof p === 'string' ? (v == null ? std.unsetenv(p) : std.setenv(p, String(v)), true) : false,
    has: (_, p) => typeof p === 'string' && std.getenv(p) !== undefined,
    deleteProperty: (_, p) => typeof p === 'string' ? (std.unsetenv(p), true) : false,
    ownKeys: () => Object.keys(std.getenviron()),
    getOwnPropertyDescriptor: (_, p) => typeof p === 'string' && std.getenv(p) !== undefined ? 
      { configurable: true, enumerable: true, value: std.getenv(p) } : undefined
  }),
  
  // Process control
  exit: std.exit,
  
  // Current working directory
  cwd: () => {
    let [dir, error] = os.getcwd()
    if(error != 0)
      throw Error(`Couldn't get working directory`)

    return dir
  },
    
  // Process ID (not available in QuickJS, return dummy value)
  pid: 1,
  
  // Platform
  platform: os.platform || 'quickjs',
  
  // Node version (return QuickJS version as placeholder)
  version: 'v1.0.0-quickjs',
  
  // Versions object
  versions: {
    node: '1.0.0-quickjs',
    quickjs: '1.0.0'
  }
};

// Export as default for `import process from 'node:process'`
export default process;

// Also export individual properties for named imports
export const { argv, exit, cwd, pid, platform, version, versions } = process;
export const env = process.env;  // Export env separately to preserve the Proxy