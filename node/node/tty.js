/**
 * node:tty — TTY ReadStream / WriteStream wrappers around libuv uv_tty_t.
 *
 * Roughly matches the Node.js public surface (isatty, ReadStream, WriteStream)
 * but only implements the parts that are actually useful in qn programs:
 * - ReadStream:  setRawMode, isTTY, isRaw, columns, rows, pause/resume, 'data', 'end'
 * - WriteStream: write, getWindowSize, isTTY, columns, rows, getColorDepth, hasColors
 *
 * Refs / unrefs are the user's responsibility (matching Node.js):
 *   process.stdin auto-pauses when there are no listeners, so attaching no
 *   listener on stdin doesn't block exit. Call .ref() / .unref() to override.
 */

import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import {
	isatty as _isatty,
	ttyGetWinSize as _ttyGetWinSize,
	guessHandle as _guessHandle,
} from 'qn_vm'
import { read as _readAsync } from 'qn:uv-fs'
import {
	ttyNew, ttySetMode, ttyResetMode,
	pipeNew, pipeOpen,
	setOnRead, readStart, readStop, write as _write, close as _close,
	ref as _ref, unref as _unref,
	TTY_MODE_NORMAL, TTY_MODE_RAW,
} from 'qn:uv-stream'

/**
 * @param {number} fd
 * @returns {boolean}
 */
export function isatty(fd) {
	return _isatty(fd)
}

/* Install a single process.on('exit') handler the first time any TTY is
 * put into raw mode. uv_tty_reset_mode() restores the original termios
 * state, preventing programs that crash or call process.exit() while in
 * raw mode from leaving the user's shell unusable. */
let rawModeResetInstalled = false
function installRawModeResetOnExit() {
	if (rawModeResetInstalled) return
	rawModeResetInstalled = true
	globalThis.process?.on?.('exit', () => {
		try { ttyResetMode() } catch {}
	})
}

/* ---- streaming UTF-8 decoder ----
 * qn's TextDecoder doesn't support `stream: true`, and pulling in the
 * non-streaming TextDecoder would corrupt multi-byte sequences split across
 * read boundaries. Roll a small streaming decoder that buffers the
 * trailing incomplete UTF-8 sequence (up to 3 bytes) until more bytes arrive.
 */
class Utf8Decoder {
	#pending = new Uint8Array(4)
	#pendingLen = 0
	#dec = new TextDecoder('utf-8', { fatal: false })

