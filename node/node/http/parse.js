/**
 * Shared HTTP/1.1 parsing utilities.
 *
 * Used by node:fetch and node:http for transport-independent
 * HTTP request/response parsing and serialization.
 */

import { Headers } from 'node:fetch/Headers'
import { Request } from 'node:fetch/Request'

let decoder, encoder
const decode = (data) => (decoder ??= new TextDecoder()).decode(data)
const encode = (str) => (encoder ??= new TextEncoder()).encode(str)

/**
 * Wrap a node:net Socket into the async reader interface used by HTTP parsing.
 * Buffers incoming chunks and serves them to callers of read().
 */
export function socketReader(socket) {
	const pending = []
	let waiter = null
	let ended = false
	let closed = false

	const maybeResume = () => {
		if (!closed && !ended && pending.length === 0 && socket.isPaused) {
			socket.resume()
		}
	}

	const onData = (chunk) => {
		if (waiter) {
			const resolve = waiter
			waiter = null
			resolve(chunk)
		} else {
			pending.push(chunk)
			socket.pause()
		}
	}
	const onEnd = () => {
		ended = true
		if (waiter) { const r = waiter; waiter = null; r(null) }
	}
	const onError = () => {
		ended = true
		if (waiter) { const r = waiter; waiter = null; r(null) }
	}

	socket.on('data', onData)
	socket.on('end', onEnd)
	socket.on('error', onError)

	return {
		async read(buf, off, len) {
			let chunk
			if (pending.length > 0) {
				chunk = pending.shift()
			} else if (ended) {
				return 0
			} else {
				chunk = await new Promise(r => { waiter = r })
				if (!chunk) return 0
			}
			const n = Math.min(chunk.length, len)
			new Uint8Array(buf, off, n).set(chunk.subarray(0, n))
			if (chunk.length > n) pending.unshift(chunk.subarray(n))
			else maybeResume()
			return n
		},
		close() {
			closed = true
			socket.off('data', onData)
			socket.off('end', onEnd)
			socket.off('error', onError)
			socket.destroy()
		},
		detach() {
			closed = true
			socket.off('data', onData)
			socket.off('end', onEnd)
			socket.off('error', onError)
			if (socket.isPaused) socket.resume()
		},
	}
}

export function concatChunks(chunks) {
	if (chunks.length === 0) return new Uint8Array(0)
	if (chunks.length === 1) return chunks[0]
	const total = chunks.reduce((sum, c) => sum + c.length, 0)
	const result = new Uint8Array(total)
	let off = 0
	for (const chunk of chunks) {
		result.set(chunk, off)
		off += chunk.length
	}
	return result
}

/**
 * Check if chunked data is complete by walking chunk boundaries.
 */
export function isChunkedComplete(data) {
	let pos = 0
	while (pos < data.length) {
		let lineEnd = -1
		for (let i = pos; i < data.length - 1; i++) {
			if (data[i] === 0x0d && data[i + 1] === 0x0a) {
				lineEnd = i
				break
			}
		}
		if (lineEnd === -1) return false

		const sizeLine = decode(data.subarray(pos, lineEnd))
		const chunkSize = parseInt(sizeLine.split(';')[0].trim(), 16)
		if (isNaN(chunkSize)) return false
		if (chunkSize === 0) return true

		const nextPos = lineEnd + 2 + chunkSize + 2
		if (nextPos > data.length) return false
		pos = nextPos
	}
	return false
}

/**
 * Decode a chunked transfer-encoded body.
 */
export function decodeChunked(data) {
	const chunks = []
	let pos = 0
	while (pos < data.length) {
		let lineEnd = -1
		for (let i = pos; i < data.length - 1; i++) {
			if (data[i] === 0x0d && data[i + 1] === 0x0a) {
				lineEnd = i
				break
			}
		}
		if (lineEnd === -1) break

		const sizeLine = decode(data.subarray(pos, lineEnd))
		const chunkSize = parseInt(sizeLine.split(';')[0].trim(), 16)
		if (isNaN(chunkSize)) break
		if (chunkSize === 0) break

		const dataStart = lineEnd + 2
		const dataEnd = dataStart + chunkSize
		if (dataEnd > data.length) break

		chunks.push(data.subarray(dataStart, dataEnd))
		pos = dataEnd + 2
	}
	return concatChunks(chunks)
}

