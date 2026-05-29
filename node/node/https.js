/**
 * node:https - HTTP/1.1 over BearSSL TLS
 * @see https://nodejs.org/api/https.html
 *
 * This module intentionally reuses node:http's request/server machinery and
 * swaps only the underlying socket transport. Unsupported TLS options throw
 * instead of being silently ignored.
 */

import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import {
	ClientRequest, HTTPServer, IncomingMessage, ServerResponse,
	STATUS_CODES,
} from 'node:http'
import * as tls from 'qn:tls'
import {
	tcpNew, tcpBind, listen as _listen, tcpConnect as _tcpConnect,
	close as _streamClose, setOnConnection, setOnConnect,
	tcpGetsockname, tcpGetpeername, tcpNodelay,
	AF_INET, AF_INET6,
} from 'qn/uv-stream'
import { getaddrinfo as _getaddrinfo } from 'qn_uv_dns'

const DEFAULT_PORT = 443
const READ_SIZE = 64 * 1024
const HIGH_WATER_MARK = 64 * 1024

function unsupported(name) {
	throw new TypeError(`node:https option ${name} is not supported`)
}

function hasOwnDefined(obj, name) {
	return obj && Object.prototype.hasOwnProperty.call(obj, name) && obj[name] !== undefined
}

function assertUnsupportedAbsent(options, names) {
	for (const name of names) {
		if (hasOwnDefined(options, name) && options[name] !== false && options[name] !== null) {
			unsupported(name)
		}
	}
}

function toPem(value, name) {
	if (Array.isArray(value)) return value.map(v => toPem(v, name)).join('\n')
	if (typeof value === 'string') return value
	if (value instanceof Uint8Array) return new TextDecoder().decode(value)
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value))
	throw new TypeError(`node:https option ${name} must be a PEM string, Buffer, or Uint8Array`)
}

function loadCredentials(options = {}) {
	assertUnsupportedAbsent(options, ['pfx', 'passphrase', 'secureContext', 'SNICallback', 'ALPNProtocols'])
	if (options.requestCert || options.rejectUnauthorized === true || hasOwnDefined(options, 'ca')) {
		unsupported('client certificate authentication')
	}

	if (options.certFile || options.keyFile) {
		if (!options.certFile || !options.keyFile)
			throw new TypeError('node:https requires both certFile and keyFile')
		return tls.loadServerCert(String(options.certFile), String(options.keyFile))
	}

	if (!hasOwnDefined(options, 'cert') || !hasOwnDefined(options, 'key'))
		throw new TypeError('node:https.createServer requires key and cert options')
	return tls.loadServerCertPem(toPem(options.cert, 'cert'), toPem(options.key, 'key'))
}

function formatAddr(raw) {
	if (!raw) return null
	return {
		address: raw.ip,
		port: raw.port,
		family: raw.family === 6 ? 'IPv6' : 'IPv4',
	}
}

function isIPAddress(host) {
	return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
}

function defaultServername(host, rejectUnauthorized) {
	return !rejectUnauthorized && isIPAddress(host) ? '' : host
}

async function tcpConnect(host, port) {
	let addrs = await _getaddrinfo(host, port, { family: AF_INET })
	if (addrs.length === 0) addrs = await _getaddrinfo(host, port)
	if (addrs.length === 0) throw new Error(`DNS lookup failed for ${host}`)

	const addr = addrs[0]
	const handle = tcpNew(addr.family)
	return new Promise((resolve, reject) => {
		setOnConnect(handle, (err) => {
			if (err) {
				try { _streamClose(handle) } catch {}
				reject(err)
				return
			}
			try { tcpNodelay(handle, true) } catch {}
			resolve(handle)
		})
		try {
			_tcpConnect(handle, addr.address, port)
		} catch (err) {
			try { _streamClose(handle) } catch {}
			reject(err)
		}
	})
}

class TLSSocket extends EventEmitter {
	#handle = null
	#conn = null
	#transport = null
	#connected = false
	#destroyed = false
	#paused = false
	#reading = false
	#readEnded = false
	#writeEnded = false
	#closed = false
	#writeChain = Promise.resolve()
	#queuedBytes = 0
	#needDrain = false

	constructor(handle, conn, transport) {
		super()
		this.#handle = handle
		this.#conn = conn
		this.#transport = transport
	}

	static connect(options, callback) {
		const socket = new TLSSocket(null, null, null)
		if (callback) socket.once('connect', callback)
		socket.#connect(options)
		return socket
	}

	static accept(handle, cred) {
		const transport = tls.streamTransport(handle)
		const conn = tls.accept(cred)
		return new TLSSocket(handle, conn, transport)
	}