	decode(bytes) {
		if (this.#pendingLen === 0 && bytes.length === 0) return ''
		let input
		if (this.#pendingLen > 0) {
			input = new Uint8Array(this.#pendingLen + bytes.length)
			input.set(this.#pending.subarray(0, this.#pendingLen), 0)
			input.set(bytes, this.#pendingLen)
			this.#pendingLen = 0
		} else {
			input = bytes
		}
		const completeLen = this.#completeLength(input)
		if (completeLen < input.length) {
			this.#pending.set(input.subarray(completeLen), 0)
			this.#pendingLen = input.length - completeLen
		}
		if (completeLen === 0) return ''
		return this.#dec.decode(input.subarray(0, completeLen))
	}

	flush() {
		if (this.#pendingLen === 0) return ''
		const out = this.#dec.decode(this.#pending.subarray(0, this.#pendingLen))
		this.#pendingLen = 0
		return out
	}

	#completeLength(bytes) {
		const len = bytes.length
		if (len === 0) return 0
		for (let i = 1; i <= Math.min(3, len); i++) {
			const b = bytes[len - i]
			if ((b & 0xC0) === 0xC0) {
				const seqLen = (b & 0xE0) === 0xC0 ? 2
					: (b & 0xF0) === 0xE0 ? 3
					: (b & 0xF8) === 0xF0 ? 4
					: 1
				if (seqLen > i) return len - i
				break
			} else if ((b & 0xC0) !== 0x80) {
				break
			}
		}
		return len
	}
}

/* =========================================================================
 *  ReadStream
 * ========================================================================= */

export class ReadStream extends EventEmitter {
	#fd
	#handle = null    /* lazily created uv handle (TTY or pipe) */
	#fileMode = false /* regular-file fallback: read via uv_fs_read */
	#filePos = 0
	#reading = false
	#paused = true
	#destroyed = false
	#ended = false
	#encoding = null
	#decoder = null
	#buffered = []
	#hasDataListener = false

	constructor(fd) {
		super()
		this.#fd = fd
		/* Node.js sets isTTY=true on TTYs and leaves it undefined elsewhere */
		this.isTTY = _isatty(fd) ? true : undefined
		this.isRaw = false
		this.readable = true
	}

	/* Auto-resume when first 'data' listener is attached (Node.js semantics).
	 * qn's EventEmitter doesn't emit 'newListener', so we hook on/off directly. */
	#maybeAutoResume(event) {
		if (event !== 'data' || this.#hasDataListener) return
		this.#hasDataListener = true
		queueMicrotask(() => { if (!this.#destroyed) this.resume() })
	}
	#maybeAutoPause(event) {
		if (event !== 'data') return
		if (this.listenerCount('data') === 0) {
			this.#hasDataListener = false
			this.pause()
		}
	}

	on(event, listener) {
		super.on(event, listener)
		this.#maybeAutoResume(event)
		return this
	}
	addListener(event, listener) { return this.on(event, listener) }
	once(event, listener) {
		super.once(event, listener)
		this.#maybeAutoResume(event)
		return this
	}
	prependListener(event, listener) {
		super.prependListener(event, listener)
		this.#maybeAutoResume(event)
		return this
	}
	removeListener(event, listener) {
		super.removeListener(event, listener)
		this.#maybeAutoPause(event)
		return this
	}
	off(event, listener) { return this.removeListener(event, listener) }
	removeAllListeners(event) {
		super.removeAllListeners(event)
		if (event === undefined || event === 'data') {
			this.#hasDataListener = false
			this.pause()
		}
		return this
	}

	get fd() { return this.#fd }

	/* Lazily wire up the read source. TTY → uv_tty_t, pipe/socket →
	 * uv_pipe_t, regular file → uv_fs_read loop (uv_pipe_open succeeds on
	 * a regular file fd but uv_read_start later aborts because the fd
	 * can't be added to epoll/kqueue). */
	#ensureHandle() {
		if (this.#handle || this.#fileMode) return
		if (this.isTTY) {
			this.#handle = ttyNew(this.#fd, 1)
			return
		}
		const kind = _guessHandle(this.#fd)
		if (kind === 'pipe' || kind === 'tcp') {
			const h = pipeNew()
			pipeOpen(h, this.#fd)
			this.#handle = h
		} else {
			this.#fileMode = true
		}
	}

	#startReading() {
		if (this.#reading || this.#destroyed) return
		this.#ensureHandle()
		this.#reading = true
		if (this.#fileMode) {
			this.#fileReadLoop()
		} else {
			setOnRead(this.#handle, (chunk, err) => this.#onRead(chunk, err))
			readStart(this.#handle)
		}
	}

	#stopReading() {
		if (!this.#reading) return
		this.#reading = false
		if (!this.#fileMode) readStop(this.#handle)
		/* file mode: the read loop checks this.#reading and exits */
	}

	async #fileReadLoop() {
		while (this.#reading && !this.#destroyed && !this.#ended) {
			const buf = new Uint8Array(4096)
			let n
			try {
				n = await _readAsync(this.#fd, buf, this.#filePos)
			} catch (err) {
				this.#onRead(null, err instanceof Error ? err : new Error(String(err)))
				return
			}
			if (n > 0) {
				this.#filePos += n
				this.#onRead(buf.subarray(0, n), null)
			} else {
				this.#onRead(null, null)
				return
			}
		}
	}

	#onRead(chunk, err) {
		if (this.#destroyed) return
		if (err) {
			this.#destroyed = true
			this.#reading = false
			this.emit('error', err)
			this.#close()
			return
		}
		if (chunk == null) {
			/* EOF */
			this.#ended = true
			this.#reading = false
			if (this.#decoder) {
				const tail = this.#decoder.flush()
				if (tail) this.emit('data', tail)
			}
			this.emit('end')
			this.#close()
			return
		}
		let out
		if (this.#encoding === 'utf8') {
			if (!this.#decoder) this.#decoder = new Utf8Decoder()
			out = this.#decoder.decode(chunk)
			if (!out) return
		} else {
			out = Buffer.from(chunk)
		}
		if (this.#paused) {
			this.#buffered.push(out)
		} else {
			this.emit('data', out)
		}
	}

	#close() {
		if (this.#destroyed) return
		this.#destroyed = true
		this.#reading = false
		if (this.#handle) {
			try { _close(this.#handle) } catch {}
			this.#handle = null
		}
		queueMicrotask(() => this.emit('close'))
	}

	/**
	 * Toggle raw mode on a TTY. No-op (returns this) on non-TTY fds — matches
	 * Node.js behavior for piped stdin.
	 * @param {boolean} mode
	 * @returns {this}
	 */
	setRawMode(mode) {
		if (!this.isTTY) return this
		this.#ensureHandle()
		ttySetMode(this.#handle, mode ? TTY_MODE_RAW : TTY_MODE_NORMAL)
		this.isRaw = !!mode
		if (mode) installRawModeResetOnExit()
		return this
	}

	/**
	 * @param {string|null} encoding
	 * @returns {this}
	 */
	setEncoding(encoding) {
		if (encoding == null) {
			this.#encoding = null
			this.#decoder = null
			return this
		}
		const norm = String(encoding).toLowerCase().replace('-', '')
		if (norm !== 'utf8') {
			throw new Error(`Unsupported encoding: ${encoding}. Only 'utf8' is supported.`)
		}
		this.#encoding = 'utf8'
		this.#decoder = new Utf8Decoder()
		return this
	}

	pause() {
		this.#paused = true
		this.#stopReading()
		return this
	}

	resume() {
		if (this.#destroyed || this.#ended) return this
		this.#paused = false
		/* Flush anything buffered while paused */
		while (this.#buffered.length > 0 && !this.#paused) {
			this.emit('data', this.#buffered.shift())
		}
		this.#startReading()
		return this
	}

	ref() {
		if (this.#handle) _ref(this.#handle)
		return this
	}

	unref() {
		if (this.#handle) _unref(this.#handle)
		return this
	}

	destroy(err) {
		if (this.#destroyed) return this
		this.#stopReading()
		if (err) this.emit('error', err)
		this.#close()
		return this
	}

	get destroyed() { return this.#destroyed }
	get readableEnded() { return this.#ended }

	get columns() {
		if (!this.isTTY) return undefined
		const ws = _ttyGetWinSize(this.#fd)
		return ws ? ws[0] : undefined
	}
	get rows() {
		if (!this.isTTY) return undefined
		const ws = _ttyGetWinSize(this.#fd)
		return ws ? ws[1] : undefined
	}
}

/* =========================================================================
 *  WriteStream
 * ========================================================================= */

export class WriteStream extends EventEmitter {
	#fd
	#handle = null
	#destroyed = false

	constructor(fd) {
		super()
		this.#fd = fd
		/* Node.js sets isTTY=true on TTYs and leaves it undefined elsewhere */
		this.isTTY = _isatty(fd) ? true : undefined
		this.writable = true
	}

	get fd() { return this.#fd }

	#ensureHandle() {
		if (this.#handle) return this.#handle
		if (this.isTTY) {
			this.#handle = ttyNew(this.#fd, 0)
		} else {
			const h = pipeNew()
			pipeOpen(h, this.#fd)
			this.#handle = h
		}
		return this.#handle
	}

	/**
	 * @param {string|Uint8Array} data
	 * @param {string|Function} [encoding]
	 * @param {Function} [callback]
	 * @returns {boolean}
	 */
	write(data, encoding, callback) {
		if (typeof encoding === 'function') {
			callback = encoding
			encoding = 'utf8'
		}
		let bytes
		if (typeof data === 'string') {
			bytes = Buffer.from(data, encoding || 'utf8')
		} else if (data instanceof Uint8Array) {
			bytes = data
		} else {
			throw new TypeError('write() expects string or Uint8Array')
		}
		try {
			const handle = this.#ensureHandle()
			const p = _write(handle, bytes)
			/* _write returns either a resolved promise (sync write) or a
			 * pending promise. Either way we're nominally non-blocking. */
			if (p && typeof p.then === 'function') {
				p.then(
					() => callback?.(),
					(err) => {
						this.emit('error', err)
						callback?.(err)
					},
				)
			} else if (callback) {
				queueMicrotask(callback)
			}
			return true
		} catch (err) {
			this.emit('error', err)
			if (callback) callback(err)
			return false
		}
	}

	/**
	 * @returns {[number, number] | null}
	 */
	getWindowSize() {
		if (!this.isTTY) return null
		const ws = _ttyGetWinSize(this.#fd)
		return ws ? [ws[0], ws[1]] : null
	}

	get columns() {
		if (!this.isTTY) return undefined
		const ws = _ttyGetWinSize(this.#fd)
		return ws ? ws[0] : undefined
	}
	get rows() {
		if (!this.isTTY) return undefined
		const ws = _ttyGetWinSize(this.#fd)
		return ws ? ws[1] : undefined
	}

	/**
	 * Detect color depth: 1 (mono), 4 (16-color), 8 (256-color), 24 (truecolor).
	 * Best-effort detection from TERM / COLORTERM env vars.
	 * @returns {number}
	 */
	getColorDepth() {
		if (!this.isTTY) return 1
		const env = globalThis.process?.env || {}
		if (env.NO_COLOR) return 1
		if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 24
		const term = env.TERM || ''
		if (/-256(color)?$/i.test(term)) return 8
		if (/^xterm|^screen|^tmux|color/i.test(term)) return 4
		if (term === 'dumb') return 1
		return 4
	}

	/**
	 * @param {number} [count]
	 * @returns {boolean}
	 */
	hasColors(count) {
		const depth = this.getColorDepth()
		const colors = 2 ** depth
		if (count == null) return colors >= 16
		return colors >= count
	}

	ref() {
		if (this.#handle) _ref(this.#handle)
		return this
	}

	unref() {
		if (this.#handle) _unref(this.#handle)
		return this
	}

	destroy() {
		if (this.#destroyed) return this
		this.#destroyed = true
		if (this.#handle) {
			try { _close(this.#handle) } catch {}
			this.#handle = null
		}
		return this
	}

	get destroyed() { return this.#destroyed }
}

export default { isatty, ReadStream, WriteStream }
