import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import {
	readStart, readStop, write as _streamWrite,
	close as _streamClose, shutdown as _streamShutdown,
	setOnRead, setOnShutdown,
} from 'qn/uv-stream'
import {
	kill as _procKill, getPid, setOnExit, killPid,
} from 'qn/uv-process'
import { signals } from 'qn_uv_signals'

// Build reverse map (number → name)
const signalNames = Object.fromEntries(
	Object.entries(signals).map(([k, v]) => [v, k])
)

/**
 * Incremental UTF-8 decoder for streaming.
 */
class Utf8Decoder {
	#pending = null
	decode(bytes) {
		if (this.#pending) {
			const combined = new Uint8Array(this.#pending.length + bytes.length)
			combined.set(this.#pending)
			combined.set(bytes, this.#pending.length)
			this.#pending = null
			bytes = combined
		}
		/* Check for incomplete multi-byte sequence at end */
		let end = bytes.length
		if (end > 0 && bytes[end - 1] >= 0x80) {
			let start = end - 1
			while (start > 0 && (bytes[start] & 0xC0) === 0x80) start--
			const firstByte = bytes[start]
			let expectedLen = 1
			if ((firstByte & 0xE0) === 0xC0) expectedLen = 2
			else if ((firstByte & 0xF0) === 0xE0) expectedLen = 3
			else if ((firstByte & 0xF8) === 0xF0) expectedLen = 4
			if (end - start < expectedLen) {
				this.#pending = bytes.slice(start)
				end = start
			}
		}
		if (end === 0) return ''
		return new TextDecoder().decode(bytes.subarray(0, end))
	}
	flush() {
		if (!this.#pending) return ''
		const result = new TextDecoder().decode(this.#pending)
		this.#pending = null
		return result
	}
}

/**
 * Readable stream backed by a libuv pipe handle.
 */
class PipeReadable extends EventEmitter {
	#handle = null
	#encoding = null
	#decoder = null
	#destroyed = false
	#ended = false

	constructor(handle) {
		super()
		this.#handle = handle
		setOnRead(handle, (buf, err) => {
			if (this.#destroyed) return
			if (err) {
				this.emit('error', err)
				this.#close()
				return
			}
			if (buf === null) {
				/* EOF */
				this.#ended = true
				readStop(handle)
				if (this.#decoder) {
					const remaining = this.#decoder.flush()
					if (remaining) this.emit('data', remaining)
				}
				this.emit('end')
				this.#close()
				return
			}
			if (this.#encoding) {
				this.emit('data', this.#decoder.decode(buf))
			} else {
				this.emit('data', Buffer.from(buf))
			}
		})
		readStart(handle)
	}

	setEncoding(encoding) {
		if (encoding && encoding.toLowerCase().replace('-', '') !== 'utf8') {
			throw new Error(`Unsupported encoding: ${encoding}. Only 'utf8' is supported.`)
		}
		this.#encoding = encoding ? 'utf8' : null
		if (this.#encoding && !this.#decoder) {
			this.#decoder = new Utf8Decoder()
		}
		return this
	}

	get destroyed() {
		return this.#destroyed
	}

	pause() {
		if (this.#handle && !this.#destroyed) readStop(this.#handle)
		return this
	}

	resume() {
		if (this.#handle && !this.#destroyed) readStart(this.#handle)
		return this
	}

	#close() {
		if (this.#destroyed) return
		this.#destroyed = true
		if (this.#handle) {
			_streamClose(this.#handle)
			this.#handle = null
		}
		this.emit('close')
	}

	destroy() {
		if (this.#destroyed) return
		if (this.#handle) readStop(this.#handle)
		this.#close()
	}

	on(event, fn) {
		return super.on(event, fn)
	}
}

/**
 * Stub Readable for the spawn-failure path. Node's contract is that
 * stdin/stdout/stderr are always stream objects when stdio is 'pipe' — even
 * when spawn fails (ENOENT etc) — so callers can attach listeners
 * synchronously and learn about the failure via the async 'error' event.
 */
class NullReadable extends EventEmitter {
	destroyed = false
	setEncoding() { return this }
	pause() { return this }
	resume() { return this }
	destroy() {
		if (this.destroyed) return
		this.destroyed = true
		queueMicrotask(() => this.emit('close'))
	}
}

/**
 * Stub Writable counterpart for the spawn-failure path.
 */
class NullWritable extends EventEmitter {
	destroyed = false
	write(chunk, encoding, callback) {
		if (typeof encoding === 'function') { callback = encoding; encoding = undefined }
		const err = new Error('write after end')
		if (callback) queueMicrotask(() => callback(err))
		return false
	}
	end(data, encoding, callback) {
		if (typeof data === 'function') { callback = data; data = undefined }
		if (typeof encoding === 'function') { callback = encoding; encoding = undefined }
		if (callback) queueMicrotask(callback)
	}
	destroy() {
		if (this.destroyed) return
		this.destroyed = true
		queueMicrotask(() => this.emit('close'))
	}
}

/**
 * Writable stream backed by a libuv pipe handle.
 */
class PipeWritable extends EventEmitter {
	#handle = null
	#destroyed = false
	#ending = false
	#finished = false

	constructor(handle) {
		super()
		this.#handle = handle
	}

	get destroyed() {
		return this.#destroyed
	}

	write(chunk, encoding, callback) {
		if (typeof encoding === 'function') {
			callback = encoding
			encoding = undefined
		}

		if (this.#destroyed || this.#ending) {
			const err = new Error('write after end')
			if (callback) callback(err)
			return false
		}

		let bytes
		if (chunk instanceof Uint8Array) {
			bytes = chunk
		} else if (typeof chunk === 'string') {
			bytes = new TextEncoder().encode(chunk)
		} else {
			bytes = new TextEncoder().encode(String(chunk))
		}

		_streamWrite(this.#handle, bytes).then(
			() => { if (callback) callback(null) },
			(err) => { if (callback) callback(err); else this.emit('error', err) },
		)

		return true
	}

	end(data, encoding, callback) {
		if (typeof data === 'function') {
			callback = data
			data = undefined
		}
		if (typeof encoding === 'function') {
			callback = encoding
			encoding = undefined
		}
		if (this.#ending) return
		this.#ending = true

		const doShutdown = () => {
			if (this.#handle) {
				setOnShutdown(this.#handle, () => {
					this.#finished = true
					this.emit('finish')
					this.#close()
					if (callback) callback()
				})
				try {
					_streamShutdown(this.#handle)
				} catch (e) {
					this.#close()
					if (callback) callback()
				}
			} else {
				if (callback) callback()
			}
		}

		if (data !== undefined && data !== null) {
			let bytes
			if (data instanceof Uint8Array) {
				bytes = data
			} else if (typeof data === 'string') {
				bytes = new TextEncoder().encode(data)
			} else {
				bytes = new TextEncoder().encode(String(data))
			}
			_streamWrite(this.#handle, bytes).then(
				() => doShutdown(),
				(err) => { this.emit('error', err); doShutdown() },
			)
		} else {
			doShutdown()
		}
	}

	#close() {
		if (this.#destroyed) return
		this.#destroyed = true
		if (this.#handle) {
			_streamClose(this.#handle)
			this.#handle = null
		}
		this.emit('close')
	}

	destroy() {
		this.#close()
	}
}

/**
 * Represents a spawned child process.
 * @extends EventEmitter
 * @see https://nodejs.org/api/child_process.html#class-childprocess
 *
 * Events:
 * - 'spawn' - Emitted once the process has spawned successfully
 * - 'error' - Emitted when the process could not be spawned or killed
 * - 'exit' - Emitted when the process exits (code, signal)
 * - 'close' - Emitted when stdio streams have closed (code, signal)
 */
export class ChildProcess extends EventEmitter {
	/** @type {number|undefined} */
	pid = undefined

	/** @type {number|null} */
	exitCode = null

	/** @type {string|null} */
	signalCode = null

	/** @type {boolean} */
	killed = false

	/** @type {PipeWritable|null} */
	stdin = null

	/** @type {PipeReadable|null} */
	stdout = null

	/** @type {PipeReadable|null} */
	stderr = null

	#procHandle = null
	#stdoutClosed = false
	#stderrClosed = false
	#stdinClosed = false
	#exited = false
	#closed = false
	#detached = false

	/**
	 * @param {object|null} procHandle - libuv process handle (null on spawn error)
	 * @param {{ stdinHandle, stdoutHandle, stderrHandle, detached, spawnError? }} opts
	 */
	constructor(procHandle, opts) {
		super()

		this.#detached = opts.detached || false

		/* Handle spawn failure. Install stream stubs so caller code that does
		 * child.stdout.on(...) synchronously after spawn() works, matching
		 * Node's contract. The async 'error' event surfaces the real cause. */
		if (!procHandle) {
			this.#exited = true
			this.#stdoutClosed = true
			this.#stderrClosed = true
			this.#stdinClosed = true
			if (opts.wantStdin) this.stdin = new NullWritable()
			if (opts.wantStdout) this.stdout = new NullReadable()
			if (opts.wantStderr) this.stderr = new NullReadable()
			// Matches Node: emit 'error' then 'close'; do not emit 'exit'
			// since no process ever ran.
			queueMicrotask(() => {
				this.emit('error', opts.spawnError || new Error('spawn failed'))
				this.#closed = true
				this.emit('close', null, null)
				this.stdin?.destroy()
				this.stdout?.destroy()
				this.stderr?.destroy()
			})
			return
		}

		this.#procHandle = procHandle
		this.pid = getPid(procHandle)

		if (opts.stdinHandle) {
			this.stdin = new PipeWritable(opts.stdinHandle)
			this.stdin.on('close', () => {
				this.#stdinClosed = true
			})
		} else {
			this.#stdinClosed = true
		}

		if (opts.stdoutHandle) {
			this.stdout = new PipeReadable(opts.stdoutHandle)
			this.stdout.on('close', () => {
				this.#stdoutClosed = true
				this.#checkClose()
			})
		} else {
			this.#stdoutClosed = true
		}

		if (opts.stderrHandle) {
			this.stderr = new PipeReadable(opts.stderrHandle)
			this.stderr.on('close', () => {
				this.#stderrClosed = true
				this.#checkClose()
			})
		} else {
			this.#stderrClosed = true
		}

		/* Listen for process exit via libuv callback */
		setOnExit(procHandle, (exitStatus, termSignal) => {
			this.#exited = true
			if (termSignal > 0) {
				this.signalCode = signalNames[termSignal] || `SIG${termSignal}`
			} else {
				this.exitCode = exitStatus
			}
			this.emit('exit', this.exitCode, this.signalCode)
			this.#checkClose()
		})

		/* Emit 'spawn' on next tick */
		queueMicrotask(() => this.emit('spawn'))
	}

	#checkClose() {
		if (this.#closed) return

		if (this.#stdoutClosed && this.#stderrClosed && this.#exited) {
			this.#closed = true
			this.emit('close', this.exitCode, this.signalCode)
		}
	}

	/**
	 * Kill the child process.
	 * For detached processes, kills the entire process group.
	 * @param {string|number} [signal='SIGTERM']
	 * @returns {boolean}
	 */
	kill(signal = 'SIGTERM') {
		if (this.#exited) return false

		const sig = typeof signal === 'string' ? signals[signal] : signal
		if (sig === undefined) {
			throw new Error(`Unknown signal: ${signal}`)
		}

		try {
			if (this.#detached) {
				/* For detached processes, kill the entire process group */
				killPid(-this.pid, sig)
			} else {
				_procKill(this.#procHandle, sig)
			}
			this.killed = true
			return true
		} catch (e) {
			return false
		}
	}
}
