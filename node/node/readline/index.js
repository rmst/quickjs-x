/*
 * node:readline — line-mode line-by-line stdin reader.
 *
 * Currently only supports the cooked-terminal line mode (no raw-mode key
 * editing, no history, no completion). This is enough for prompt-style use
 * cases where the terminal driver does the local echo and line editing.
 *
 * Raw-mode editing (terminal: true with editing keybindings) is not yet
 * implemented — we'd need ttySetCooked + ANSI key parsing on top of the
 * existing setReadHandler/ttySetRaw plumbing in qn-vm.c. createInterface()
 * accepts a `terminal` option but ignores it for now.
 */

import * as std from 'std'
import { EventEmitter } from 'node:events'
import { setReadHandler as _setReadHandler } from 'qn_vm'
import { readSync as _readSync, read as _readAsync, fstatSync as _fstatSync, S_IFMT, S_IFREG } from 'qn:uv-fs'

/* Streaming UTF-8 decoder that buffers an incomplete trailing sequence
 * across chunks (TextDecoder doesn't support {stream:true} in qn). */
class Utf8Decoder {
	#pending = new Uint8Array(4)
	#pendingLen = 0

	decode(bytes) {
		let input
		if (this.#pendingLen > 0) {
			input = new Uint8Array(this.#pendingLen + bytes.length)
			input.set(this.#pending.subarray(0, this.#pendingLen), 0)
			input.set(bytes, this.#pendingLen)
			this.#pendingLen = 0
		} else {
			input = bytes
		}
		const completeLen = this.#completeLen(input)
		if (completeLen < input.length) {
			this.#pending.set(input.subarray(completeLen), 0)
			this.#pendingLen = input.length - completeLen
		}
		if (completeLen === 0) return ''
		const slice = input.subarray(0, completeLen)
		return std._decodeUtf8(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength))
	}

	flush() {
		if (this.#pendingLen === 0) return ''
		const slice = this.#pending.subarray(0, this.#pendingLen)
		this.#pendingLen = 0
		return std._decodeUtf8(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength))
	}

	#completeLen(bytes) {
		let i = bytes.length
		while (i > 0) {
			const b = bytes[i - 1]
			if ((b & 0x80) === 0) return i                  /* ASCII complete */
			if ((b & 0xC0) === 0x80) { i--; continue }      /* continuation */
			/* leading byte */
			const need = (b & 0xE0) === 0xC0 ? 2
			            : (b & 0xF0) === 0xE0 ? 3
			            : (b & 0xF8) === 0xF0 ? 4
			            : 1
			const have = bytes.length - (i - 1)
			return have >= need ? bytes.length : i - 1
		}
		return 0
	}
}

export class Interface extends EventEmitter {
	#input
	#output
	#prompt = '> '
	#closed = false
	#paused = false
	#endedWhilePaused = false
	#lineBuffer = ''
	#decoder = null
	#fd = -1
	#streamHandlers = null
	#dataQueue = null
	#questionCb = null

	constructor(options) {
		super()
		if (!options || typeof options !== 'object')
			throw new TypeError('readline.createInterface: options object required')
		const { input, output, prompt, terminal } = options
		if (!input)
			throw new TypeError('readline.createInterface: options.input is required')
		this.#input = input
		this.#output = output ?? null
		if (typeof prompt === 'string') this.#prompt = prompt

		/* `terminal` is accepted for API compatibility but the editing UI is
		 * not implemented yet. Throw if the caller asks for it explicitly,
		 * so we don't silently degrade. (Default: undefined → cooked line mode.) */
		if (terminal === true) {
			throw new Error(
				'readline: terminal:true (raw-mode editing) not implemented in qn yet — ' +
				'omit the option to use cooked line mode'
			)
		}

		this.#setupInput()
	}

