/**
 * node:tls - TLS sockets backed by BearSSL
 * @see https://nodejs.org/api/tls.html
 *
 * This is intentionally a focused subset of node:tls. It provides the socket
 * and server transports used by node:https and WebSocket while rejecting TLS
 * options that qn cannot honor.
 */

import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import * as tls from 'qn:tls'
import {
	tcpNew, tcpBind, listen as _listen, tcpConnect as _tcpConnect,
	close as _streamClose, setOnConnection, setOnConnect,
	tcpGetsockname, tcpGetpeername, tcpNodelay, tcpKeepalive,
	AF_INET, AF_INET6,
} from 'qn/uv-stream'
import { getaddrinfo as _getaddrinfo } from 'qn_uv_dns'

const DEFAULT_PORT = 443
const READ_SIZE = 64 * 1024
const HIGH_WATER_MARK = 64 * 1024
const READ_INTERRUPTED = Symbol('TLS read interrupted')

function unsupported(name) {
	throw new TypeError(`node:tls option ${name} is not supported`)
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
	throw new TypeError(`node:tls option ${name} must be a PEM string, Buffer, or Uint8Array`)
}

function loadCredentials(options = {}) {
	assertUnsupportedAbsent(options, [
		'pfx', 'passphrase', 'secureContext', 'SNICallback', 'ALPNProtocols',
		'ciphers', 'clientCertEngine', 'crl', 'dhparam', 'ecdhCurve',
		'honorCipherOrder', 'minVersion', 'maxVersion', 'secureOptions',
		'secureProtocol', 'sessionIdContext', 'sigalgs', 'ticketKeys',
	])
	if (options.requestCert || options.rejectUnauthorized === true || hasOwnDefined(options, 'ca')) {
		unsupported('client certificate authentication')
	}

	if (options.certFile || options.keyFile) {
		if (!options.certFile || !options.keyFile)
			throw new TypeError('node:tls requires both certFile and keyFile')
		return tls.loadServerCert(String(options.certFile), String(options.keyFile))
	}

	if (!hasOwnDefined(options, 'cert') || !hasOwnDefined(options, 'key'))
		throw new TypeError('node:tls.createServer requires key and cert options')
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

function validateClientOptions(options = {}) {
	if (options.socketPath || options.path && !options.host && !options.hostname)
		unsupported('socketPath')
	if (options.rejectUnauthorized !== false && hasOwnDefined(options, 'servername') && String(options.servername) === '')
		unsupported('empty servername with certificate verification')
	assertUnsupportedAbsent(options, [
		'ca', 'cert', 'key', 'pfx', 'passphrase', 'secureContext',
		'checkServerIdentity', 'lookup', 'ALPNProtocols', 'ciphers',
		'clientCertEngine', 'crl', 'dhparam', 'ecdhCurve', 'honorCipherOrder',
		'minVersion', 'maxVersion', 'secureProtocol', 'secureOptions', 'session',
		'sigalgs', 'timeout',
	])
}

export class TLSSocket extends EventEmitter {
	#handle = null
	#conn = null
	#transport = null
	#connected = false
	#connecting = false
	#destroyed = false
	#paused = false
	#reading = false
	#readEnded = false
	#writeEnded = false
	#closed = false
	#writeChain = Promise.resolve()
	#queuedBytes = 0
	#needDrain = false
	#unshiftBuf = null
	#securePromise
	#resolveSecure = null
	#secureSettled = false
	#ioChain = Promise.resolve()
	#readAbort = null

	encrypted = true
	authorized = false
	authorizationError = null
	alpnProtocol = false
	servername = undefined

	constructor(socket) {
		super()
		if (socket !== undefined && socket !== null)
			unsupported('wrapping an existing socket with TLSSocket')
		this.#securePromise = new Promise(resolve => this.#resolveSecure = resolve)
	}

	static connect(options, callback) {
		validateClientOptions(options)
		const socket = new TLSSocket()
		socket.#connecting = true
		if (callback) socket.once('secureConnect', callback)
		queueMicrotask(() => socket.#connect(options))
		return socket
	}

	static accept(handle, cred) {
		const socket = new TLSSocket()
		socket.#handle = handle
		socket.#transport = tls.streamTransport(handle)
		socket.#conn = tls.accept(cred)
		return socket
	}

	async #connect(options) {
		if (this.#destroyed) return
		try {
			const host = options.hostname || options.host || 'localhost'
			const port = options.port ? Number(options.port) : DEFAULT_PORT
			const rejectUnauthorized = options.rejectUnauthorized !== false
			const servername = hasOwnDefined(options, 'servername')
				? String(options.servername)
				: defaultServername(host, rejectUnauthorized)
			if (rejectUnauthorized) tls.ensureCACerts()

			this.servername = servername
			const handle = await tcpConnect(host, port)
			if (this.#destroyed) {
				try { _streamClose(handle) } catch {}
				return
			}
			this.#handle = handle
			this.emit('connect')
			if (this.#destroyed) return
			this.#transport = tls.streamTransport(this.#handle)
			this.#conn = tls.connect(servername, { rejectUnauthorized })
			await tls.handshake(this.#conn, this.#transport)
			if (this.#destroyed) return
			this.#connecting = false
			this.#connected = true
			this.authorized = rejectUnauthorized
			this.authorizationError = rejectUnauthorized ? null : 'CERTIFICATE_VERIFICATION_DISABLED'
			this.#settleSecure()
			this.emit('secureConnect')
			if (!this.#paused) this.#pumpRead()
		} catch (err) {
			this.#connecting = false
			this.#settleSecure(err)
			this.#emitError(err)
		}
	}

	async _acceptHandshake() {
		try {
			await tls.handshake(this.#conn, this.#transport)
			if (this.#destroyed) return false
			this.#connected = true
			this.#settleSecure()
			return true
		} catch (err) {
			this.#settleSecure(err)
			throw err
		}
	}

	#settleSecure(error = null) {
		if (this.#secureSettled) return
		this.#secureSettled = true
		const resolve = this.#resolveSecure
		this.#resolveSecure = null
		resolve(error)
	}

	#withIO(task) {
		/* BearSSL exposes one mutable state machine per connection. Serialize access; a write aborts an idle read so it can acquire the engine without waiting for network input. */
		const result = this.#ioChain.then(task)
		this.#ioChain = result.catch(() => {})
		return result
	}

	#interruptRead() {
		if (this.#readAbort && !this.#readAbort.signal.aborted)
			this.#readAbort.abort(READ_INTERRUPTED)
	}

	get connecting() { return this.#connecting }
	get destroyed() { return this.#destroyed }
	get readable() { return this.#connected && !this.#readEnded && !this.#destroyed }
	get writable() { return this.#connected && !this.#writeEnded && !this.#destroyed }
	get isPaused() { return this.#paused }
	get _handle() { return this.#handle }
	get _writableState() { return { length: this.#queuedBytes } }
	get readyState() {
		if (this.#connecting) return 'opening'
		if (this.#connected) return 'open'
		return 'closed'
	}

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

	get remoteFamily() {
		try { return formatAddr(tcpGetpeername(this.#handle))?.family } catch { return undefined }
	}

	get localAddress() { return this.address()?.address }
	get localPort() { return this.address()?.port }

	getProtocol() { return this.#connected ? 'TLSv1.2' : null }

	setNoDelay(noDelay = true) {
		if (this.#handle) tcpNodelay(this.#handle, noDelay)
		return this
	}

	setKeepAlive(enable = false) {
		if (this.#handle) tcpKeepalive(this.#handle, enable)
		return this
	}

	pause() {
		this.#paused = true
		this.#interruptRead()
		return this
	}

	resume() {
		if (this.#destroyed || this.#readEnded) return this
		this.#paused = false
		this.#pumpRead()
		return this
	}

	unshift(chunk) {
		if (!chunk || chunk.length === 0) return
		this.#unshiftBuf = chunk
		process.nextTick(() => {
			if (this.#destroyed || !this.#unshiftBuf) return
			const buf = this.#unshiftBuf
			this.#unshiftBuf = null
			this.emit('data', buf)
		})
	}

	async #pumpRead() {
		if (this.#reading || this.#paused || this.#destroyed || !this.#connected) return
		this.#reading = true
		try {
			while (!this.#paused && !this.#destroyed) {
				const controller = new AbortController()
				this.#readAbort = controller
				const buf = new ArrayBuffer(READ_SIZE)
				let n
				try {
					n = await this.#withIO(() => tls.read(
						this.#conn, this.#transport, buf, 0, READ_SIZE, controller.signal
					))
				} catch (err) {
					if (err === READ_INTERRUPTED) return
					throw err
				} finally {
					if (this.#readAbort === controller) this.#readAbort = null
				}
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
			const secureError = await this.#securePromise
			if (secureError) throw secureError
			if (this.#destroyed) return
			this.#interruptRead()
			await this.#withIO(() => tls.writeAll(this.#conn, this.#transport, chunk))
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
			const secureError = await this.#securePromise
			if (secureError) throw secureError
			if (!this.#destroyed) {
				this.#interruptRead()
				await this.#withIO(() => tls.close(this.#conn, this.#transport))
			}
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
		this.#settleSecure(err || new Error('Socket closed before TLS handshake completed'))
		this.#interruptRead()
		try {
			if (this.#handle) _streamClose(this.#handle)
		} catch {}
		this.#handle = null
		this.#connected = false
		this.#connecting = false
		this.#queuedBytes = 0
		this.#needDrain = false
		this.#unshiftBuf = null
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

function normalizeConnectArgs(args) {
	let options
	let callback
	if (typeof args[0] === 'object') {
		options = { ...args[0] }
		callback = args[1]
	} else {
		options = { port: args[0] }
		let index = 1
		if (typeof args[index] === 'string') options.host = args[index++]
		if (typeof args[index] === 'object') options = { ...options, ...args[index++] }
		callback = args[index]
	}
	return { options, callback: typeof callback === 'function' ? callback : undefined }
}

export function connect(...args) {
	const { options, callback } = normalizeConnectArgs(args)
	return TLSSocket.connect(options, callback)
}

export class Server extends EventEmitter {
	#cred
	#handle = null
	#listening = false
	#closed = false
	#connections = new Set()

	constructor(options = {}, secureConnectionListener) {
		super()
		this.#cred = loadCredentials(options)
		if (secureConnectionListener) this.on('secureConnection', secureConnectionListener)
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
		try {
			const ok = await socket._acceptHandshake()
			if (!ok || this.#closed) {
				socket.destroy()
				return
			}
			this.emit('secureConnection', socket)
			socket.resume()
		} catch (err) {
			if (this.listenerCount('tlsClientError') > 0) this.emit('tlsClientError', err, socket)
			socket.destroy()
		}
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

export function createServer(options, secureConnectionListener) {
	return new Server(options, secureConnectionListener)
}

export default {
	TLSSocket,
	Server,
	connect,
	createServer,
}
