import * as std from 'std';
import * as os from 'os';

// Process object that mimics Node.js process module
const process = {
  // Command line arguments
  argv: [...scriptArgs],  // TODO: maybe we have to unwrap these
  
  // Environment variables
  env: std.getenviron(),  // TODO: make this function call (via getter / setter / proxy)
  
  // Process control
  exit: std.exit,
  
  // Current working directory
  cwd: () => os.getcwd ? os.getcwd()[0] : '.',
  
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
export const { argv, env, exit, cwd, pid, platform, version, versions } = process;