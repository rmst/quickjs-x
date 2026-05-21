/**
 * node:http - HTTP server and client
 * @see https://nodejs.org/api/http.html
 */

import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import { createConnection, createServer as createTcpServer, Socket } from 'node:net'
import {
	bodyStream, buildRequest, handleHttpConnection, readResponseHead, socketReader,
	responseBodyFraming,
} from 'node:http/parse'

const CRLF = '\r\n'

const DEFAULT_HEADER_TIMEOUT = 60_000  // 60 seconds
const DEFAULT_KEEP_ALIVE_TIMEOUT = 5_000  // 5 seconds

function headersToObject(headers) {
	const out = {}
	for (const [key, value] of headers) {
		out[key.toLowerCase()] = value
	}
	return out
}

function normalizeRequestArgs(input, options, callback) {
	if (typeof options === 'function') {
		callback = options
		options = undefined
	}

	let opts = {}
	if (typeof input === 'string' || input instanceof URL) {
		const url = new URL(input)
		opts.protocol = url.protocol
		opts.hostname = url.hostname
		opts.host = url.hostname
		opts.port = url.port ? Number(url.port) : undefined
		opts.path = `${url.pathname || '/'}${url.search || ''}`
		if (url.username || url.password) {
			opts.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
		}
		opts = { ...opts, ...(options || {}) }
	} else {
		opts = { ...(input || {}) }
	}

	return { options: opts, callback }
}

function normalizeHeaders(headers = {}) {
	const out = new Map()
	if (headers instanceof Map || Array.isArray(headers)) {
		for (const [key, value] of headers) out.set(String(key).toLowerCase(), { key: String(key), value: String(value) })
		return out
	}
	for (const [key, value] of Object.entries(headers)) {
		out.set(key.toLowerCase(), { key, value: String(value) })
	}
	return out
}

function byteLength(data) {
	if (typeof data === 'string') return new TextEncoder().encode(data).byteLength
	if (data instanceof Uint8Array) return data.byteLength
	return new Uint8Array(data).byteLength
}

/**
 * Incoming HTTP message (request on server, response on client)
 *
 * Body is read lazily: the body iterator is only consumed when the handler
 * attaches a 'data' listener (flowing mode, matching Node.js behavior).
 */
export class IncomingMessage extends EventEmitter {
	#bodyIter = null
	#pumping = false
	#abandonTimer = null

	constructor(socket) {
		super()
		this.socket = socket
		this.headers = {}
		this.rawHeaders = []
		this.method = null
		this.url = null
		this.httpVersion = null
		this.statusCode = null
		this.statusMessage = null
		this.complete = false
	}

	/** @internal called by HTTPServer to provide the body iterator */
	_setBody(bodyIter, options = {}) {
		this.#bodyIter = bodyIter
		if (options.destroyIfUnconsumedAfter !== undefined) {
			this.#abandonTimer = setTimeout(() => {
				if (!this.#pumping && !this.complete) {
					this.socket.destroy()
				}
			}, options.destroyIfUnconsumedAfter)
			if (this.#abandonTimer.unref) this.#abandonTimer.unref()
		}
	}

	on(event, fn) {
		super.on(event, fn)
		if (event === 'data' && this.#bodyIter && !this.#pumping) {
			this.#pumping = true
			if (this.#abandonTimer) {
				clearTimeout(this.#abandonTimer)
				this.#abandonTimer = null
			}
			this.#pump()
		}
		return this
	}

	async #pump() {
		try {
			for await (const chunk of this.#bodyIter) {
				// Emit as Buffer (owned copy) so the listener can retain it
				// safely and `body += chunk` utf-8 decodes via Buffer.toString().
				// Some upstream chunks are views into a reusable read buffer,
				// so a copy is required to avoid corruption.
				this.emit('data', Buffer.from(chunk))
			}
		} catch (err) {
			this.emit('error', err instanceof Error ? err : new Error(String(err)))
			return
		}
		this.complete = true
		if (this.#abandonTimer) {
			clearTimeout(this.#abandonTimer)
			this.#abandonTimer = null
		}
		this.emit('end')
	}

	/**
	 * @internal Drain any unconsumed body data so the connection can be
	 * reused for the next request (keep-alive).
	 */
	async _drain() {
		if (this.complete) return
		if (!this.#pumping && this.#bodyIter) {
			try {
				for await (const _ of this.#bodyIter) {}
			} catch (err) {
				this.emit('error', err instanceof Error ? err : new Error(String(err)))
				throw err
			}
			this.complete = true
		} else if (this.#pumping) {
			await new Promise(r => this.once('end', r))
		}
	}

	// Node's IncomingMessage extends Readable, so `for await (const c of req)`
	// is the idiomatic way to read a request body. We don't extend Readable,
	// so bridge through the existing data/end/error event API instead. The
	// 'data' subscription below also kicks off #pump() via the on() override.
	[Symbol.asyncIterator]() {
		return this.#asyncIter()
	}

	async *#asyncIter() {
		const queue = []
		let resolveNext = null
		let ended = false
		let error = null

		const onData = (c) => {
			if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: c, done: false }) }
			else queue.push(c)
		}
		const onEnd = () => {
			ended = true
			if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }) }
		}
		const onError = (err) => {
			error = err
			if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }) }
		}

		this.on('data', onData)
		this.on('end', onEnd)
		this.on('error', onError)

		try {
			while (true) {
				if (error) throw error
				if (queue.length > 0) { yield queue.shift(); continue }
				if (ended) return
				const next = await new Promise(r => { resolveNext = r })
				if (error) throw error
				if (next.done) return
				yield next.value
			}
		} finally {
			this.off('data', onData)
			this.off('end', onEnd)
			this.off('error', onError)
		}
	}
}

