import * as std from 'std';
import { signal as uvSignal, signals as signalMap } from 'qn_uv_signals';
import {
	isatty as _isatty, ttyGetWinSize as _ttyGetWinSize,
	getCwd as _getCwd, chdir as _chdir,
	kill as _kill, getPid as _getPid, getPlatform as _getPlatform,
	getArch as _getArch, getExecPath as _getExecPath,
	getuid as _getuid, getgid as _getgid, getgroups as _getgroups,
	setuid as _setuid, setgid as _setgid, setgroups as _setgroups,
	hrtimeBigInt as _hrtimeBigInt,
} from 'qn_vm';

const NS_PER_SEC = 1_000_000_000n

// process.hrtime([prev]) → [seconds, nanoseconds]
// process.hrtime.bigint() → bigint nanoseconds
const hrtime = (prev) => {
	const ns = _hrtimeBigInt()
	const sec = Number(ns / NS_PER_SEC)
	const nsec = Number(ns % NS_PER_SEC)
	if (prev !== undefined) {
		if (!Array.isArray(prev) || prev.length !== 2) {
			throw new TypeError('process.hrtime() argument must be an Array tuple')
		}
		let dsec = sec - prev[0]
		let dnsec = nsec - prev[1]
		if (dnsec < 0) {
			dsec -= 1
			dnsec += 1e9
		}
		return [dsec, dnsec]
	}
	return [sec, nsec]
}
hrtime.bigint = () => _hrtimeBigInt()

// Create stream-like objects for stdin, stdout, stderr
const createStream = (fd) => {
  const stream = {
    fd,
    get isTTY() {
      return _isatty(fd);
    },
    get columns() {
      if (!_isatty(fd)) return undefined
      const size = _ttyGetWinSize(fd)
      return size ? size[0] : undefined
    },
    get rows() {
      if (!_isatty(fd)) return undefined
      const size = _ttyGetWinSize(fd)
      return size ? size[1] : undefined
    },
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
// Active uv_signal_t handles per signal name
const signalHandles = new Map();

// Process object that mimics Node.js process module
const process = {
  // Command line arguments
  argv: [...scriptArgs],  // TODO: maybe we have to unwrap these

  // Absolute path to the interpreter executable
  execPath: _getExecPath(),

  // Exit code - synced with globalThis.__qn_exitCode for C-level exit handler
  get exitCode() {
    return globalThis.__qn_exitCode || 0;
  },
  set exitCode(code) {
    globalThis.__qn_exitCode = code;
  },

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
  exit(code) {
    (eventHandlers.get('exit') || []).forEach(h => { try { h(code ?? 0); } catch {} });
    std.exit(code ?? 0);
  },

  // Current working directory
  cwd: () => _getCwd(),

  // Change working directory
  chdir: (directory) => {
    try {
      _chdir(directory)
    } catch (e) {
      const err = new Error(`ENOENT: no such file or directory, chdir '${directory}'`)
      err.code = 'ENOENT'
      err.syscall = 'chdir'
      err.path = directory
      throw err
    }
  },

  // Send signal to a process
  kill(pid, signal = 'SIGTERM') {
    const sig = typeof signal === 'string' ? signalMap[signal] : signal
    if (sig === undefined) {
      throw new Error(`Unknown signal: ${signal}`)
    }
    try {
      _kill(pid, sig)
    } catch (e) {
      const err = new Error(`kill ${pid}`)
      err.code = e.code || `E${-e.errno}`
      err.errno = e.errno
      err.syscall = 'kill'
      throw err
    }
    return true
  },

  // Standard streams
  stdin: createStream(0),
  stdout: createStream(1),
  stderr: createStream(2),

  // Process ID
  get pid() {
    return _getPid();
  },

  // High-resolution time
  hrtime,

  // User and group IDs
  getuid: () => _getuid(),
  getgid: () => _getgid(),
  getgroups: () => _getgroups(),
  setuid: (id) => _setuid(id),
  setgid: (id) => _setgid(id),
  setgroups: (groups) => _setgroups(groups),

  // Platform and architecture
  platform: _getPlatform(),
  arch: _getArch(),

  // Node version (return QuickJS version as placeholder)
  version: 'v1.0.0-quickjs',

  // Versions object
  versions: {
    node: '1.0.0-quickjs',
    quickjs: '1.0.0'
  },

  // Event emitter methods for signal and exit handling
  on(event, handler) {
    if (!eventHandlers.has(event)) {
      eventHandlers.set(event, []);
    }
    eventHandlers.get(event).push(handler);

    // Register exit handler with C runtime
    if (event === 'exit') {
      globalThis.__qn_exitHandler = (code) => {
        const handlers = eventHandlers.get('exit');
        if (handlers) [...handlers].forEach(h => {
          try { h(code); } catch (e) { console.error(e); }
        });
      };
    }

    // Register signal handler via libuv if it's a signal event
    const signum = signalMap[event];
    if (signum !== undefined) {
      // Only register if this is the first handler for this signal
      if (eventHandlers.get(event).length === 1) {
        const handle = uvSignal(signum, () => {
          const handlers = eventHandlers.get(event);
          if (handlers) {
            handlers.forEach(h => { try { h(); } catch (e) { console.error(e); } });
          }
        });
        signalHandles.set(event, handle);
      }
    }

    return this;
  },

  nextTick(callback, ...args) {
    if (typeof callback !== 'function') {
      throw new TypeError('Callback must be a function')
    }
    queueMicrotask(() => callback(...args))
  },

  once(event, handler) {
    const wrapper = (...args) => {
      this.removeListener(event, wrapper);
      handler(...args);
    };
    wrapper._originalListener = handler;
    return this.on(event, wrapper);
  },

  removeListener(event, handler) {
    const handlers = eventHandlers.get(event);
    if (!handlers) return this;
    const index = handlers.findIndex(
      h => h === handler || h._originalListener === handler
    );
    if (index !== -1) {
      handlers.splice(index, 1);
      // If no more handlers for this signal, close the uv handle
      if (handlers.length === 0) {
        const handle = signalHandles.get(event);
        if (handle) {
          handle.close();
          signalHandles.delete(event);
        }
      }
    }
    return this;
  },

  off(event, handler) {
    return this.removeListener(event, handler);
  },

  removeAllListeners(event) {
    if (event) {
      eventHandlers.delete(event);
      // Close the libuv signal handle if one exists
      const handle = signalHandles.get(event);
      if (handle) {
        handle.close();
        signalHandles.delete(event);
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
export const { argv, execPath, exit, exitCode, cwd, chdir, kill, pid, getuid, getgid, getgroups, setuid, setgid, setgroups, platform, arch, version, versions, stdin, stdout, stderr } = process;
export { hrtime };
export const env = process.env;  // Export env separately to preserve the Proxy