/**
 * Parse HTTP response headers from raw data.
 * Returns { status, statusText, headers, bodyStart } or null if incomplete.
 */
export function parseResponseHead(data) {
	let headerEnd = -1
	for (let i = 0; i < data.length - 3; i++) {
		if (data[i] === 0x0d && data[i + 1] === 0x0a &&
			data[i + 2] === 0x0d && data[i + 3] === 0x0a) {
			headerEnd = i
			break
		}
	}
	if (headerEnd === -1) return null

	const headerText = decode(data.subarray(0, headerEnd))
	const lines = headerText.split('\r\n')

	const statusLine = lines[0] || ''
	const statusMatch = statusLine.match(/^HTTP\/([\d.]+) (\d+)(?: (.*))?$/)
	const httpVersion = statusMatch ? statusMatch[1] : ''
	const status = statusMatch ? parseInt(statusMatch[2], 10) : 0
	const statusText = statusMatch ? (statusMatch[3] || '') : ''

	const headers = new Headers()
	const rawHeaders = []
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]
		const colonIdx = line.indexOf(':')
		if (colonIdx > 0) {
			const key = line.slice(0, colonIdx).trim()
			const value = line.slice(colonIdx + 1).trim()
			rawHeaders.push(key, value)
			headers.append(key, value)
		}
	}

	return { httpVersion, status, statusText, headers, rawHeaders, bodyStart: headerEnd + 4 }
}

/**
 * Parse an HTTP request from raw data.
 * Returns { method, url, httpVersion, headers, rawHeaders, headerEnd }
 * or null if headers aren't complete yet.
 */
export function parseRequestHead(data) {
	let headerEnd = -1
	for (let i = 0; i < data.length - 3; i++) {
		if (data[i] === 0x0d && data[i + 1] === 0x0a &&
			data[i + 2] === 0x0d && data[i + 3] === 0x0a) {
			headerEnd = i + 4
			break
		}
	}
	if (headerEnd === -1) return null

	const headerText = decode(data.subarray(0, headerEnd))
	const lines = headerText.split('\r\n')

	const requestLine = lines[0]
	const parts = requestLine.split(' ')
	if (parts.length < 3) return null

	const method = parts[0]
	const url = parts[1]
	const httpVersion = parts[2].replace('HTTP/', '')

	const headers = {}
	const rawHeaders = []
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]
		if (!line) break
		const colonIdx = line.indexOf(':')
		if (colonIdx <= 0) continue
		const key = line.slice(0, colonIdx)
		const value = line.slice(colonIdx + 1).trim()
		rawHeaders.push(key, value)
		const lowerKey = key.toLowerCase()
		if (headers[lowerKey] !== undefined) {
			headers[lowerKey] += ', ' + value
		} else {
			headers[lowerKey] = value
		}
	}

	return { method, url, httpVersion, headers, rawHeaders, headerEnd }
}

/**
 * Build an HTTP/1.1 request string.
 *
 * Host and Connection are set by the transport — Host from the destination
 * URL, Connection because qn fetch always uses single-shot connections (no
 * keep-alive across requests). User-supplied headers with those names are
 * dropped so we never emit duplicates. RFC 7230 allows duplicates only for
 * comma-list headers, which Connection is, but some receivers' parsers
 * concatenate the values ("close, close") and then fail equality checks
 * like `conn === 'close'`, which silently flips them to keep-alive mode.
 */
export function buildRequest(method, path, host, port, headers, isDefaultPort) {
	if (/[\r\n]/.test(method))
		throw new TypeError(`Invalid HTTP method: ${JSON.stringify(method)}`)
	if (/[\r\n]/.test(path))
		throw new TypeError('Invalid request path: contains CR or LF')
	if (/[\r\n]/.test(host))
		throw new TypeError('Invalid host: contains CR or LF')
	const hostHeader = isDefaultPort ? host : `${host}:${port}`
	let req = `${method} ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n`
	for (const [key, value] of headers) {
		const lower = key.toLowerCase()
		if (lower === 'host' || lower === 'connection') continue
		if (/[\r\n]/.test(key) || /[\r\n]/.test(value))
			throw new TypeError(`Invalid header: ${key}`)
		req += `${key}: ${value}\r\n`
	}
	req += '\r\n'
	return req
}

