/**
 * Shared Node.js-compatible globals for qn and qx
 *
 * This module sets up global APIs that are standard in both browsers and Node.js.
 * Import this module early in bootstrap to make these globals available.
 */

import * as std from "std"
import {
	setTimeout as _setTimeout, clearTimeout as _clearTimeout,
	timerRef as _timerRef, timerUnref as _timerUnref,
	setReadHandler, setWriteHandler,
} from 'qn_vm'

// DOMException (Web standard, used by fetch and AbortController)
// Must be defined early before modules that use it are imported
globalThis.DOMException = class DOMException extends Error {
	constructor(message = '', name = 'Error') {
		super(message)
		this.name = name
	}
}

// Error.captureStackTrace (V8 API, used by ws and many npm packages)
if (!Error.captureStackTrace) {
	Error.captureStackTrace = (targetObject, constructorOpt) => {
		const err = new Error()
		if (err.stack) {
			targetObject.stack = err.stack
		}
	}
}

// Node.js compatibility error for unsupported features
export { NodeCompatibilityError } from "./node/errors.js"

// Timer globals — implementation lives in node:timers, globalized here
import * as timers from "node:timers"
globalThis.setTimeout = timers.setTimeout
globalThis.clearTimeout = timers.clearTimeout
globalThis.setInterval = timers.setInterval
globalThis.clearInterval = timers.clearInterval
globalThis.setImmediate = timers.setImmediate
globalThis.clearImmediate = timers.clearImmediate

// ReadableStream (WHATWG Streams API subset)
globalThis.ReadableStream = class ReadableStream {
	constructor(underlyingSource = {}) {
		this._controller = { _queue: [], _closed: false, _errored: null, _resolve: null }
		const controller = {
			enqueue: (chunk) => {
				if (this._controller._resolve) {
					const resolve = this._controller._resolve
					this._controller._resolve = null
					resolve({ value: chunk, done: false })
				} else {
					this._controller._queue.push(chunk)
				}
			},
			close: () => {
				this._controller._closed = true
				if (this._controller._resolve) {
					const resolve = this._controller._resolve
					this._controller._resolve = null
					resolve({ value: undefined, done: true })
				}
			},
			error: (err) => {
				this._controller._errored = err
				if (this._controller._resolve) {
					const resolve = this._controller._resolve
					this._controller._resolve = null
					// reject via a stored reject
					if (this._controller._reject) {
						this._controller._reject(err)
						this._controller._reject = null
					}
				}
			},
		}
		this._cancel = underlyingSource.cancel?.bind(underlyingSource)
		if (underlyingSource.start) underlyingSource.start(controller)
	}

	getReader() {
		const ctrl = this._controller
		return {
			read() {
				if (ctrl._queue.length > 0)
					return Promise.resolve({ value: ctrl._queue.shift(), done: false })
				if (ctrl._closed)
					return Promise.resolve({ value: undefined, done: true })
				if (ctrl._errored)
					return Promise.reject(ctrl._errored)
				return new Promise((resolve, reject) => {
					ctrl._resolve = resolve
					ctrl._reject = reject
				})
			},
			releaseLock() {},
			cancel() {},
		}
	}

	async *[Symbol.asyncIterator]() {
		const reader = this.getReader()
		try {
			for (;;) {
				const { value, done } = await reader.read()
				if (done) return
				yield value
			}
		} finally {
			reader.releaseLock()
		}
	}
}

// queueMicrotask (Web standard, also in Node.js)
// QuickJS doesn't have a separate microtask queue, but setTimeout(fn, 0)
// integrates with the event loop and fires before the next I/O poll.
globalThis.queueMicrotask = (fn) => _setTimeout(fn, 0)

// Performance API — implementation lives in node:perf_hooks, globalized here
import { performance } from "node:perf_hooks"
globalThis.performance = performance

// Base64 encoding/decoding
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = new Uint8Array(128)
for (let i = 0; i < BASE64_CHARS.length; i++) {
	BASE64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i
}

globalThis.btoa = (str) => {
	let result = ''
	for (let i = 0; i < str.length; i += 3) {
		const b1 = str.charCodeAt(i), b2 = str.charCodeAt(i + 1) || 0, b3 = str.charCodeAt(i + 2) || 0
		result += BASE64_CHARS[b1 >> 2]
		result += BASE64_CHARS[((b1 & 3) << 4) | (b2 >> 4)]
		result += i + 1 < str.length ? BASE64_CHARS[((b2 & 15) << 2) | (b3 >> 6)] : '='
		result += i + 2 < str.length ? BASE64_CHARS[b3 & 63] : '='
	}
	return result
}

