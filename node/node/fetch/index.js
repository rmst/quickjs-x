/**
 * Fetch API implementation using libuv TCP streams + BearSSL TLS
 * https://fetch.spec.whatwg.org/
 */

import {
	tcpNew, tcpConnect as _tcpConnect, tcpNodelay,
	readStart, readStop, write as _streamWrite,
	close as _streamClose, setOnRead, setOnConnect,
	AF_INET, AF_INET6,
} from 'qn/uv-stream'
import { getaddrinfo as _getaddrinfo } from 'qn_uv_dns'
import * as tls from 'qn:tls'
import { getPin } from 'qn:fetch'
import { existsSync } from 'node:fs'
import { Headers } from './Headers.js'
import { Request } from './Request.js'
import { Response } from './Response.js'
import {
	concatChunks, isChunkedComplete, decodeChunked,
	parseResponseHead, buildRequest as _buildRequest,
	readResponseHead, bodyStream, writeChunkedBody,
} from 'node:http/parse'

export { Headers, Request, Response }

/**
 * Async queue with backpressure that decouples socket reads from body
 * consumption.
 *
 * A background task reads from the socket (via bodyStream) and pushes
 * chunks into a bounded buffer. When the buffer is full, reading pauses
 * until the consumer pulls. This gives us:
 *
 * - Deterministic socket cleanup: the drain task runs to completion
 *   when the server finishes sending, closing the socket in the
 *   bodyStream finally block. No GC dependency.
 * - Backpressure: buffer is capped at HIGH_WATER bytes. When full,
 *   the drain pauses (stops reading from the socket) until the
 *   consumer pulls enough data below LOW_WATER.
 * - Cancellation: abort() stops the drain and closes the socket.
 * - Streaming: data flows through chunk-by-chunk for large responses.
 */
const HIGH_WATER = 64 * 1024
const LOW_WATER = 16 * 1024
const BODY_TIMEOUT = 300_000  // 5 minutes — abort abandoned streams

class BodyQueue {
	constructor() {
		this._chunks = []
		this._size = 0
		this._pullWait = null   // consumer waiting for data
		this._drainWait = null  // producer waiting for buffer space
		this._done = false
		this._error = null
		this._aborted = false
		this._timeout = null
	}

	push(chunk) {
		if (this._aborted) return false
		if (this._pullWait) {
			// Consumer is waiting — deliver directly, no buffering
			const { resolve } = this._pullWait
			this._pullWait = null
			resolve(chunk)
			return true
		}
		this._chunks.push(chunk)
		this._size += chunk.byteLength
		return this._size < HIGH_WATER
	}

	waitForDrain() {
		// Start body timeout — if nobody pulls within BODY_TIMEOUT,
		// the response was abandoned. Abort to free the socket.
		this._timeout = setTimeout(() => this.abort(), BODY_TIMEOUT)
		return new Promise(r => { this._drainWait = r })
	}

	_clearTimeout() {
		if (this._timeout) {
			clearTimeout(this._timeout)
			this._timeout = null
		}
	}

	end(error) {
		this._done = true
		this._error = error || null
		this._clearTimeout()
		if (this._pullWait) {
			const { resolve, reject } = this._pullWait
			this._pullWait = null
			if (this._error) reject(this._error)
			else resolve(null)
		}
	}

	pull() {
		if (this._chunks.length > 0) {
			const chunk = this._chunks.shift()
			this._size -= chunk.byteLength
			// Resume drain if buffer dropped below low water
			if (this._drainWait && this._size < LOW_WATER) {
				this._clearTimeout()
				const resolve = this._drainWait
				this._drainWait = null
				resolve()
			}
			return Promise.resolve(chunk)
		}
		if (this._done) {
			if (this._error) return Promise.reject(this._error)
			return Promise.resolve(null)
		}
		return new Promise((resolve, reject) => { this._pullWait = { resolve, reject } })
	}

	abort() {
		this._aborted = true
		this._done = true
		this._clearTimeout()
		// Unblock drain so it can exit
		if (this._drainWait) {
			const resolve = this._drainWait
			this._drainWait = null
			resolve()
		}
		// Unblock consumer
		if (this._pullWait) {
			const { resolve } = this._pullWait
			this._pullWait = null
			resolve(null)
		}
	}
}

/**
 * Start a background drain that reads from bodyStream into a
 * backpressure-controlled BodyQueue. Returns an async generator
 * that the Response body reads from.
 *
 * onComplete(drained) is called when the drain finishes:
 *   drained=true  → body fully read, connection can be reused
 *   drained=false → error or abort, connection should be destroyed
 */