const DEFAULT_MAX_HEADER_SIZE = 64 * 1024

/**
 * Shared read loop for HTTP head parsing. Accumulates data from the reader,
 * calls parseFn on each iteration until headers are complete or maxSize is
 * exceeded. Returns { parsed, accumulated } or null on connection close.
 */
async function readHead(reader, parseFn, maxSize) {
	const buf = new ArrayBuffer(65536)
	let accumulated = new Uint8Array(0)

	while (true) {
		const parsed = parseFn(accumulated)
		if (parsed) return { parsed, accumulated }

		if (accumulated.length > maxSize) {
			const err = new Error('Header fields too large')
			err.code = 'ERR_HTTP_HEADER_TOO_LARGE'
			throw err
		}

		const n = await reader.read(buf, 0, 65536)
		if (n <= 0) break
		const prev = accumulated
		accumulated = new Uint8Array(prev.length + n)
		accumulated.set(prev, 0)
		accumulated.set(new Uint8Array(buf, 0, n), prev.length)
	}

	return null
}

/**
 * Read HTTP response headers from a reader ({ read(buf, off, len) }).
 * Returns { status, statusText, headers, leftover } or null on error.
 */
export async function readResponseHead(reader, maxSize = DEFAULT_MAX_HEADER_SIZE) {
	const result = await readHead(reader, parseResponseHead, maxSize)
	if (!result) return null
	const { parsed, accumulated } = result
	return {
		status: parsed.status,
		statusText: parsed.statusText,
		httpVersion: parsed.httpVersion,
		headers: parsed.headers,
		rawHeaders: parsed.rawHeaders,
		leftover: accumulated.subarray(parsed.bodyStart),
	}
}

/**
 * Read HTTP request headers from a reader ({ read(buf, off, len) }).
 * Returns { method, url, httpVersion, headers, rawHeaders, leftover } or null.
 */
export async function readRequestHead(reader, maxSize = DEFAULT_MAX_HEADER_SIZE) {
	const result = await readHead(reader, parseRequestHead, maxSize)
	if (!result) return null
	const { parsed, accumulated } = result
	return {
		method: parsed.method,
		url: parsed.url,
		httpVersion: parsed.httpVersion,
		headers: parsed.headers,
		rawHeaders: parsed.rawHeaders,
		leftover: accumulated.subarray(parsed.headerEnd),
	}
}

/**
 * Create an async iterable that streams a content-length framed request body.
 * Does NOT close the reader — suitable for server-side body reading where
 * the connection must remain open for the response.
 */
export function requestBodyStream(reader, leftover, contentLength) {
	let remaining = contentLength
	let first = true
	return {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					if (first && leftover.length > 0) {
						first = false
						const take = leftover.subarray(0, Math.min(leftover.length, remaining))
						remaining -= take.length
						if (take.length > 0)
							return { value: take, done: false }
					}
					first = false
					if (remaining <= 0) return { done: true }
					const readBuf = new ArrayBuffer(65536)
					const n = await reader.read(readBuf, 0, Math.min(remaining, 65536))
					if (n <= 0) return { done: true }
					remaining -= n
					return { value: new Uint8Array(readBuf, 0, n), done: false }
				},
			}
		},
	}
}

/**
 * Incrementally decode chunked transfer-encoded data from a reader,
 * yielding each decoded chunk as it becomes available.
 */
async function* readChunkedBody(reader, buffer) {
	const readBuf = new ArrayBuffer(65536)
	while (true) {
		let lineEnd = -1
		for (let i = 0; i < buffer.length - 1; i++) {
			if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) {
				lineEnd = i
				break
			}
		}
		if (lineEnd === -1) {
			const n = await reader.read(readBuf, 0, 65536)
			if (n <= 0) return
			const prev = buffer
			buffer = new Uint8Array(prev.length + n)
			buffer.set(prev, 0)
			buffer.set(new Uint8Array(readBuf, 0, n), prev.length)
			continue
		}
		const sizeLine = decode(buffer.subarray(0, lineEnd))
		const chunkSize = parseInt(sizeLine.split(';')[0].trim(), 16)
		if (isNaN(chunkSize) || chunkSize < 0) return
		if (chunkSize === 0) return
		const dataStart = lineEnd + 2
		const needed = dataStart + chunkSize + 2
		while (buffer.length < needed) {
			const n = await reader.read(readBuf, 0, 65536)
			if (n <= 0) return
			const prev = buffer
			buffer = new Uint8Array(prev.length + n)
			buffer.set(prev, 0)
			buffer.set(new Uint8Array(readBuf, 0, n), prev.length)
		}
		yield buffer.subarray(dataStart, dataStart + chunkSize)
		buffer = buffer.slice(needed)
	}
}