/**
 * Server response object
 */
export class ServerResponse extends EventEmitter {
	#socket
	#headersSent = false
	#headers = {}
	#statusCode = 200
	#statusMessage = 'OK'
	#finished = false
	#keepAlive = false
	#onFinished = null

	constructor(socket, keepAlive) {
		super()
		this.#socket = socket
		this.#keepAlive = keepAlive
		socket.on('drain', () => this.emit('drain'))
	}

	get headersSent() { return this.#headersSent }
	get statusCode() { return this.#statusCode }
	set statusCode(code) { this.#statusCode = code }
	get statusMessage() { return this.#statusMessage }
	set statusMessage(msg) {
		if (/[\r\n]/.test(msg))
			throw new TypeError('Invalid status message: contains CR or LF')
		this.#statusMessage = msg
	}

	/** @internal resolve when response is fully written */
	_awaitFinish() {
		if (this.#finished) return Promise.resolve()
		return new Promise(r => { this.#onFinished = r })
	}

	setHeader(name, value) {
		if (/[\r\n]/.test(name) || /[\r\n]/.test(String(value))) {
			throw new TypeError(`Invalid header: ${name}`)
		}
		this.#headers[name.toLowerCase()] = value
	}

	getHeader(name) {
		return this.#headers[name.toLowerCase()]
	}

	removeHeader(name) {
		delete this.#headers[name.toLowerCase()]
	}

	getHeaderNames() {
		return Object.keys(this.#headers)
	}

	hasHeader(name) {
		return name.toLowerCase() in this.#headers
	}

	writeHead(statusCode, statusMessage, headers) {
		if (typeof statusMessage === 'object') {
			headers = statusMessage
			statusMessage = undefined
		}
		this.#statusCode = statusCode
		const msg = statusMessage || STATUS_CODES[statusCode] || 'Unknown'
		if (/[\r\n]/.test(msg))
			throw new TypeError('Invalid status message: contains CR or LF')
		this.#statusMessage = msg
		if (headers) {
			for (const [k, v] of Object.entries(headers)) {
				if (/[\r\n]/.test(k) || /[\r\n]/.test(String(v))) {
					throw new TypeError(`Invalid header: ${k}`)
				}
				this.#headers[k.toLowerCase()] = v
			}
		}
		return this
	}

	#sendHeaders() {
		if (this.#headersSent) return
		this.#headersSent = true

		let head = `HTTP/1.1 ${this.#statusCode} ${this.#statusMessage}${CRLF}`
		for (const [k, v] of Object.entries(this.#headers)) {
			if (Array.isArray(v)) {
				for (const item of v) {
					head += `${k}: ${item}${CRLF}`
				}
			} else {
				head += `${k}: ${v}${CRLF}`
			}
		}
		head += CRLF
		this.#socket.write(head)
	}

	write(chunk, encoding, callback) {
		if (typeof encoding === 'function') {
			callback = encoding
			encoding = undefined
		}
		if (!this.#headersSent) {
			if (!this.#headers['content-length'] && !this.#headers['transfer-encoding']) {
				this.#headers['transfer-encoding'] = 'chunked'
			}
			this.#sendHeaders()
		}

		if (typeof chunk === 'string') {
			chunk = new TextEncoder().encode(chunk)
		}

		if (this.#headers['transfer-encoding'] === 'chunked') {
			const hex = chunk.byteLength.toString(16)
			this.#socket.write(`${hex}${CRLF}`)
			this.#socket.write(chunk)
			return this.#socket.write(CRLF, undefined, callback)
		} else {
			return this.#socket.write(chunk, undefined, callback)
		}
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

		if (this.#finished) return this

		if (data !== undefined && data !== null) {
			if (!this.#headersSent) {
				const body = typeof data === 'string' ? new TextEncoder().encode(data) : data
				if (!this.#headers['content-length'] && !this.#headers['transfer-encoding']) {
					this.#headers['content-length'] = body.byteLength
				}
				this.#sendHeaders()
				this.#socket.write(body)
			} else {
				this.write(data)
			}
		} else if (!this.#headersSent) {
			if (!this.#headers['content-length']) {
				this.#headers['content-length'] = 0
			}
			this.#sendHeaders()
		}

		if (this.#headers['transfer-encoding'] === 'chunked') {
			this.#socket.write(`0${CRLF}${CRLF}`)
		}

		this.#finished = true
		if (!this.#keepAlive) {
			this.#socket.end()
		}
		if (callback) queueMicrotask(callback)
		this.emit('finish')
		if (this.#onFinished) this.#onFinished()
		return this
	}
}

export class ClientRequest extends EventEmitter {
	#options
	#headers
	#socket = null
	#connected = false
	#headerSent = false
	#ended = false
	#chunked = false
	#writeQueue = []
	#writeQueueOffset = 0
	#queuedBytes = 0
	#pendingWrites = 0
	#finishCallback = null
	#finished = false
	#readingResponse = false
	#destroyed = false
	#errored = false
	#socketBackpressured = false
	#method
	#path
	#host
	#port
	#socketPath
	#highWaterMark = 64 * 1024

	constructor(input, options, callback) {
		super()
		const normalized = normalizeRequestArgs(input, options, callback)
		this.#options = normalized.options
		this.#headers = normalizeHeaders(this.#options.headers)
		this.#method = String(this.#options.method || 'GET').toUpperCase()
		this.#path = this.#options.path || '/'
		this.#socketPath = this.#options.socketPath
		this.#host = this.#options.hostname || this.#options.host || 'localhost'
		this.#port = this.#options.port ? Number(this.#options.port) : 80

		if (normalized.callback) this.once('response', normalized.callback)
		this.#connect()
	}

	setHeader(name, value) {
		if (this.#headerSent) throw new Error('Cannot set headers after they are sent')
		this.#headers.set(String(name).toLowerCase(), { key: String(name), value: String(value) })
		return this
	}

	getHeader(name) {
		return this.#headers.get(String(name).toLowerCase())?.value
	}

	removeHeader(name) {
		if (this.#headerSent) throw new Error('Cannot remove headers after they are sent')
		this.#headers.delete(String(name).toLowerCase())
	}

	write(chunk, encoding, callback) {
		if (typeof encoding === 'function') {
			callback = encoding
			encoding = undefined
		}
		if (this.#ended) {
			const err = new Error('write after end')
			if (callback) callback(err)
			this.emit('error', err)
			return false
		}
		let ret = this.#sendHead(true)
		ret = this.#writeBody(chunk, callback) && ret
		return ret
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
		if (this.#ended) return this
		this.#ended = true

		if (data !== undefined && data !== null && !this.#headerSent && !this.getHeader('content-length')) {
			this.setHeader('Content-Length', byteLength(data))
		}

		this.#finishCallback = callback || null
		this.#sendHead(data !== undefined && data !== null)
		if (data !== undefined && data !== null) this.#writeBody(data)
		if (this.#chunked) this.#writeRaw('0\r\n\r\n')
		this.#maybeFinishRequest()
		return this
	}

	abort() {
		this.destroy()
	}

	destroy(err) {
		if (this.#destroyed) return this
		this.#destroyed = true
		if (this.#socket) this.#socket.destroy(err)
		else if (err) this.#emitError(err)
		return this
	}

	#connect() {
		const connectOptions = this.#socketPath
			? { path: this.#socketPath }
			: { host: this.#host, port: this.#port }
		this.#socket = createConnection(connectOptions, () => {
			this.#connected = true
			this.emit('socket', this.#socket)
			this.#flush()
		})
		this.#socket.on('error', (err) => this.#emitError(err))
		this.#socket.on('drain', () => {
			this.#socketBackpressured = false
			this.#flush()
			if (!this.#destroyed && this.#queuedBytes < this.#highWaterMark) this.emit('drain')
		})
		this.#socket.on('close', () => this.emit('close'))
	}

	#sendHead(hasBody) {
		if (this.#headerSent) return true
		if (hasBody && !this.getHeader('content-length')) {
			this.#headers.set('transfer-encoding', { key: 'Transfer-Encoding', value: 'chunked' })
			this.#chunked = true
		}
		const req = buildRequest(
			this.#method,
			this.#path,
			this.#headers.get('host')?.value || this.#host,
			this.#port,
			Array.from(this.#headers.values()).map(({ key, value }) => [key, value]),
			this.#port === 80,
		)
		this.#headerSent = true
		return this.#writeRaw(req)
	}

	#writeBody(chunk, callback) {
		if (this.#chunked) {
			const data = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
			let ret = this.#writeRaw(data.byteLength.toString(16) + CRLF)
			ret = this.#writeRaw(data) && ret
			ret = this.#writeRaw(CRLF, callback) && ret
			return ret
		}
		return this.#writeRaw(chunk, callback)
	}

	#writeRaw(data, callback) {
		const chunk = typeof data === 'string' ? new TextEncoder().encode(data) : data
		const size = chunk.byteLength ?? chunk.length ?? 0
		if (!this.#connected || this.#socketBackpressured || this.#writeQueue.length > this.#writeQueueOffset) {
			this.#writeQueue.push({ data: chunk, callback, size })
			this.#queuedBytes += size
			return this.#queuedBytes < this.#highWaterMark
		}
		return this.#writeNow(chunk, callback)
	}

	#flush() {
		if (!this.#connected || this.#destroyed) return
		while (this.#writeQueueOffset < this.#writeQueue.length) {
			const { data, callback, size } = this.#writeQueue[this.#writeQueueOffset++]
			this.#queuedBytes -= size
			const ret = this.#writeNow(data, callback)
			if (!ret) break
		}
		if (this.#writeQueueOffset > 1024 || this.#writeQueueOffset === this.#writeQueue.length) {
			this.#writeQueue = this.#writeQueue.slice(this.#writeQueueOffset)
			this.#writeQueueOffset = 0
		}
		this.#maybeFinishRequest()
	}

	#writeNow(data, callback) {
		this.#pendingWrites++
		const ret = this.#socket.write(data, (err) => {
			this.#pendingWrites--
			if (callback) callback(err || null)
			if (err) this.#emitError(err)
			this.#maybeFinishRequest()
		})
		if (!ret) this.#socketBackpressured = true
		return ret
	}

	#maybeFinishRequest() {
		if (!this.#ended || this.#finished || this.#destroyed || this.#errored) return
		if (this.#writeQueue.length > this.#writeQueueOffset || this.#pendingWrites > 0) return
		this.#finished = true
		if (this.#finishCallback) this.#finishCallback()
		this.emit('finish')
		this.#readResponse()
	}

	async #readResponse() {
		if (this.#readingResponse || this.#destroyed) return
		this.#readingResponse = true
		try {
			const reader = socketReader(this.#socket)
			const head = await readResponseHead(reader)
			if (!head) {
				if (!this.#errored && !this.#destroyed) this.#emitError(new Error('socket hang up'))
				return
			}

			const res = new IncomingMessage(this.#socket)
			res.statusCode = head.status
			res.statusMessage = head.statusText
			res.httpVersion = head.httpVersion
			res.headers = headersToObject(head.headers)
			res.rawHeaders = head.rawHeaders

			const { contentLength, isChunked } = responseBodyFraming(head, this.#method)
			res._setBody(bodyStream(reader, head.leftover, contentLength, isChunked), {
				destroyIfUnconsumedAfter: 300_000,
			})

			this.emit('response', res)
		} catch (err) {
			if (!this.#destroyed) this.#emitError(err instanceof Error ? err : new Error(String(err)))
		}
	}

	#emitError(err) {
		if (this.#errored) return
		this.#errored = true
		this.emit('error', err)
	}
}

/**
 * HTTP Server
 *
 * Events: 'request', 'upgrade', 'listening', 'close', 'error'
 */
const DEFAULT_MAX_HEADER_SIZE = 64 * 1024  // 64 KB
const DEFAULT_MAX_HEADER_COUNT = 128

export class HTTPServer extends EventEmitter {
	#server
	#sockets = new Set()
	#maxHeaderSize
	#maxHeaderCount
	#headerTimeout
	#keepAliveTimeout

	constructor(options, requestListener) {
		super()
		if (typeof options === 'function') {
			requestListener = options
			options = {}
		}
		this.#maxHeaderSize = options?.maxHeaderSize ?? DEFAULT_MAX_HEADER_SIZE
		this.#maxHeaderCount = options?.maxHeaderCount ?? DEFAULT_MAX_HEADER_COUNT
		this.#headerTimeout = options?.headerTimeout ?? DEFAULT_HEADER_TIMEOUT
		this.#keepAliveTimeout = options?.keepAliveTimeout ?? DEFAULT_KEEP_ALIVE_TIMEOUT
		if (requestListener) {
			this.on('request', requestListener)
		}
		this.#server = createTcpServer()
		this.#server.on('error', (err) => this.emit('error', err))
		this.#server.on('close', () => this.emit('close'))

		this.#server.on('connection', (socket) => {
			this.#sockets.add(socket)
			socket.on('close', () => this.#sockets.delete(socket))
			socket.on('error', () => {})
			this.#handleConnection(socket)
		})
	}

	get headerTimeout() { return this.#headerTimeout }
	set headerTimeout(ms) { this.#headerTimeout = ms }
	get keepAliveTimeout() { return this.#keepAliveTimeout }
	set keepAliveTimeout(ms) { this.#keepAliveTimeout = ms }

	#handleConnection(socket) {
		handleHttpConnection(
			socket,
			{
				headerTimeout: this.#headerTimeout,
				keepAliveTimeout: this.#keepAliveTimeout,
				maxHeaderSize: this.#maxHeaderSize,
				maxHeaderCount: this.#maxHeaderCount,
			},
			async ({ head, socket, keepAlive, bodyIter }) => {
				const req = new IncomingMessage(socket)
				req.method = head.method
				req.url = head.url
				req.httpVersion = head.httpVersion
				req.headers = head.headers
				req.rawHeaders = head.rawHeaders

				const res = new ServerResponse(socket, keepAlive)
				if (!keepAlive) {
					res.setHeader('connection', 'close')
				}

				if (bodyIter) {
					req._setBody(bodyIter)
				} else {
					req.complete = true
					queueMicrotask(() => req.emit('end'))
				}

				this.emit('request', req, res)

				await res._awaitFinish()

				// Drain unconsumed body so the socket is clean for the next request
				if (bodyIter) {
					await req._drain()
					return { bodyDrained: true }
				}
			},
			// onUpgrade
			({ head, socket, headBuf }) => {
				const req = new IncomingMessage(socket)
				req.method = head.method
				req.url = head.url
				req.httpVersion = head.httpVersion
				req.headers = head.headers
				req.rawHeaders = head.rawHeaders
				req.complete = true

				const buf = headBuf.length > 0 ? Buffer.from(headBuf) : Buffer.alloc(0)

				if (this.listenerCount('upgrade') > 0) {
					this.emit('upgrade', req, socket, buf)
				} else {
					socket.destroy()
				}
			},
			// onError
			(statusCode, statusText) => {
				const res = new ServerResponse(socket, false)
				res.writeHead(statusCode, { 'Connection': 'close' })
				res.end(statusText)
			},
		)
	}

	listen(port, host, backlog, callback) {
		this.#server.listen(port, host, backlog, () => {
			this.emit('listening')
			if (typeof callback === 'function') callback()
		})
		return this
	}

	address() {
		return this.#server.address()
	}

	close(callback) {
		this.#server.close(callback)
		return this
	}

	closeAllConnections() {
		for (const socket of this.#sockets) {
			socket.destroy()
		}
	}

	ref() { return this }
	unref() { return this }

	get listening() { return this.#server.listening }
}

export function createServer(options, requestListener) {
	return new HTTPServer(options, requestListener)
}

export function request(input, options, callback) {
	return new ClientRequest(input, options, callback)
}

export function get(input, options, callback) {
	const req = request(input, options, callback)
	req.end()
	return req
}

const STATUS_CODES = {
	100: 'Continue', 101: 'Switching Protocols',
	200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
	301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
	307: 'Temporary Redirect', 308: 'Permanent Redirect',
	400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
	404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout',
	409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large',
	415: 'Unsupported Media Type', 426: 'Upgrade Required', 429: 'Too Many Requests',
	431: 'Request Header Fields Too Large',
	500: 'Internal Server Error', 502: 'Bad Gateway',
	503: 'Service Unavailable', 504: 'Gateway Timeout',
}

export { STATUS_CODES }

export default {
	createServer,
	request,
	get,
	ClientRequest,
	Server: HTTPServer,
	IncomingMessage,
	ServerResponse,
	STATUS_CODES,
}