function pipedBody(reader, leftover, contentLength, isChunked, onComplete) {
	const queue = new BodyQueue()

	// Background drain — reads the socket, pushes to queue
	;(async () => {
		let drained = false
		try {
			const stream = bodyStream(reader, leftover, contentLength, isChunked)
			for await (const chunk of stream) {
				if (queue._aborted) break
				const below = queue.push(chunk)
				if (!below && !queue._aborted) {
					await queue.waitForDrain()
				}
			}
			drained = !queue._aborted
			queue.end()
		} catch (e) {
			queue.end(e)
		}
		if (onComplete) onComplete(drained)
	})()

	const body = async function* () {
		for (;;) {
			const chunk = await queue.pull()
			if (chunk === null) return
			yield chunk
		}
	}()

	body._pipe = queue
	return body
}

const SYSTEM_CA_PATHS = [
	'/etc/ssl/certs/ca-certificates.crt',
	'/etc/pki/tls/certs/ca-bundle.crt',
	'/etc/ssl/cert.pem',
	'/etc/ssl/ca-bundle.pem',
	'/usr/local/share/certs/ca-root-nss.crt',
	'/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
]

let _caCertsLoaded = false
function ensureCACerts() {
	if (_caCertsLoaded) return
	_caCertsLoaded = true

	const sslCertFile = globalThis.process?.env?.SSL_CERT_FILE
	if (sslCertFile) {
		tls.loadCACerts(sslCertFile)
	} else {
		for (const p of SYSTEM_CA_PATHS) {
			if (existsSync(p)) {
				tls.loadCACerts(p)
				break
			}
		}
	}

	const extraCerts = globalThis.process?.env?.NODE_EXTRA_CA_CERTS
	if (extraCerts) {
		tls.loadCACerts(extraCerts)
	}
}

const MAX_REDIRECTS = 20
const POOL_IDLE_TIMEOUT = 30_000  // close idle connections after 30s
const MAX_CONNS_PER_ORIGIN = 6    // match browser limits

function isRedirectStatus(status) {
	return [301, 302, 303, 307, 308].includes(status)
}

/**
 * Connection pool — reuses TCP connections for the same origin.
 * Each idle entry holds a connection object that can send new requests
 * without a fresh TCP handshake (or TLS handshake for HTTPS).
 */
const _pool = new Map()  // origin → [{conn, timer}]

function _pinSig(pin) {
	if (!pin) return ''
	const c = pin.certSha256
		? (Array.isArray(pin.certSha256) ? pin.certSha256 : [pin.certSha256])
		: []
	const s = pin.spkiSha256
		? (Array.isArray(pin.spkiSha256) ? pin.spkiSha256 : [pin.spkiSha256])
		: []
	const t = pin.trustOnlyPin ? 'T' : ''
	return c.slice().sort().join(',') + '|' + s.slice().sort().join(',') + '|' + t
}

function poolKey(protocol, host, port, pin) {
	const sig = _pinSig(pin)
	return sig
		? `${protocol}//${host}:${port}#${sig}`
		: `${protocol}//${host}:${port}`
}

function poolGet(key) {
	const entries = _pool.get(key)
	if (!entries) return null
	while (entries.length > 0) {
		const entry = entries.pop()
		clearTimeout(entry.timer)
		if (entries.length === 0) _pool.delete(key)
		return entry.conn
	}
	_pool.delete(key)
	return null
}

function poolPut(key, conn) {
	let entries = _pool.get(key)
	if (!entries) {
		entries = []
		_pool.set(key, entries)
	}
	if (entries.length >= MAX_CONNS_PER_ORIGIN) {
		conn.destroy()
		return
	}
	const timer = setTimeout(() => {
		const idx = entries.findIndex(e => e.conn === conn)
		if (idx !== -1) entries.splice(idx, 1)
		if (entries.length === 0) _pool.delete(key)
		conn.destroy()
	}, POOL_IDLE_TIMEOUT)
	if (timer.unref) timer.unref()  // don't keep event loop alive for idle connections
	entries.push({ conn, timer })
}

/**
 * Connect a TCP stream to host:port via libuv.
 * Returns the stream handle.
 */