/**
 * Create an async iterable that reads a chunked request body.
 * Does NOT close the reader — suitable for server-side body reading.
 */
export function chunkedRequestBodyStream(reader, leftover) {
	return {
		[Symbol.asyncIterator]() {
			return readChunkedBody(reader, leftover)[Symbol.asyncIterator]()
		},
	}
}

export function responseBodyFraming(head, method = 'GET') {
	const connHeader = (head.headers.get('connection') || '').toLowerCase()
	const connTokens = connHeader.split(/\s*,\s*/)
	const transferEncoding = head.headers.get('transfer-encoding')
	const contentLengthHeader = head.headers.get('content-length')
	const noBody = method === 'HEAD' || head.status === 204 || head.status === 304
	const isChunked = !noBody && !!(transferEncoding && transferEncoding.toLowerCase().includes('chunked'))
	const parsedContentLength = contentLengthHeader !== null ? parseInt(contentLengthHeader, 10) : null
	const contentLength = noBody ? 0
		: Number.isFinite(parsedContentLength) ? parsedContentLength
			: null
	const isFramed = isChunked || contentLength !== null
	const keepAlive = !connTokens.includes('close') && isFramed

	return { contentLength, isChunked, isFramed, keepAlive, noBody }
}

/**
 * Write an async iterable body using chunked transfer-encoding.
 * @param {(data: Uint8Array) => Promise<void>} writeFn - Write function
 * @param {AsyncIterable<Uint8Array|string>} iterable - Body chunks
 */
export async function writeChunkedBody(writeFn, iterable) {
	for await (const chunk of iterable) {
		const data = typeof chunk === 'string' ? encode(chunk) : chunk
		await writeFn(encode(data.byteLength.toString(16) + '\r\n'))
		await writeFn(data)
		await writeFn(encode('\r\n'))
	}
	await writeFn(encode('0\r\n\r\n'))
}

/**
 * Async generator that streams body data from a reader.
 * Handles Content-Length, chunked transfer-encoding, and connection-close framing.
 * Owns the reader — closes it when done or on error.
 */
export async function* bodyStream(reader, leftover, contentLength, isChunked) {
	try {
		if (isChunked) {
			yield* readChunkedBody(reader, leftover)
		} else if (contentLength !== null) {
			let remaining = contentLength
			if (leftover.length > 0) {
				const toYield = leftover.subarray(0, Math.min(leftover.length, remaining))
				remaining -= toYield.length
				if (toYield.length > 0) yield toYield
			}
			const readBuf = new ArrayBuffer(65536)
			while (remaining > 0) {
				const n = await reader.read(readBuf, 0, Math.min(remaining, 65536))
				if (n <= 0) break
				remaining -= n
				yield new Uint8Array(readBuf.slice(0, n))
			}
		} else {
			if (leftover.length > 0) yield leftover
			const readBuf = new ArrayBuffer(65536)
			for (;;) {
				const n = await reader.read(readBuf, 0, 65536)
				if (n <= 0) break
				yield new Uint8Array(readBuf.slice(0, n))
			}
		}
	} finally {
		await reader.close()
	}
}

/**
 * Determine keep-alive from Connection header and HTTP version.
 *
 * The Connection header is a comma-separated list of connection-option tokens
 * (RFC 7230 §6.1). "close" anywhere in the list forces close; "keep-alive"
 * anywhere forces keep-alive; otherwise fall back to HTTP/1.1 default
 * (keep-alive) vs HTTP/1.0 default (close).
 */
function detectKeepAlive(headers, httpVersion) {
	const conn = (headers['connection'] || '').toLowerCase()
	const tokens = conn.split(/\s*,\s*/)
	if (tokens.includes('close')) return false
	if (tokens.includes('keep-alive')) return true
	return httpVersion === '1.1'
}

