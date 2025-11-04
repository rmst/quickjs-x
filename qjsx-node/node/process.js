import * as std from 'std';
import * as os from 'os';

// Create stream-like objects for stdin, stdout, stderr
const createStream = (fd) => {
  const stream = {
    fd,
    get isTTY() {
      return os.isatty(fd);
    }
  };

  // Add write method for stdout and stderr
  if (fd === 1 || fd === 2) {
    stream.write = function(data, encoding, callback) {
      // Handle optional encoding parameter
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = 'utf8';
      }
      encoding = encoding || 'utf8';

      try {
        const file = fd === 1 ? std.out : std.err;
        file.puts(String(data));
        file.flush();
        if (callback) callback();
        return true;
      } catch (err) {
        if (callback) callback(err);
        return false;
      }
    };
  }

  return stream;
};

// Event handlers storage
const eventHandlers = new Map();

// Signal name to number mapping
const signalMap = {
  'SIGINT': os.SIGINT,
  'SIGTERM': os.SIGTERM,
  'SIGABRT': os.SIGABRT,
  'SIGFPE': os.SIGFPE,
  'SIGILL': os.SIGILL,
  'SIGSEGV': os.SIGSEGV
};

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

  // Standard streams
  stdin: createStream(0),
  stdout: createStream(1),
  stderr: createStream(2),

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
  },

  // Event emitter methods for signal handling
  on(event, handler) {
    if (!eventHandlers.has(event)) {
      eventHandlers.set(event, []);
    }
    eventHandlers.get(event).push(handler);

    // Register signal handler with os.signal if it's a signal event
    const signum = signalMap[event];
    if (signum !== undefined) {
      // Only register if this is the first handler for this signal
      if (eventHandlers.get(event).length === 1) {
        os.signal(signum, () => {
          const handlers = eventHandlers.get(event);
          if (handlers) {
            handlers.forEach(h => h());
          }
        });
      }
    }

    return this;
  },

  removeAllListeners(event) {
    if (event) {
      eventHandlers.delete(event);
      // Restore default signal handler
      const signum = signalMap[event];
      if (signum !== undefined) {
        os.signal(signum, null);
      }
    } else {
      // Remove all event handlers
      for (const [evt] of eventHandlers) {
        this.removeAllListeners(evt);
      }
    }
    return this;
  }
};

// Export as default for `import process from 'node:process'`
export default process;

// Also export individual properties for named imports
export const { argv, exit, cwd, pid, platform, version, versions, stdin, stdout, stderr } = process;
export const env = process.env;  // Export env separately to preserve the Proxy