async function tcpConnect(host, port, signal) {
	if (signal?.aborted) throw signal.reason

	let addrs = await _getaddrinfo(host, port, { family: AF_INET })
	if (signal?.aborted) throw signal.reason
	if (addrs.length === 0) {
		addrs = await _getaddrinfo(host, port)
		if (addrs.length === 0) throw new TypeError(`fetch failed: DNS lookup failed for ${host}`)
	}

	const family = addrs[0].family
	const handle = tcpNew(family)

	return new Promise((resolve, reject) => {
		const onAbort = () => {
			_streamClose(handle)
			reject(signal.reason)
		}
		if (signal) signal.addEventListener('abort', onAbort, { once: true })

		setOnConnect(handle, (err) => {
			if (signal) signal.removeEventListener('abort', onAbort)
			if (err) {
				_streamClose(handle)
				reject(new TypeError(`fetch failed: ${err.message || err}`))
			} else {
				tcpNodelay(handle, true)
				resolve(handle)
			}
		})

		try {
			_tcpConnect(handle, addrs[0].address, port)
		} catch (e) {
			if (signal) signal.removeEventListener('abort', onAbort)
			_streamClose(handle)
			reject(new TypeError(`fetch failed: ${e.message}`))
		}
	})
}

/**
 * Create a transport { read, write } from a libuv stream handle.
 * One-shot read pattern: start reading, resolve on first chunk, stop.
 */
function plainTransport(handle) {
	let pendingResolve = null
	let pendingReject = null
	let buffered = null
	let eof = false

	setOnRead(handle, (buf, err) => {
		if (err) {
			readStop(handle)
			if (pendingReject) {
				const rej = pendingReject
				pendingResolve = pendingReject = null
				rej(new Error('fetch: stream read error'))
			}
			return
		}
		if (buf === null) {
			eof = true
			readStop(handle)
			if (pendingResolve) {
				const res = pendingResolve
				pendingResolve = pendingReject = null
				res(null)
			}
			return
		}
		readStop(handle)
		const chunk = new Uint8Array(buf)
		if (pendingResolve) {
			const res = pendingResolve
			pendingResolve = pendingReject = null
			res(chunk)
		} else {
			buffered = chunk
		}
	})

	return {
		read({ signal } = {}) {
			if (buffered) {
				const b = buffered
				buffered = null
				return Promise.resolve(b)
			}
			if (eof) return Promise.resolve(null)
			if (signal?.aborted) return Promise.reject(signal.reason)
			return new Promise((resolve, reject) => {
				pendingResolve = resolve
				pendingReject = reject
				if (signal) {
					signal.addEventListener('abort', () => {
						readStop(handle)
						pendingResolve = pendingReject = null
						reject(signal.reason)
					}, { once: true })
				}
				readStart(handle)
			})
		},
		async write(data, { signal } = {}) {
			if (signal?.aborted) throw signal.reason
			await _streamWrite(handle, data)
		},
	}
}

function buildRequest(method, path, host, port, headers, isDefaultPort) {
	return _buildRequest(method, path, host, port, headers, isDefaultPort)
}

/**
 * Create a reusable connection object for an origin.
 * Returns { send(reqBytes, bodyBytes, bodyIter, signal) → reader, destroy() }
 */
async function createConnection(handle, host, isHttps, signal, pin) {
	const transport = isHttps ? tls.streamTransport(handle) : plainTransport(handle)
	let tlsConn = null

	if (isHttps) {
		ensureCACerts()
		tlsConn = tls.connect(host, pin ? { pin } : undefined)
		try {
			await tls.handshake(tlsConn, transport, signal)
		} catch (e) {
			try { await tls.close(tlsConn, transport) } catch {}
			try { _streamClose(handle) } catch {}
			throw e
		}
	}

	let destroyed = false
	// Leftover bytes from a previous read that belong to the next
	// HTTP message on this connection (plain HTTP only).
	let connLeftover = null

	return {
		async send(reqBytes, bodyBytes, bodyIter, signal) {
			if (tlsConn) {
				try {
					await tls.writeAll(tlsConn, transport, reqBytes, signal)
					if (bodyBytes) await tls.writeAll(tlsConn, transport, bodyBytes, signal)
					else if (bodyIter) await writeChunkedBody(data => tls.writeAll(tlsConn, transport, data, signal), bodyIter)
				} catch (e) {
					this.destroy()
					throw e
				}
				return {
					read(buf, off, len) {
						return tls.read(tlsConn, transport, buf, off, len, signal)
					},
					close() {}, // no-op — connection lifecycle managed by pool
				}
			}

			/* Plain HTTP */
			try {
				await transport.write(reqBytes, { signal })
				if (bodyBytes) await transport.write(bodyBytes, { signal })
				else if (bodyIter) await writeChunkedBody(data => transport.write(data, { signal }), bodyIter)
			} catch (e) {
				this.destroy()
				throw e
			}
			return {
				async read(buf, off, len) {
					let chunk = connLeftover
					connLeftover = null
					if (!chunk) {
						chunk = await transport.read({ signal })
						if (!chunk) return 0
					}
					const n = Math.min(chunk.byteLength, len)
					new Uint8Array(buf, off, n).set(chunk.subarray(0, n))
					if (n < chunk.byteLength) connLeftover = chunk.subarray(n)
					return n
				},
				close() {}, // no-op — connection lifecycle managed by pool
			}
		},

		destroy() {
			if (destroyed) return
			destroyed = true
			if (tlsConn) {
				try { tls.close(tlsConn, transport) } catch {}
			}
			try { _streamClose(handle) } catch {}
		},
	}
}