globalThis.atob = (str) => {
	let end = str.length
	while (end > 0 && str[end - 1] === '=') end--
	let result = ''
	for (let i = 0; i < end; i += 4) {
		const b1 = BASE64_LOOKUP[str.charCodeAt(i)]
		const b2 = BASE64_LOOKUP[str.charCodeAt(i + 1)]
		const b3 = BASE64_LOOKUP[str.charCodeAt(i + 2)]
		const b4 = BASE64_LOOKUP[str.charCodeAt(i + 3)]
		result += String.fromCharCode((b1 << 2) | (b2 >> 4))
		if (i + 2 < end) result += String.fromCharCode(((b2 & 15) << 4) | (b3 >> 2))
		if (i + 3 < end) result += String.fromCharCode(((b3 & 3) << 6) | b4)
	}
	return result
}

// TextEncoder/TextDecoder (Web standard, also in Node.js)
globalThis.TextEncoder = class TextEncoder {
	encoding = 'utf-8'

	encode(string) {
		if (typeof string !== 'string') {
			string = String(string)
		}
		return new Uint8Array(std._encodeUtf8(string))
	}

	encodeInto(string, uint8Array) {
		if (typeof string !== 'string') {
			string = String(string)
		}
		const encoded = new Uint8Array(std._encodeUtf8(string))
		const len = Math.min(encoded.length, uint8Array.length)
		uint8Array.set(encoded.subarray(0, len))
		return {
			read: string.length,
			written: len
		}
	}
}

globalThis.TextDecoder = class TextDecoder {
	constructor(encoding = 'utf-8', options = {}) {
		const normalizedEncoding = encoding.toLowerCase().replace('-', '')
		if (normalizedEncoding !== 'utf8') {
			throw new TypeError(`TextDecoder: '${encoding}' encoding not supported. Only UTF-8 is supported.`)
		}
		if (options.fatal) {
			throw new NodeCompatibilityError('TextDecoder: fatal option is not supported')
		}
		this.encoding = 'utf-8'
		this.fatal = false
		this.ignoreBOM = !!options.ignoreBOM
	}

	decode(input, options = {}) {
		if (options.stream) {
			throw new NodeCompatibilityError('TextDecoder: stream option is not supported')
		}
		if (input === undefined) {
			return ''
		}
		let buffer
		if (input instanceof ArrayBuffer) {
			buffer = input
		} else if (ArrayBuffer.isView(input)) {
			buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
		} else {
			throw new TypeError('TextDecoder.decode: input must be ArrayBuffer or ArrayBufferView')
		}
		let result = std._decodeUtf8(buffer)
		// Strip BOM if present (default behavior per WHATWG spec)
		if (!this.ignoreBOM && result.length > 0 && result.charCodeAt(0) === 0xFEFF) {
			result = result.slice(1)
		}
		return result
	}
}

// URL and URLSearchParams (Web standard, also in Node.js)
import { URL, URLSearchParams } from "node:url"
globalThis.URL = URL
globalThis.URLSearchParams = URLSearchParams

// Fetch API (Web standard, also in Node.js)
import { fetch, Headers, Request, Response } from "node:fetch"
globalThis.fetch = fetch
globalThis.Headers = Headers
globalThis.Request = Request
globalThis.Response = Response

// AbortController/AbortSignal (Web standard, also in Node.js)
import { AbortController, AbortSignal } from "node:abort"
globalThis.AbortController = AbortController
globalThis.AbortSignal = AbortSignal

// Process (Node.js global)
import process from "node:process"
globalThis.process = process

// Buffer (Node.js global)
import { Buffer } from "node:buffer"
globalThis.Buffer = Buffer

// Worker (Web standard)
import { Worker } from "qn:worker"
globalThis.Worker = Worker

// Add missing console methods for Node.js compatibility
console.error = (...args) => { std.err.puts(args.join(' ') + '\n'); std.err.flush() }
console.warn = console.error
console.info = console.log
console.debug = console.log

// console.time / timeEnd / timeLog for performance measurement
const consoleTimers = new Map()

console.time = (label = 'default') => {
	if (consoleTimers.has(label)) {
		console.warn(`Warning: Label '${label}' already exists for console.time()`)
		return
	}
	consoleTimers.set(label, performance.now())
}

console.timeEnd = (label = 'default') => {
	const start = consoleTimers.get(label)
	if (start === undefined) {
		console.warn(`Warning: No such label '${label}' for console.timeEnd()`)
		return
	}
	const duration = performance.now() - start
	consoleTimers.delete(label)
	console.log(`${label}: ${duration.toFixed(3)}ms`)
}

console.timeLog = (label = 'default', ...data) => {
	const start = consoleTimers.get(label)
	if (start === undefined) {
		console.warn(`Warning: No such label '${label}' for console.timeLog()`)
		return
	}
	const duration = performance.now() - start
	if (data.length > 0) {
		console.log(`${label}: ${duration.toFixed(3)}ms`, ...data)
	} else {
		console.log(`${label}: ${duration.toFixed(3)}ms`)
	}
}
