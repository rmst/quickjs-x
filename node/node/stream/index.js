import * as std from 'std'
import {
	readSync, writeSync, closeSync, UV_EAGAIN,
} from 'qn:uv-fs'
import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import {
	setTimeout as _setTimeout,
	setReadHandler as _setReadHandler,
	setWriteHandler as _setWriteHandler,
} from 'qn_vm'

import { Transform, Duplex, PassThrough } from './transform.js'
export { Transform, Duplex, PassThrough }

/**
 * UTF-8 streaming decoder that handles incomplete multi-byte sequences.
 * Buffers incomplete sequences until more data arrives.
 */
class Utf8Decoder {
	#pending = new Uint8Array(4)
	#pendingLen = 0

	/**
	 * Decode bytes to string, buffering incomplete sequences.
	 * @param {Uint8Array} bytes
	 * @returns {string}
	 */
	decode(bytes) {
		if (this.#pendingLen === 0 && bytes.length === 0) {
			return ''
		}

		// Combine pending bytes with new bytes
		let input
		if (this.#pendingLen > 0) {
			input = new Uint8Array(this.#pendingLen + bytes.length)
			input.set(this.#pending.subarray(0, this.#pendingLen), 0)
			input.set(bytes, this.#pendingLen)
			this.#pendingLen = 0
		} else {
			input = bytes
		}

		// Find where complete UTF-8 sequences end
		const completeLen = this.#findCompleteLength(input)

		// Buffer incomplete trailing bytes
		if (completeLen < input.length) {
			const remaining = input.length - completeLen
			this.#pending.set(input.subarray(completeLen), 0)
			this.#pendingLen = remaining
		}

		// Decode complete bytes using QuickJS
		if (completeLen === 0) {
			return ''
		}

		return this.#decodeComplete(input.subarray(0, completeLen))
	}

	/**
	 * Flush any remaining buffered bytes (may produce replacement chars for invalid sequences).
	 * @returns {string}
	 */
	flush() {
		if (this.#pendingLen === 0) {
			return ''
		}
		const result = this.#decodeComplete(this.#pending.subarray(0, this.#pendingLen))
		this.#pendingLen = 0
		return result
	}

	/**
	 * Find length of complete UTF-8 sequences (excluding trailing incomplete sequence).
	 * @param {Uint8Array} bytes
	 * @returns {number}
	 */
	#findCompleteLength(bytes) {
		const len = bytes.length
		if (len === 0) return 0

		// Check last 1-3 bytes for incomplete sequence
		for (let i = 1; i <= Math.min(3, len); i++) {
			const byte = bytes[len - i]
			// Check if this is a leading byte of a multi-byte sequence
			if ((byte & 0xC0) === 0xC0) {
				// Leading byte found - check if sequence is complete
				const seqLen = this.#sequenceLength(byte)
				if (seqLen > i) {
					// Incomplete sequence
					return len - i
				}
				break
			} else if ((byte & 0xC0) !== 0x80) {
				// ASCII byte or invalid - no incomplete sequence
				break
			}
		}
		return len
	}

	/**
	 * Get expected length of UTF-8 sequence from leading byte.
	 * @param {number} byte
	 * @returns {number}
	 */
	#sequenceLength(byte) {
		if ((byte & 0x80) === 0) return 1      // 0xxxxxxx
		if ((byte & 0xE0) === 0xC0) return 2   // 110xxxxx
		if ((byte & 0xF0) === 0xE0) return 3   // 1110xxxx
		if ((byte & 0xF8) === 0xF0) return 4   // 11110xxx
		return 1 // Invalid, treat as single byte
	}

	/**
	 * Decode complete UTF-8 bytes to string.
	 * Uses QuickJS std module for proper UTF-8 handling.
	 * @param {Uint8Array} bytes
	 * @returns {string}
	 */
	#decodeComplete(bytes) {
		return std._decodeUtf8(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
	}
}

/**
 * Encode string as UTF-8 bytes.
 * Uses QuickJS std module for proper UTF-8 handling.
 * @param {string} str
 * @returns {Uint8Array}
 */
function encodeUtf8(str) {
	return new Uint8Array(std._encodeUtf8(str))
}

/**
 * Readable stream that wraps a file descriptor.
 * Emits 'data' events as data becomes available.
 * @extends EventEmitter
 *
 * Events:
 * - 'data' (chunk: Uint8Array|string) - Emitted when data is available
 * - 'end' - Emitted when EOF is reached
 * - 'error' (err: Error) - Emitted on read error
 * - 'close' - Emitted when stream is closed
 */
export class Readable extends EventEmitter {
	/** @type {number|null} */
	#fd = null