/**
 * Detect upgrade request from Connection header.
 */
function detectUpgrade(headers) {
	const conn = (headers['connection'] || '').toLowerCase()
	return conn.split(/\s*,\s*/).includes('upgrade') && !!headers['upgrade']
}

/**
 * Validate request body framing. Returns { contentLength, isChunked } or
 * throws with an error object containing a `statusCode` property for the
 * appropriate HTTP error response.
 */
function validateBodyFraming(headers) {
	const hasContentLength = 'content-length' in headers
	const hasTransferEncoding = 'transfer-encoding' in headers
	const isChunked = hasTransferEncoding &&
		headers['transfer-encoding'].toLowerCase().includes('chunked')

	if (hasContentLength && hasTransferEncoding) {
		const err = new Error('Bad Request')
		err.statusCode = 400
		throw err
	}

	let contentLength = 0
	if (hasContentLength) {
		const clValue = headers['content-length'].trim()
		if (!/^\d+$/.test(clValue)) {
			const err = new Error('Bad Request')
			err.statusCode = 400
			throw err
		}
		contentLength = parseInt(clValue, 10)
	}

	return { contentLength, isChunked, hasBody: isChunked || contentLength > 0 }
}

/**
 * Create a body iterator for the request based on framing.
 */
function createBodyIter(reader, leftover, contentLength, isChunked) {
	if (isChunked) return chunkedRequestBodyStream(reader, leftover)
	if (contentLength > 0) return requestBodyStream(reader, leftover, contentLength)
	return null
}

/**
 * Drain an async iterable body (consume and discard all chunks).
 */
async function drainBody(bodyIter) {
	if (!bodyIter) return
	try {
		for await (const _ of bodyIter) {}
	} catch (err) {
		throw new Error(`failed to drain request body: ${err.message}`, { cause: err })
	}
}

/**
 * Shared HTTP/1.1 server connection handler.
 * Manages the request loop with keep-alive, timeouts, security validation,
 * and upgrade detection. Calls onRequest for each request.
 *
 * @param {object} socket - node:net Socket
 * @param {object} options
 * @param {number} options.headerTimeout - Timeout for first request headers (ms)
 * @param {number} options.keepAliveTimeout - Timeout for subsequent requests (ms)
 * @param {number} [options.maxHeaderSize] - Max header size in bytes
 * @param {number} [options.maxHeaderCount] - Max number of headers
 * @param {function} onRequest - Called per request with:
 *   { head, reader, socket, keepAlive, bodyIter, bodyFraming }
 *   Must return a Promise that resolves when the response is fully written.
 *   The returned object may have { bodyDrained: true } to skip automatic draining.
 * @param {function} [onUpgrade] - Called for upgrade requests with:
 *   { head, socket, headBuf }
 *   If null, upgrade requests destroy the socket.
 * @param {function} [onError] - Called with (statusCode, statusText) to write error responses.
 *   If null, errors destroy the socket silently.
 */