	async #connect(options) {
		try {
			validateClientOptions(options)
			const host = options.hostname || options.host || 'localhost'
			const port = options.port ? Number(options.port) : DEFAULT_PORT
			const rejectUnauthorized = options.rejectUnauthorized !== false
			const servername = hasOwnDefined(options, 'servername')
				? String(options.servername)
				: defaultServername(host, rejectUnauthorized)
			if (rejectUnauthorized) tls.ensureCACerts()

			this.#handle = await tcpConnect(host, port)
			this.#transport = tls.streamTransport(this.#handle)
			this.#conn = tls.connect(servername, { rejectUnauthorized })
			await tls.handshake(this.#conn, this.#transport)
			if (this.#destroyed) return
			this.#connected = true
			this.emit('secureConnect')
			this.emit('connect')
		} catch (err) {
			this.#emitError(err)
		}
	}

	async _acceptHandshake() {
		try {
			await tls.handshake(this.#conn, this.#transport)
			if (this.#destroyed) return false
			this.#connected = true
			this.emit('secureConnect')
			return true
		} catch {
			this.destroy()
			return false
		}
	}

	get destroyed() { return this.#destroyed }
	get readable() { return this.#connected && !this.#readEnded && !this.#destroyed }
	get writable() { return this.#connected && !this.#writeEnded && !this.#destroyed }
	get isPaused() { return this.#paused }
	get _handle() { return this.#handle }

	address() {
		if (!this.#handle) return null
		try { return formatAddr(tcpGetsockname(this.#handle)) } catch { return null }
	}

	get remoteAddress() {
		try { return formatAddr(tcpGetpeername(this.#handle))?.address } catch { return undefined }
	}

	get remotePort() {
		try { return formatAddr(tcpGetpeername(this.#handle))?.port } catch { return undefined }
	}

	pause() {
		this.#paused = true
		return this
	}

	resume() {
		if (this.#destroyed || this.#readEnded) return this
		this.#paused = false
		this.#pumpRead()
		return this
	}

	async #pumpRead() {
		if (this.#reading || this.#paused || this.#destroyed || !this.#connected) return
		this.#reading = true
		try {
			while (!this.#paused && !this.#destroyed) {
				const buf = new ArrayBuffer(READ_SIZE)
				const n = await tls.read(this.#conn, this.#transport, buf, 0, READ_SIZE)
				if (n === 0) {
					this.#readEnded = true
					this.emit('end')
					this.destroy()
					return
				}
				this.emit('data', Buffer.from(new Uint8Array(buf, 0, n)))
			}
		} catch (err) {
			if (!this.#destroyed) this.#emitError(err)
		} finally {
			this.#reading = false
			if (!this.#paused && !this.#destroyed && !this.#readEnded) this.#pumpRead()
		}
	}

	write(data, encoding, callback) {
		if (typeof encoding === 'function') {
			callback = encoding
			encoding = undefined
		}
		if (this.#destroyed || this.#writeEnded) {
			const err = new Error('write after end')
			if (callback) callback(err)
			else this.#emitError(err)
			return false
		}

		const chunk = typeof data === 'string'
			? new TextEncoder().encode(data)
			: data instanceof Uint8Array
				? data
				: new Uint8Array(data)
		const size = chunk.byteLength ?? chunk.length ?? 0
		this.#queuedBytes += size

		const belowHighWater = this.#queuedBytes < HIGH_WATER_MARK
		if (!belowHighWater) this.#needDrain = true

		this.#enqueueWrite(async () => {
			if (this.#destroyed) return
			await tls.writeAll(this.#conn, this.#transport, chunk)
			if (callback) callback(null)
			if (!this.#paused) this.#pumpRead()
		}, (err) => {
			if (callback) callback(err)
		}, size)
		return belowHighWater
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
		if (data !== undefined && data !== null) this.write(data, encoding)
		if (this.#writeEnded) return this
		this.#writeEnded = true
		if (callback) this.once('finish', callback)

		this.#enqueueWrite(async () => {
			if (!this.#destroyed) await tls.close(this.#conn, this.#transport)
			this.emit('finish')
			this.destroy()
		})
		return this
	}

	#enqueueWrite(task, onError, size = 0) {
		this.#writeChain = this.#writeChain
			.then(task)
			.catch((err) => {
				if (onError) onError(err)
				this.#emitError(err)
			})
			.finally(() => {
				if (size > 0) {
					this.#queuedBytes = Math.max(0, this.#queuedBytes - size)
					if (this.#needDrain && !this.#destroyed && this.#queuedBytes < HIGH_WATER_MARK) {
						this.#needDrain = false
						this.emit('drain')
					}
				}
			})
	}

	destroy(err) {
		if (this.#destroyed) return this
		this.#destroyed = true
		try {
			if (this.#handle) _streamClose(this.#handle)
		} catch {}
		this.#handle = null
		this.#connected = false
		this.#queuedBytes = 0
		this.#needDrain = false
		if (err && this.listenerCount('error') > 0) this.emit('error', err)
		this.#emitClose(!!err)
		return this
	}

	#emitError(err) {
		this.destroy(err)
	}

	#emitClose(hadError) {
		if (this.#closed) return
		this.#closed = true
		this.emit('close', hadError)
	}

	ref() { return this }
	unref() { return this }
}

function validateClientOptions(options = {}) {
	if (options.socketPath) unsupported('socketPath')
	if (hasOwnDefined(options, 'agent')) {
		const agent = options.agent
		if (agent !== false && agent !== null && agent !== globalAgent && !(agent instanceof Agent))
			unsupported('agent')
	}
	assertUnsupportedAbsent(options, [
		'ca', 'cert', 'key', 'pfx', 'passphrase', 'secureContext',
		'checkServerIdentity', 'lookup', 'ALPNProtocols', 'ciphers',
		'secureProtocol', 'secureOptions', 'session',
	])
}

function createSecureConnection(options, callback) {
	return TLSSocket.connect(options, callback)
}

class SecureConnectionServer extends EventEmitter {
	#cred
	#handle = null
	#listening = false
	#closed = false
	#connections = new Set()

	constructor(options) {
		super()
		this.#cred = loadCredentials(options)
	}

	listen(port, host, backlog, callback) {
		if (typeof port === 'object') {
			const options = port
			callback = host
			port = options.port
			host = options.host || options.hostname
			backlog = options.backlog
		}
		if (typeof port === 'string') unsupported('path')
		if (typeof host === 'function') {
			callback = host
			host = undefined
			backlog = undefined
		}
		if (typeof backlog === 'function') {
			callback = backlog
			backlog = undefined
		}

		host = host || '0.0.0.0'
		backlog = backlog || 128
		if (callback) this.once('listening', callback)

		try {
			const family = host.includes(':') ? AF_INET6 : AF_INET
			this.#handle = tcpNew(family)
			tcpBind(this.#handle, host, port)
			setOnConnection(this.#handle, (clientHandle) => {
				if (clientHandle instanceof Error) {
					this.emit('error', clientHandle)
					return
				}
				this.#accept(clientHandle)
			})
			_listen(this.#handle, backlog)
			this.#listening = true
			queueMicrotask(() => this.emit('listening'))
		} catch (err) {
			queueMicrotask(() => this.emit('error', err))
		}
		return this
	}

	async #accept(handle) {
		const socket = TLSSocket.accept(handle, this.#cred)
		this.#connections.add(socket)
		socket.on('close', () => this.#connections.delete(socket))
		const ok = await socket._acceptHandshake()
		if (!ok || this.#closed) {
			socket.destroy()
			return
		}
		this.emit('connection', socket)
		socket.resume()
	}

	address() {
		if (!this.#handle) return null
		try { return formatAddr(tcpGetsockname(this.#handle)) } catch { return null }
	}

	close(callback) {
		if (this.#closed) return this
		this.#closed = true
		if (callback) this.once('close', callback)
		if (this.#handle) {
			try { _streamClose(this.#handle) } catch {}
			this.#handle = null
		}
		this.#listening = false
		for (const socket of this.#connections) socket.destroy()
		this.#connections.clear()
		queueMicrotask(() => this.emit('close'))
		return this
	}

	ref() { return this }
	unref() { return this }
	get listening() { return this.#listening }
}

export class Server extends HTTPServer {
	constructor(options, requestListener) {
		if (typeof options === 'function') {
			requestListener = options
			options = {}
		}
		const secureServer = new SecureConnectionServer(options || {})
		super({ ...(options || {}), _server: secureServer }, requestListener)
	}
}

export class Agent {
	constructor(options = {}) {
		if (Object.keys(options).length > 0)
			unsupported('Agent options')
	}
}

export const globalAgent = new Agent()

export function createServer(options, requestListener) {
	return new Server(options, requestListener)
}

const httpsTransport = {
	protocol: 'https:',
	defaultPort: DEFAULT_PORT,
	createConnection: createSecureConnection,
	isDefaultPort: (port) => Number(port) === DEFAULT_PORT,
	connectionOptions: (options) => ({
		servername: options.servername,
		rejectUnauthorized: options.rejectUnauthorized,
	}),
}

function validationOptions(input, options) {
	if (typeof options === 'function') options = undefined
	if (typeof input === 'string' || input instanceof URL) return options || {}
	return { ...(input || {}), ...(options || {}) }
}

export function request(input, options, callback) {
	validateClientOptions(validationOptions(input, options))
	return new ClientRequest(input, options, callback, httpsTransport)
}

export function get(input, options, callback) {
	const req = request(input, options, callback)
	req.end()
	return req
}

export {
	ClientRequest,
	IncomingMessage,
	ServerResponse,
	STATUS_CODES,
}

export default {
	Agent,
	globalAgent,
	createServer,
	request,
	get,
	Server,
	ClientRequest,
	IncomingMessage,
	ServerResponse,
	STATUS_CODES,
}