	/** @type {boolean} */
	#flowing = true

	/** @type {boolean} */
	#ended = false

	/** @type {boolean} */
	#destroyed = false

	/** @type {Array<Uint8Array|string>} */
	#buffer = []

	/** @type {string|null} */
	#encoding = null

	/** @type {Utf8Decoder|null} */
	#decoder = null

	/**
	 * @param {number} fd - File descriptor to read from
	 */
	constructor(fd) {
		super()
		this.#fd = fd
		this.#setupReadHandler()
	}

	/**
	 * Set encoding for string output.
	 * @param {string} encoding - Currently only 'utf8' or 'utf-8' supported
	 * @returns {this}
	 */
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

	#setupReadHandler() {
		if (this.#fd === null) return

		_setReadHandler(this.#fd, () => {
			if (this.#destroyed) return

			const buf = new Uint8Array(4096)
			let n
			try {
				// readSync with pos=-1 uses current file position (POSIX read)
				n = readSync(this.#fd, buf)
			} catch (e) {
				this.#handleError(e)
				return
			}

			if (n > 0) {
				const bytes = buf.subarray(0, n)
				let chunk
				if (this.#encoding) {
					chunk = this.#decoder.decode(bytes)
				} else {
					// Return a Buffer copy to avoid issues with buffer reuse
					chunk = Buffer.from(bytes)
				}

				if (this.#flowing) {
					this.emit('data', chunk)
				} else {
					this.#buffer.push(chunk)
				}
			} else {
				// EOF
				this.#ended = true
				_setReadHandler(this.#fd, null)

				// Flush any remaining decoder buffer
				if (this.#decoder) {
					const remaining = this.#decoder.flush()
					if (remaining) {
						this.emit('data', remaining)
					}
				}

				this.emit('end')
				this.#close()
			}
		})
	}

	#handleError(err) {
		this.#ended = true
		if (this.#fd !== null) {
			_setReadHandler(this.#fd, null)
		}
		this.emit('error', err instanceof Error ? err : new Error(String(err)))
		this.#close()
	}

	#close() {
		if (this.#fd !== null) {
			try {
				closeSync(this.#fd)
			} catch (e) {
				// Ignore close errors
			}
			this.#fd = null
		}
		if (!this.#destroyed) {
			this.#destroyed = true
			this.emit('close')
		}
	}

	/**
	 * Pause the stream - stop emitting 'data' events
	 * @returns {this}
	 */
	pause() {
		this.#flowing = false
		return this
	}

	/**
	 * Resume the stream - start emitting 'data' events again
	 * @returns {this}
	 */
	resume() {
		if (!this.#flowing) {
			this.#flowing = true
			// Flush buffered data
			while (this.#buffer.length > 0 && this.#flowing) {
				const chunk = this.#buffer.shift()
				this.emit('data', chunk)
			}
		}
		return this
	}

	/**
	 * Destroy the stream
	 * @param {Error} [error] - Optional error to emit
	 */
	destroy(error) {
		if (this.#destroyed) return

		if (this.#fd !== null) {
			_setReadHandler(this.#fd, null)
		}

		if (error) {
			this.emit('error', error)
		}

		this.#close()
	}

	/**
	 * Whether the stream has ended
	 * @returns {boolean}
	 */
	get readableEnded() {
		return this.#ended
	}

	/**
	 * Whether the stream is destroyed
	 * @returns {boolean}
	 */
	get destroyed() {
		return this.#destroyed
	}

	/**
	 * Convert a Web ReadableStream (or any object with getReader()) to a Node.js Readable.
	 * @param {object} webStream - Object with getReader() method
	 * @returns {Readable}
	 */
	static fromWeb(webStream, options) {
		const readable = new Readable(null)
		const reader = webStream.getReader()
		async function pump() {
			try {
				while (true) {
					const { value, done } = await reader.read()
					if (done) {
						readable.emit('end')
						readable.emit('close')
						break
					}
					readable.emit('data', Buffer.isBuffer(value) ? value : Buffer.from(value))
				}
			} catch (err) {
				readable.emit('error', err)
				readable.emit('close')
			}
		}
		pump()
		return readable
	}

	/**
	 * Convert a Node.js Readable to an async-iterable object
	 * compatible with qn's Response (which accepts async iterables).
	 * @param {Readable} streamReadable - Node.js Readable stream
	 * @returns {object} Async iterable with getReader()
	 */
	static toWeb(streamReadable) {
		const stream = {
			async *[Symbol.asyncIterator]() {
				const chunks = []
				let resolve
				let done = false
				let error = null

				streamReadable.on('data', (chunk) => {
					const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
					if (resolve) {
						const r = resolve
						resolve = null
						r({ value: buf, done: false })
					} else {
						chunks.push(buf)
						// Backpressure: pause source when consumer isn't keeping up
						if (streamReadable.pause) streamReadable.pause()
					}
				})
				streamReadable.on('end', () => {
					done = true
					if (resolve) {
						const r = resolve
						resolve = null
						r({ value: undefined, done: true })
					}
				})
				streamReadable.on('error', (err) => {
					error = err
					done = true
					if (resolve) {
						const r = resolve
						resolve = null
						r({ value: undefined, done: true })
					}
				})

				try {
					while (true) {
						if (error) throw error
						if (chunks.length > 0) {
							yield chunks.shift()
							// Resume source once buffer is drained
							if (chunks.length === 0 && streamReadable.resume) streamReadable.resume()
							continue
						}
						if (done) return
						const result = await new Promise(r => { resolve = r })
						if (result.done) return
						yield result.value
					}
				} finally {
					if (!streamReadable.destroyed) streamReadable.destroy()
				}
			},
			getReader() {
				const iter = this[Symbol.asyncIterator]()
				return {
					async read() {
						const { value, done } = await iter.next()
						return { value: done ? undefined : value, done }
					},
					releaseLock() {},
					cancel() {
						if (!streamReadable.destroyed) streamReadable.destroy()
					},
				}
			}
		}
		return stream
	}
}

/**
 * Writable stream that wraps a file descriptor.
 * Supports backpressure via 'drain' events.
 * @extends EventEmitter
 *
 * Events:
 * - 'drain' - Emitted when buffer has been flushed and more data can be written
 * - 'finish' - Emitted when end() is called and all data has been flushed
 * - 'error' (err: Error) - Emitted on write error
 * - 'close' - Emitted when stream is closed
 */
export class Writable extends EventEmitter {
	/** @type {number|null} */
	#fd = null

	/** @type {boolean} */
	#finished = false

	/** @type {boolean} */
	#destroyed = false

	/** @type {boolean} */
	#ending = false

	/** @type {Uint8Array[]} */
	#writeQueue = []

	/** @type {Function[]} */
	#callbackQueue = []

	/** @type {boolean} */
	#corked = false

	/** @type {boolean} */
	#needDrain = false

	/**
	 * @param {number} fd - File descriptor to write to
	 */
	constructor(fd) {
		super()
		this.#fd = fd
	}

	/**
	 * Write data to the stream
	 * @param {string|Uint8Array} chunk - Data to write
	 * @param {string|Function} [encoding] - Encoding (ignored, always UTF-8 for strings)
	 * @param {Function} [callback] - Called when chunk has been written
	 * @returns {boolean} - false if buffer is full (wait for 'drain')
	 */
	write(chunk, encoding, callback) {
		// Handle overloaded arguments
		if (typeof encoding === 'function') {
			callback = encoding
			encoding = undefined
		}

		if (this.#destroyed || this.#ending) {
			const err = new Error('write after end')
			if (callback) {
				_setTimeout(() => callback(err), 0)
			}
			this.emit('error', err)
			return false
		}

		// Convert to Uint8Array
		let bytes
		if (chunk instanceof Uint8Array) {
			bytes = chunk
		} else if (typeof chunk === 'string') {
			bytes = encodeUtf8(chunk)
		} else {
			bytes = encodeUtf8(String(chunk))
		}

		this.#writeQueue.push(bytes)
		if (callback) {
			this.#callbackQueue.push(callback)
		} else {
			this.#callbackQueue.push(null)
		}

		if (!this.#corked) {
			this.#flush()
		}

		// Return false if we have pending writes (backpressure)
		if (this.#writeQueue.length > 0) {
			this.#needDrain = true
			return false
		}

		return true
	}

	#flush() {
		if (this.#fd === null || this.#destroyed) return

		while (this.#writeQueue.length > 0) {
			const bytes = this.#writeQueue[0]
			const callback = this.#callbackQueue[0]

			let written
			try {
				written = writeSync(this.#fd, bytes)
			} catch (e) {
				// EAGAIN/EWOULDBLOCK - set up write handler for when fd is writable
				if (e.errno === UV_EAGAIN) {
					this.#setupWriteHandler()
					return
				}
				this.#handleError(e)
				return
			}

			if (written < bytes.length) {
				// Partial write - update queue with remaining data
				this.#writeQueue[0] = bytes.subarray(written)
				this.#setupWriteHandler()
				return
			}

			// Full write - remove from queue and call callback
			this.#writeQueue.shift()
			this.#callbackQueue.shift()
			if (callback) {
				callback(null)
			}
		}

		// All data written
		if (this.#needDrain) {
			this.#needDrain = false
			this.emit('drain')
		}

		if (this.#ending) {
			this.#finishEnd()
		}
	}

	#setupWriteHandler() {
		if (this.#fd === null) return

		_setWriteHandler(this.#fd, () => {
			_setWriteHandler(this.#fd, null)
			this.#flush()
		})
	}

	#handleError(err) {
		this.#destroyed = true
		if (this.#fd !== null) {
			_setWriteHandler(this.#fd, null)
		}
		this.emit('error', err instanceof Error ? err : new Error(String(err)))
		this.#close()
	}

	#close() {
		if (this.#fd !== null) {
			try {
				closeSync(this.#fd)
			} catch (e) {
				// Ignore close errors
			}
			this.#fd = null
		}
		if (!this.#destroyed) {
			this.#destroyed = true
		}
		this.emit('close')
	}

	#finishEnd() {
		if (this.#finished) return
		this.#finished = true
		this.emit('finish')
		this.#close()
	}

	/**
	 * Signal that no more data will be written
	 * @param {string|Uint8Array} [chunk] - Optional final chunk to write
	 * @param {string|Function} [encoding] - Encoding (ignored)
	 * @param {Function} [callback] - Called when stream is finished
	 */
	end(chunk, encoding, callback) {
		// Handle overloaded arguments
		if (typeof chunk === 'function') {
			callback = chunk
			chunk = undefined
			encoding = undefined
		} else if (typeof encoding === 'function') {
			callback = encoding
			encoding = undefined
		}

		if (chunk !== undefined) {
			this.write(chunk)
		}

		this.#ending = true

		if (callback) {
			this.once('finish', callback)
		}

		if (this.#writeQueue.length === 0) {
			this.#finishEnd()
		}
	}

	/**
	 * Destroy the stream
	 * @param {Error} [error] - Optional error to emit
	 */
	destroy(error) {
		if (this.#destroyed) return

		// Cancel pending callbacks
		for (const cb of this.#callbackQueue) {
			if (cb) cb(error || new Error('stream destroyed'))
		}
		this.#writeQueue = []
		this.#callbackQueue = []

		if (this.#fd !== null) {
			_setWriteHandler(this.#fd, null)
		}

		if (error) {
			this.emit('error', error)
		}

		this.#close()
	}

	/**
	 * Cork the stream - buffer writes until uncork() is called
	 */
	cork() {
		this.#corked = true
	}

	/**
	 * Uncork the stream - flush buffered writes
	 */
	uncork() {
		this.#corked = false
		this.#flush()
	}

	/**
	 * Whether the stream is finished
	 * @returns {boolean}
	 */
	get writableFinished() {
		return this.#finished
	}

	/**
	 * Whether the stream is destroyed
	 * @returns {boolean}
	 */
	get destroyed() {
		return this.#destroyed
	}
}

export default { Readable, Writable, Transform, Duplex, PassThrough }