export async function handleHttpConnection(socket, options, onRequest, onUpgrade, onError) {
	const reader = socketReader(socket)
	const abort = new AbortController()
	socket.on('close', () => abort.abort())

	const {
		headerTimeout,
		keepAliveTimeout,
		maxHeaderSize = DEFAULT_MAX_HEADER_SIZE,
		maxHeaderCount = Infinity,
	} = options

	let firstRequest = true

	while (!socket.destroyed) {
		const timeout = firstRequest ? headerTimeout : keepAliveTimeout
		const timer = setTimeout(() => socket.destroy(), timeout)

		let head
		try {
			head = await readRequestHead(reader, maxHeaderSize)
		} catch (err) {
			clearTimeout(timer)
			if (err.code === 'ERR_HTTP_HEADER_TOO_LARGE' && onError) {
				onError(431, 'Request Header Fields Too Large')
			}
			socket.destroy()
			return
		}
		clearTimeout(timer)

		if (!head) { socket.destroy(); return }
		firstRequest = false

		// Header count check
		if (head.rawHeaders.length > maxHeaderCount * 2) {
			if (onError) onError(431, 'Too Many Headers')
			socket.destroy()
			return
		}

		// Upgrade detection
		if (detectUpgrade(head.headers)) {
			if (onUpgrade) {
				const headBuf = head.leftover && head.leftover.length > 0
					? head.leftover : new Uint8Array(0)
				reader.detach()
				onUpgrade({ head, socket, headBuf })
			} else {
				socket.destroy()
			}
			return
		}

		const keepAlive = detectKeepAlive(head.headers, head.httpVersion)

		// Body framing validation (CL+TE conflict, invalid CL)
		let bodyFraming
		try {
			bodyFraming = validateBodyFraming(head.headers)
		} catch (err) {
			if (onError) onError(err.statusCode, err.message)
			socket.destroy()
			return
		}

		const bodyIter = bodyFraming.hasBody
			? createBodyIter(reader, head.leftover, bodyFraming.contentLength, bodyFraming.isChunked)
			: null

		let result
		try {
			result = await onRequest({
				head, reader, socket, keepAlive, bodyIter, bodyFraming,
				signal: abort.signal,
			})
		} catch (err) {
			if (err?.name === 'AbortError' || err?.message === 'socket closed') return
			if (onError) onError(500, err.message)
			else console.error('[http] request handler failed:', err)
			socket.end()
			return
		}

		// Drain unconsumed body unless the callback already did it
		if (bodyIter && !result?.bodyDrained) {
			try {
				await drainBody(bodyIter)
			} catch (err) {
				if (onError) onError(400, err.message)
				else console.error('[http] request body drain failed:', err)
				socket.destroy()
				return
			}
		}

		if (!keepAlive) {
			socket.end()
			return
		}
	}
}

/**
 * Read an HTTP request from a reader and return a Web standard Request object.
 * Returns null if the connection closed before headers were complete.
 * Used by fetch (client-side) — does not do server-side security validation.
 *
 * @param {{ read(buf, off, len): Promise<number> }} reader
 * @param {object} [extraInit] - Extra properties for Request constructor
 * @returns {Promise<Request|null>}
 */
export async function readRequest(reader, extraInit) {
	const head = await readRequestHead(reader)
	if (!head) return null

	const host = head.headers['host'] || 'localhost'
	const url = `http://${host}${head.url}`
	const contentLength = parseInt(head.headers['content-length'], 10) || 0
	const te = head.headers['transfer-encoding']
	const isChunked = te && te.toLowerCase().includes('chunked')

	let body = null
	if (head.method !== 'GET' && head.method !== 'HEAD') {
		if (isChunked) {
			body = chunkedRequestBodyStream(reader, head.leftover)
		} else if (contentLength > 0) {
			body = requestBodyStream(reader, head.leftover, contentLength)
		}
	}

	return new Request(url, {
		method: head.method,
		headers: head.headers,
		body,
		...extraInit,
	})
}

/**
 * Write a Web standard Response to a write function.
 *
 * @param {(data: Uint8Array) => Promise<void>} writeFn
 * @param {Response} response
 * @param {object} [options]
 * @param {boolean} [options.keepAlive] - Send keep-alive instead of close
 */
export async function writeResponse(writeFn, response, options) {
	const status = response.status || 200
	const statusText = response.statusText || 'OK'
	const hasContentLength = response.headers.has('content-length')
	const useChunked = response.body && !hasContentLength
	const keepAlive = options?.keepAlive ?? false

	if (/[\r\n]/.test(statusText))
		throw new TypeError('Invalid status text: contains CR or LF')
	let head = `HTTP/1.1 ${status} ${statusText}\r\n`
	for (const [k, v] of response.headers) {
		if (/[\r\n]/.test(k) || /[\r\n]/.test(v))
			throw new TypeError(`Invalid header: ${k}`)
		head += `${k}: ${v}\r\n`
	}
	if (useChunked)
		head += 'transfer-encoding: chunked\r\n'
	head += keepAlive ? 'connection: keep-alive\r\n\r\n' : 'connection: close\r\n\r\n'
	await writeFn(encode(head))

	if (response.body) {
		if (useChunked) {
			await writeChunkedBody(writeFn, response.body)
		} else {
			for await (const chunk of response.body) {
				const data = typeof chunk === 'string' ? encode(chunk) : chunk
				await writeFn(data)
			}
		}
	}
}