	#setupInput() {
		const input = this.#input
		if (input && typeof input.on === 'function') {
			/* Stream-shaped input (Readable). Subscribe to data/end. */
			if (typeof input.setEncoding === 'function') input.setEncoding('utf8')
			const onData = (chunk) => this.#onChunk(chunk)
			const onEnd = () => this.#onEnd()
			const onError = (err) => this.emit('error', err)
			input.on('data', onData)
			input.on('end', onEnd)
			input.on('error', onError)
			this.#streamHandlers = { onData, onEnd, onError }
		} else if (input && typeof input.fd === 'number') {
			/* fd-shaped input (process.stdin). uv_poll only works on
			 * pollable fds (pipes/sockets/TTYs), so check for regular files
			 * (e.g. `qn script.js < input.txt`) and use async reads instead. */
			this.#fd = input.fd
			this.#decoder = new Utf8Decoder()

			let isRegularFile = false
			try {
				const st = _fstatSync(this.#fd)
				isRegularFile = (st.mode & S_IFMT) === S_IFREG
			} catch { /* non-fatal: fall through to poll path */ }

			if (isRegularFile) {
				this.#startAsyncReadLoop()
			} else {
				const buf = new Uint8Array(4096)
				_setReadHandler(this.#fd, () => {
					if (this.#closed) return
					let n
					try { n = _readSync(this.#fd, buf) }
					catch (e) { this.emit('error', e); this.close(); return }
					if (n > 0) {
						this.#onChunk(this.#decoder.decode(buf.subarray(0, n)))
					} else {
						const tail = this.#decoder.flush()
						if (tail) this.#onChunk(tail)
						this.#onEnd()
					}
				})
			}
		} else {
			throw new TypeError('readline.createInterface: input must be a Readable or have a numeric .fd')
		}
	}

	async #startAsyncReadLoop() {
		const buf = new Uint8Array(4096)
		while (!this.#closed) {
			let n
			try { n = await _readAsync(this.#fd, buf) }
			catch (e) {
				if (!this.#closed) { this.emit('error', e); this.close() }
				return
			}
			if (this.#closed) return
			if (n > 0) {
				this.#onChunk(this.#decoder.decode(buf.subarray(0, n)))
			} else {
				const tail = this.#decoder.flush()
				if (tail) this.#onChunk(tail)
				this.#onEnd()
				return
			}
		}
	}

	#onChunk(chunk) {
		if (this.#closed) return
		if (this.#paused) {
			(this.#dataQueue ??= []).push(chunk)
			return
		}
		if (typeof chunk !== 'string') chunk = String(chunk)

		let s = this.#lineBuffer + chunk
		let start = 0
		for (let i = 0; i < s.length; i++) {
			const c = s.charCodeAt(i)
			if (c === 0x0A /* \n */) {
				let end = i
				if (end > start && s.charCodeAt(end - 1) === 0x0D) end--   /* trim \r */
				this.#deliverLine(s.substring(start, end))
				start = i + 1
				if (this.#closed) { this.#lineBuffer = ''; return }
			}
		}
		this.#lineBuffer = start > 0 ? s.substring(start) : s
	}

	#onEnd() {
		if (this.#closed) return
		if (this.#paused) {
			/* Defer close until resume() drains the queued chunks. */
			this.#endedWhilePaused = true
			return
		}
		if (this.#lineBuffer.length > 0) {
			let line = this.#lineBuffer
			if (line.endsWith('\r')) line = line.slice(0, -1)
			this.#lineBuffer = ''
			this.#deliverLine(line)
		}
		this.close()
	}

	#deliverLine(line) {
		if (this.#questionCb) {
			const cb = this.#questionCb
			this.#questionCb = null
			cb(line)
		} else {
			this.emit('line', line)
		}
	}

	question(query, options, cb) {
		if (typeof options === 'function') { cb = options; options = undefined }
		if (typeof cb !== 'function')
			throw new TypeError('readline.question: callback function required')
		if (this.#closed) throw new Error('readline.question: interface closed')
		if (this.#questionCb)
			throw new Error('readline.question: a question is already pending')

		const signal = options && options.signal
		if (signal && signal.aborted) {
			queueMicrotask(() => cb())   /* Node convention: no-arg callback on abort */
			return
		}

		let abortHandler = null
		const finish = (answer) => {
			if (abortHandler) signal.removeEventListener('abort', abortHandler)
			cb(answer)
		}

		if (signal) {
			abortHandler = () => {
				if (this.#questionCb === finish) {
					this.#questionCb = null
					cb()
				}
			}
			signal.addEventListener('abort', abortHandler, { once: true })
		}

		this.#questionCb = finish
		this.#write(query)
	}

	prompt(_preserveCursor) {
		if (this.#closed) return
		this.#write(this.#prompt)
	}

	setPrompt(prompt) { this.#prompt = String(prompt) }
	getPrompt() { return this.#prompt }

	write(data, _key) {
		/* Node also accepts a key descriptor for raw-mode dispatch — ignored here. */
		if (typeof data === 'string') this.#write(data)
	}

	#write(s) {
		const out = this.#output
		if (!out) return
		if (typeof out.write === 'function') out.write(s)
	}

	pause() {
		if (this.#paused || this.#closed) return this
		this.#paused = true
		this.emit('pause')
		return this
	}

	resume() {
		if (!this.#paused || this.#closed) return this
		this.#paused = false
		const q = this.#dataQueue
		this.#dataQueue = null
		if (q) for (const chunk of q) this.#onChunk(chunk)
		this.emit('resume')
		if (this.#endedWhilePaused && !this.#closed) {
			this.#endedWhilePaused = false
			this.#onEnd()
		}
		return this
	}

	close() {
		if (this.#closed) return
		this.#closed = true

		if (this.#fd >= 0) {
			_setReadHandler(this.#fd, null)
			this.#fd = -1
		}
		if (this.#streamHandlers && typeof this.#input.off === 'function') {
			const { onData, onEnd, onError } = this.#streamHandlers
			this.#input.off('data', onData)
			this.#input.off('end', onEnd)
			this.#input.off('error', onError)
			this.#streamHandlers = null
		}
		this.emit('close')
	}

	get closed() { return this.#closed }
	get terminal() { return false }   /* line mode only for now */

	[Symbol.asyncIterator]() {
		const queue = []
		let pending = null
		let ended = false
		let error = null

		const onLine = (line) => {
			if (pending) { const r = pending; pending = null; r({ value: line, done: false }) }
			else queue.push(line)
		}
		const onClose = () => {
			ended = true
			if (pending) { const r = pending; pending = null; r({ value: undefined, done: true }) }
		}
		const onError = (err) => {
			error = err
			if (pending) { const r = pending; pending = null; r(Promise.reject(err)) }
		}

		this.on('line', onLine)
		this.on('close', onClose)
		this.on('error', onError)

		return {
			next: () => {
				if (error) { const e = error; error = null; return Promise.reject(e) }
				if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
				if (ended) return Promise.resolve({ value: undefined, done: true })
				return new Promise(r => { pending = r })
			},
			return: () => {
				this.off('line', onLine)
				this.off('close', onClose)
				this.off('error', onError)
				return Promise.resolve({ value: undefined, done: true })
			},
			[Symbol.asyncIterator]() { return this },
		}
	}
}

export function createInterface(options) {
	return new Interface(options)
}

/* Cursor / line helpers — accepted for API compatibility. They write the
 * usual ANSI sequences when a TTY-shaped output stream is provided. */

export function cursorTo(stream, x, y, callback) {
	if (typeof y === 'function') { callback = y; y = undefined }
	if (!stream || typeof stream.write !== 'function') {
		if (callback) queueMicrotask(callback)
		return true
	}
	if (typeof x !== 'number') {
		if (callback) queueMicrotask(callback)
		return true
	}
	const seq = typeof y === 'number'
		? `\x1b[${y + 1};${x + 1}H`
		: `\x1b[${x + 1}G`
	stream.write(seq)
	if (callback) queueMicrotask(callback)
	return true
}

export function moveCursor(stream, dx, dy, callback) {
	if (!stream || typeof stream.write !== 'function') {
		if (callback) queueMicrotask(callback)
		return true
	}
	let s = ''
	if (dx > 0) s += `\x1b[${dx}C`
	else if (dx < 0) s += `\x1b[${-dx}D`
	if (dy > 0) s += `\x1b[${dy}B`
	else if (dy < 0) s += `\x1b[${-dy}A`
	if (s) stream.write(s)
	if (callback) queueMicrotask(callback)
	return true
}

export function clearLine(stream, dir, callback) {
	if (!stream || typeof stream.write !== 'function') {
		if (callback) queueMicrotask(callback)
		return true
	}
	const code = dir < 0 ? '1K' : dir > 0 ? '0K' : '2K'
	stream.write(`\x1b[${code}`)
	if (callback) queueMicrotask(callback)
	return true
}

export function clearScreenDown(stream, callback) {
	if (!stream || typeof stream.write !== 'function') {
		if (callback) queueMicrotask(callback)
		return true
	}
	stream.write('\x1b[0J')
	if (callback) queueMicrotask(callback)
	return true
}

export function emitKeypressEvents(_stream, _iface) {
	throw new Error('readline.emitKeypressEvents: not implemented in qn (requires raw-mode + key parsing)')
}

export default {
	Interface,
	createInterface,
	cursorTo,
	moveCursor,
	clearLine,
	clearScreenDown,
	emitKeypressEvents,
}
