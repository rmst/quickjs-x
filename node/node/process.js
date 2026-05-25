import * as std from 'std';
import { signal as uvSignal, signals as signalMap } from 'qn_uv_signals';
import {
	getCwd as _getCwd, chdir as _chdir,
	kill as _kill, getPid as _getPid, getPlatform as _getPlatform,
	getArch as _getArch, getExecPath as _getExecPath,
	getuid as _getuid, getgid as _getgid, getgroups as _getgroups,
	getUmask as _getUmask, setUmask as _setUmask,
	setuid as _setuid, setgid as _setgid, setgroups as _setgroups,
	hrtimeBigInt as _hrtimeBigInt,
} from 'qn_vm';
import { ReadStream, WriteStream } from 'node:tty';

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

const createInvalidUmaskValueError = (mask) => {
	const err = new TypeError(`The argument 'mask' must be a 32-bit unsigned integer or an octal string. Received ${JSON.stringify(mask)}`)
	err.code = 'ERR_INVALID_ARG_VALUE'
	return err
}

const createInvalidUmaskTypeError = (mask) => {
	const type = mask === null ? 'null' : typeof mask
	const err = new TypeError(`The "mask" argument must be of type number or string. Received ${type}`)
	err.code = 'ERR_INVALID_ARG_TYPE'
	return err
}

const createUmaskRangeError = (message) => {
	const err = new RangeError(message)
	err.code = 'ERR_OUT_OF_RANGE'
	return err
}

const validateUmask = (mask) => {
	if (typeof mask === 'string') {
		if (!/^[0-7]+$/.test(mask)) {
			throw createInvalidUmaskValueError(mask)
		}
		const parsed = Number.parseInt(mask, 8)
		if (parsed > 0xffffffff) {
			throw createInvalidUmaskValueError(mask)
		}
		return parsed
	}
	if (typeof mask !== 'number') {
		throw createInvalidUmaskTypeError(mask)
	}
	if (!Number.isInteger(mask)) {
		throw createUmaskRangeError(`The value of "mask" is out of range. It must be an integer. Received ${mask}`)
	}
	if (mask < 0 || mask > 0xffffffff) {
		throw createUmaskRangeError(`The value of "mask" is out of range. It must be >= 0 && <= 4294967295. Received ${mask}`)
	}
	return mask
}

/* stdout/stderr go through std.out/std.err for synchronous writes — that
 * matches Node.js semantics for process.stdout (synchronous when fd is a
 * file or pipe, blocking on TTY). The tty.WriteStream's libuv-async write
 * isn't appropriate for the canonical "console.log" path because it makes
 * output appear after subsequent JS work runs. */
const createWriteStream = (fd) => {
	const file = fd === 1 ? std.out : std.err
	const stream = new WriteStream(fd)
	stream.write = function(data, encoding, callback) {
		if (typeof encoding === 'function') {
			callback = encoding
			encoding = 'utf8'
		}
		try {
			if (typeof data === 'string') {
				file.puts(data)
			} else {
				/* Uint8Array / Buffer — convert via decode (utf8) for puts */
				file.puts(new TextDecoder().decode(data))
			}
			file.flush()
			if (callback) queueMicrotask(callback)
			return true
		} catch (err) {
			if (callback) callback(err)
			return false
		}
	}
	return stream
}

const installTtyResizeSignal = (stream) => {
	const sigwinch = signalMap.SIGWINCH
	if (sigwinch === undefined || !stream.isTTY) return

	let size = stream.getWindowSize()
	let handle = null
	const dispatchResize = () => {
		const next = stream.getWindowSize()
		if (!next) return
		const prev = size
		size = next
		if (!prev || next[0] !== prev[0] || next[1] !== prev[1]) {
			stream.emit('resize')
		}
	}
	const ensureHandle = () => {
		if (!handle && stream.listenerCount('resize') > 0) {
			/* qn_uv_signals unrefs signal handles, so this does not keep the
			 * process alive. Install lazily to preserve Node's cross-emitter
			 * ordering between process.on('SIGWINCH') and stdio 'resize'. */
			handle = uvSignal(sigwinch, dispatchResize)
		}
	}
	const maybeCloseHandle = () => {
		if (handle && stream.listenerCount('resize') === 0) {
			handle.close()
			handle = null
		}
	}
	const replaceMethod = (name, fn) => {
		Object.defineProperty(stream, name, {
			value: fn,
			writable: true,
			configurable: true,
		})
	}
	const wrapAdd = (name) => {
		const original = stream[name].bind(stream)
		replaceMethod(name, function(event, ...args) {
			const ret = original(event, ...args)
			if (event === 'resize') ensureHandle()
			return ret
		})
	}
	const wrapRemove = (name) => {
		const original = stream[name].bind(stream)
		replaceMethod(name, function(event, ...args) {
			const ret = original(event, ...args)
			if (event === undefined || event === 'resize') maybeCloseHandle()
			return ret
		})
	}
	wrapAdd('on')
	wrapAdd('addListener')
	wrapAdd('once')
	wrapAdd('prependListener')
	wrapRemove('removeListener')
	wrapRemove('off')
	wrapRemove('removeAllListeners')
}

// Event handlers storage
const eventHandlers = new Map()
// Active uv_signal_t handles per signal name
const signalHandles = new Map()

const processStdout = createWriteStream(1)
const processStderr = createWriteStream(2)
installTtyResizeSignal(processStdout)
installTtyResizeSignal(processStderr)

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

  // Standard streams. ReadStream/WriteStream constructors are cheap; the
  // libuv handle is allocated lazily on first I/O / setRawMode.
  stdin: new ReadStream(0),
  stdout: processStdout,
  stderr: processStderr,

  // Process ID
  get pid() {
    return _getPid();
  },

  // High-resolution time
  hrtime,

  umask(mask) {
    if (mask === undefined) {
      return _getUmask();
    }
    return _setUmask(validateUmask(mask));
  },

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
export const { argv, execPath, exit, exitCode, cwd, chdir, kill, pid, umask, getuid, getgid, getgroups, setuid, setgid, setgroups, platform, arch, version, versions, stdin, stdout, stderr } = process;
export { hrtime };
export const env = process.env;  // Export env separately to preserve the Proxy