async function newConnection(host, port, isHttps, signal, pin) {
	let handle
	try {
		handle = await tcpConnect(host, port, signal)
	} catch (e) {
		if (signal?.aborted) throw signal.reason
		throw new TypeError(`fetch failed: ${e.message}`)
	}
	try {
		return await createConnection(handle, host, isHttps, signal, pin)
	} catch (e) {
		if (signal?.aborted) throw signal.reason
		throw e instanceof TypeError ? e : new TypeError(`fetch failed: ${e.message}`)
	}
}

/**
 * Fetch a resource from the network
 *
 * @param {string|URL|Request} input - The URL or Request to fetch
 * @param {Object} [init] - Optional configuration (overrides Request properties)
 * @returns {Promise<Response>}
 */
export async function fetch(input, init = {}) {
	let url

	if (input instanceof Request) {
		if (input.bodyUsed) throw new TypeError('Request body has already been consumed')
		try {
			url = new URL(input.url)
		} catch {
			throw new TypeError(`Invalid URL: ${input.url}`)
		}
		init = { method: input.method, headers: input.headers, body: input.body, signal: input.signal, ...init }
	} else if (input instanceof URL) {
		url = input
	} else if (typeof input === 'string') {
		try {
			url = new URL(input)
		} catch {
			throw new TypeError(`Invalid URL: ${input}`)
		}
	} else {
		throw new TypeError('Input must be a string, URL, or Request')
	}

	const signal = init.signal || null
	if (signal?.aborted) {
		throw signal.reason
	}

	const method = (init.method || 'GET').toUpperCase()
	if (!/^[!#$%&'*+\-.^_`|~\w]+$/.test(method))
		throw new TypeError(`Invalid HTTP method: ${JSON.stringify(init.method)}`)
	const headers = init.headers instanceof Headers
		? new Headers(init.headers)
		: new Headers(init.headers || {})

	let bodyBytes = null
	let bodyIter = null
	if (init.body !== undefined && init.body !== null) {
		if (typeof init.body === 'string') {
			bodyBytes = new TextEncoder().encode(init.body)
			if (!headers.has('content-type')) {
				headers.set('content-type', 'text/plain;charset=UTF-8')
			}
			headers.set('content-length', String(bodyBytes.byteLength))
		} else if (init.body instanceof Uint8Array) {
			bodyBytes = init.body
			headers.set('content-length', String(bodyBytes.byteLength))
		} else if (init.body instanceof ArrayBuffer) {
			bodyBytes = new Uint8Array(init.body)
			headers.set('content-length', String(bodyBytes.byteLength))
		} else if (init.body instanceof URLSearchParams) {
			bodyBytes = new TextEncoder().encode(init.body.toString())
			if (!headers.has('content-type')) {
				headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8')
			}
			headers.set('content-length', String(bodyBytes.byteLength))
		} else if (typeof init.body?.[Symbol.asyncIterator] === 'function'
			|| typeof init.body?.[Symbol.iterator] === 'function') {
			bodyIter = init.body
			if (!headers.has('transfer-encoding'))
				headers.set('transfer-encoding', 'chunked')
		} else {
			throw new TypeError('Unsupported body type')
		}
	}

	let redirectCount = 0
	let redirected = false
	const redirectMode = init.redirect || 'follow'

	while (true) {
		if (signal?.aborted) throw signal.reason

		const isHttps = url.protocol === 'https:'
		const defaultPort = isHttps ? 443 : 80
		const host = url.hostname
		const port = url.port ? parseInt(url.port, 10) : defaultPort
		const path = (url.pathname || '/') + (url.search || '')
		const isDefaultPort = port === defaultPort
		const pin = isHttps ? getPin(host) : null
		const key = poolKey(url.protocol, host, port, pin)

		const reqStr = buildRequest(method, path, host, port, headers, isDefaultPort)
		const reqBytes = new TextEncoder().encode(reqStr)

		// Try to reuse a pooled connection, fall back to new one.
		// If a pooled connection is stale, retry with a fresh one.
		let conn = poolGet(key)
		let fromPool = !!conn
		if (!conn) {
			conn = await newConnection(host, port, isHttps, signal, pin)
		}

		let reader
		try {
			reader = await conn.send(reqBytes, bodyBytes, bodyIter, signal)
		} catch (e) {
			if (fromPool && !signal?.aborted) {
				// Pooled connection was stale — retry with fresh connection
				conn = await newConnection(host, port, isHttps, signal, pin)
				reader = await conn.send(reqBytes, bodyBytes, bodyIter, signal)
			} else {
				conn.destroy()
				if (signal?.aborted) throw signal.reason
				throw e instanceof TypeError ? e : new TypeError(`fetch failed: ${e.message}`)
			}
		}

		try {
			let head = await readResponseHead(reader, 64 * 1024)
			if (!head && fromPool) {
				// Pooled connection died — retry with a fresh one
				conn.destroy()
				conn = await newConnection(host, port, isHttps, signal, pin)
				fromPool = false
				reader = await conn.send(reqBytes, bodyBytes, bodyIter, signal)
				head = await readResponseHead(reader, 64 * 1024)
			}
			if (!head) {
				conn.destroy()
				throw new TypeError('fetch failed: invalid HTTP response')
			}

			// Determine if connection can be reused:
			// - Server must not send Connection: close
			// - Response must be framed (content-length or chunked),
			//   not read-until-close, which consumes the TCP stream
			const connHeader = (head.headers.get('connection') || '').toLowerCase()
			const te = head.headers.get('transfer-encoding')
			const cl = head.headers.get('content-length')
			// RFC 7230 §3.3.3: responses to HEAD requests, plus 204 and 304
			// status codes, never have a body — regardless of Content-Length
			// or Transfer-Encoding headers the server may have sent. Without
			// this, we'd fall into "read until close" and stall waiting for
			// the server's keep-alive timeout to fire.
			const noBody = method === 'HEAD' || head.status === 204 || head.status === 304
			const isChunked = !noBody && !!(te && te.toLowerCase().includes('chunked'))
			const contentLength = noBody ? 0 : (cl !== null ? parseInt(cl, 10) : null)
			const isFramed = isChunked || contentLength !== null
			const keepAlive = connHeader !== 'close' && isFramed

			if (isRedirectStatus(head.status)) {
				reader = null
				// Check for redirect errors before pooling
				if (redirectMode === 'error') {
					conn.destroy()
					throw new TypeError('fetch failed: redirect encountered')
				}
				if (redirectMode === 'manual') {
					conn.destroy()
					return new Response(null, {
						status: head.status,
						statusText: head.statusText,
						headers: head.headers,
						url: url.href,
						redirected,
					})
				}
				redirectCount++
				if (redirectCount > MAX_REDIRECTS) {
					conn.destroy()
					throw new TypeError('fetch failed: too many redirects')
				}
				const location = head.headers.get('location')
				if (!location) {
					conn.destroy()
					throw new TypeError('fetch failed: redirect without Location header')
				}

				// Drain redirect body and pool (or destroy) the connection
				if (keepAlive) {
					const stream = bodyStream(reader, head.leftover, contentLength, isChunked)
					for await (const _ of stream) {}
					poolPut(key, conn)
				} else {
					conn.destroy()
				}

				const prevOrigin = url.origin
				url = new URL(location, url)
				if (url.origin !== prevOrigin) {
					headers.delete('authorization')
					headers.delete('cookie')
					headers.delete('proxy-authorization')
				}
				redirected = true
				continue
			}

			if (isChunked) head.headers.delete('transfer-encoding')

			const onComplete = (drained) => {
				if (drained && keepAlive) poolPut(key, conn)
				else conn.destroy()
			}

			const body = pipedBody(reader, head.leftover, contentLength, isChunked, onComplete)
			reader = null  // pipedBody owns the reader now

			return new Response(body, {
				status: head.status,
				statusText: head.statusText,
				headers: head.headers,
				url: url.href,
				redirected,
			})
		} catch (e) {
			conn.destroy()
			if (signal?.aborted) throw signal.reason
			throw e instanceof TypeError ? e : new TypeError(`fetch failed: ${e.message}`)
		}
	}
}

export default { fetch, Headers, Request, Response }
