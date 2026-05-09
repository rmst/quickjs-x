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

// structuredClone (WHATWG HTML, in Node.js 17+)
// Pure-JS implementation. Transferables are not supported.
const _TYPED_ARRAY_TAGS = {
	'[object Int8Array]': Int8Array,
	'[object Uint8Array]': Uint8Array,
	'[object Uint8ClampedArray]': Uint8ClampedArray,
	'[object Int16Array]': Int16Array,
	'[object Uint16Array]': Uint16Array,
	'[object Int32Array]': Int32Array,
	'[object Uint32Array]': Uint32Array,
	'[object Float32Array]': Float32Array,
	'[object Float64Array]': Float64Array,
	'[object BigInt64Array]': BigInt64Array,
	'[object BigUint64Array]': BigUint64Array,
}

const _ERROR_CTORS = {
	Error, EvalError, RangeError, ReferenceError,
	SyntaxError, TypeError, URIError,
}

const _dataCloneError = (msg) => new DOMException(msg, 'DataCloneError')

const _structuredClone = (value, seen) => {
	if (typeof value === 'symbol')
		throw _dataCloneError(`${value.toString()} could not be cloned.`)

	// Primitives (incl. null, undefined, bigint)
	if (value === null || typeof value !== 'object' && typeof value !== 'function')
		return value

	if (typeof value === 'function')
		throw _dataCloneError(`${value.constructor?.name ?? 'Function'} could not be cloned.`)

	if (seen.has(value)) return seen.get(value)

	const tag = Object.prototype.toString.call(value)

	switch (tag) {
		case '[object Date]': {
			const out = new Date(value.getTime())
			seen.set(value, out)
			return out
		}
		case '[object RegExp]': {
			// Per spec: clone source and flags, but not lastIndex
			const out = new RegExp(value.source, value.flags)
			seen.set(value, out)
			return out
		}
		case '[object ArrayBuffer]': {
			const out = value.slice(0)
			seen.set(value, out)
			return out
		}
		case '[object SharedArrayBuffer]': {
			// SAB is shared, not copied
			seen.set(value, value)
			return value
		}
		case '[object DataView]': {
			const buf = _structuredClone(value.buffer, seen)
			const out = new DataView(buf, value.byteOffset, value.byteLength)
			seen.set(value, out)
			return out
		}
		case '[object Map]': {
			const out = new Map()
			seen.set(value, out)
			for (const [k, v] of value)
				out.set(_structuredClone(k, seen), _structuredClone(v, seen))
			return out
		}
		case '[object Set]': {
			const out = new Set()
			seen.set(value, out)
			for (const v of value)
				out.add(_structuredClone(v, seen))
			return out
		}
		case '[object Array]': {
			const out = new Array(value.length)
			seen.set(value, out)
			for (const k of Object.keys(value))
				out[k] = _structuredClone(value[k], seen)
			return out
		}
		case '[object Boolean]':
		case '[object Number]':
		case '[object String]': {
			// Boxed primitives
			const out = new value.constructor(value.valueOf())
			seen.set(value, out)
			return out
		}
		case '[object Error]': {
			const Ctor = _ERROR_CTORS[value.name] ?? Error
			const out = new Ctor(value.message)
			if (value.stack !== undefined) out.stack = value.stack
			if ('cause' in value)
				Object.defineProperty(out, 'cause', {
					value: _structuredClone(value.cause, seen),
					writable: true, configurable: true,
				})
			seen.set(value, out)
			return out
		}
	}

	// Typed arrays — detected by Symbol.toStringTag, so subclasses (e.g. Buffer)
	// are cloned as their standard typed-array form, matching Node.js.
	const TaCtor = _TYPED_ARRAY_TAGS[tag]
	if (TaCtor) {
		const buf = _structuredClone(value.buffer, seen)
		const out = new TaCtor(buf, value.byteOffset, value.length)
		seen.set(value, out)
		return out
	}

	// Reject things we know are not cloneable
	if (value instanceof WeakMap || value instanceof WeakSet ||
			value instanceof Promise)
		throw _dataCloneError(`${value.constructor.name} could not be cloned.`)

	// Ordinary objects (incl. class instances) — cloned as plain objects with
	// only enumerable own string-keyed properties. The class's prototype is
	// dropped, but a null prototype is preserved (matches Node).
	const out = Object.getPrototypeOf(value) === null ? Object.create(null) : {}
	seen.set(value, out)
	for (const k of Object.keys(value))
		out[k] = _structuredClone(value[k], seen)
	return out
}

globalThis.structuredClone = function structuredClone(value, options) {
	if (arguments.length < 1)
		throw new TypeError("structuredClone requires at least 1 argument")
	if (options?.transfer !== undefined && options.transfer.length > 0)
		throw _dataCloneError("structuredClone: transferables are not supported")
	return _structuredClone(value, new Map())
}

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

// Web Crypto API (W3C spec; subset compatible with browsers and Node.js)
import { hashInit as _hashInit, hashUpdate as _hashUpdate, hashOut as _hashOut } from 'qn:crypto'
import { randomFill as _randomFill } from 'qn_vm'

const _SUBTLE_HASH_ALGOS = {
	'sha-1': 'sha1',
	'sha-256': 'sha256',
	'sha-384': 'sha384',
	'sha-512': 'sha512',
}

const _INT_TYPED_ARRAYS = [
	Int8Array, Uint8Array, Uint8ClampedArray,
	Int16Array, Uint16Array,
	Int32Array, Uint32Array,
	BigInt64Array, BigUint64Array,
]

const _bufferSourceToBytes = (data) => {
	if (data instanceof ArrayBuffer) return new Uint8Array(data)
	if (ArrayBuffer.isView(data))
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
	throw new TypeError('Expected BufferSource (ArrayBuffer, TypedArray, or DataView)')
}

class SubtleCrypto {
	async digest(algorithm, data) {
		const name = (typeof algorithm === 'string' ? algorithm : algorithm?.name ?? '').toLowerCase()
		const internal = _SUBTLE_HASH_ALGOS[name]
		if (!internal)
			throw new DOMException(`Unrecognized algorithm name: ${name}`, 'NotSupportedError')
		const bytes = _bufferSourceToBytes(data)
		const ctx = _hashInit(internal)
		_hashUpdate(ctx, bytes)
		return _hashOut(ctx)
	}
}

const _subtleCrypto = new SubtleCrypto()

class Crypto {
	get subtle() { return _subtleCrypto }

	getRandomValues(typedArray) {
		if (typedArray == null || !ArrayBuffer.isView(typedArray) ||
				!_INT_TYPED_ARRAYS.some(c => typedArray instanceof c))
			throw new DOMException(
				'crypto.getRandomValues: input must be an integer-typed array',
				'TypeMismatchError')
		if (typedArray.byteLength > 65536)
			throw new DOMException(
				'crypto.getRandomValues: byteLength exceeds 65536',
				'QuotaExceededError')
		if (typedArray.byteLength === 0) return typedArray
		const bytes = _randomFill(typedArray.byteLength)
		new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength).set(bytes)
		return typedArray
	}

	randomUUID() {
		const bytes = _randomFill(16)
		bytes[6] = (bytes[6] & 0x0f) | 0x40
		bytes[8] = (bytes[8] & 0x3f) | 0x80
		const hex = new Array(16)
		for (let i = 0; i < 16; i++) hex[i] = bytes[i].toString(16).padStart(2, '0')
		const h = hex.join('')
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
	}
}

globalThis.Crypto = Crypto
globalThis.SubtleCrypto = SubtleCrypto
globalThis.crypto = new Crypto()

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
