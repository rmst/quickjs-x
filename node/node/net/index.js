/**
 * node:net - TCP networking module
 * @see https://nodejs.org/api/net.html
 *
 * Built on top of libuv streams (qn:uv-stream) for event-loop-integrated
 * async I/O, and libuv DNS (qn_uv_dns) for name resolution.
 */

import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import {
	tcpNew, tcpBind, listen as _listen, tcpConnect,
	pipeNew, pipeBind, pipeConnect, pipeGetsockname, pipeGetpeername,
	readStart, readStop, write as _write, shutdown as _shutdown, close as _close,
	fileno, tcpNodelay, tcpKeepalive,
	tcpGetsockname, tcpGetpeername,
	setOnRead, setOnConnection, setOnConnect, setOnShutdown,
	AF_INET, AF_INET6,
} from 'qn/uv-stream'
import { getaddrinfo as _getaddrinfo } from 'qn_uv_dns'

export { AF_INET, AF_INET6 }

/* Address format conversion: C module returns { family: 4|6, ip, port }
 * Node.js net expects { address, port, family: "IPv4"|"IPv6" } */
function formatAddr(raw) {
	if (!raw) return null
	if (typeof raw === 'string') return raw
	return {
		address: raw.ip,
		port: raw.port,
		family: raw.family === 6 ? 'IPv6' : 'IPv4',
	}
}

/**
 * TCP Socket - represents a single TCP connection.
 *
 * Events: 'connect', 'data', 'end', 'close', 'error', 'drain'
 */
export class Socket extends EventEmitter {
	#handle = null
	#writeBuf = []
	#writing = false
	#connecting = false
	#connected = false
	#destroyed = false
	#readEnded = false
	#writeEnded = false
	#allowHalfOpen = false
	#paused = false
	#unshiftBuf = null
	#pipe = false
	remoteAddress = null
	remotePort = null
	remoteFamily = null
	localAddress = null
	localPort = null

	constructor(options = {}) {
		super()
		this.#allowHalfOpen = options.allowHalfOpen || false
		this.#pipe = options._pipe || false
		if (this.#pipe) {
			this.remoteAddress = undefined
			this.remotePort = undefined
			this.remoteFamily = undefined
			this.localAddress = undefined
			this.localPort = undefined
		}
		if (options._handle !== undefined) {
			this.#handle = options._handle
			this.#connected = true
			this.#setupRemoteInfo()
			this.#startReading()
		}
	}

	/** Expose internal handle for TLS integration (matches Node.js convention). */
	get _handle() { return this.#handle }

	get readyState() {
		if (this.#connecting) return 'opening'
		if (this.#connected) return 'open'
		return 'closed'
	}

	#setupRemoteInfo() {
		if (this.#pipe) return
		try {
			const peer = formatAddr(tcpGetpeername(this.#handle))
			if (peer) {
				this.remoteAddress = peer.address
				this.remotePort = peer.port
				this.remoteFamily = peer.family
			}
		} catch (e) {
			// ignore - may not be connected yet
		}
		try {
			const local = formatAddr(tcpGetsockname(this.#handle))
			if (local) {
				this.localAddress = local.address
				this.localPort = local.port
			}
		} catch (e) {
			// ignore
		}
	}

	#startReading() {
		setOnRead(this.#handle, (buf, err) => {
			if (this.#destroyed) return
			if (err) {
				this.#emitError(err)
				return
			}
			if (buf === null) {
				// EOF — remote closed their write side
				readStop(this.#handle)
				this.#readEnded = true
				this.emit('end')
				if (!this.#allowHalfOpen) {
					if (this.#writeEnded) {
						// Both sides done — destroy
						this.destroy()
					} else {
						// Auto-close our write side too
						this.end()
					}
				}
				return
			}
			this.emit('data', Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
		})
		readStart(this.#handle)
	}

	connect(options, callback) {
		if (typeof options === 'number') {
			options = { port: options, host: arguments[1] }
			callback = arguments[2]
		}
		if (typeof options === 'string') {
			options = { path: options }
			callback = arguments[1]
		}

		const port = options.port
		const host = options.host || '127.0.0.1'
		const path = options.path

		if (callback) this.once('connect', callback)

		this.#connecting = true
		if (path !== undefined) this.#doPipeConnect(path)
		else this.#doConnect(host, port)

		return this
	}

	#doPipeConnect(path) {
		try {
			this.#pipe = true
			this.remoteAddress = undefined
			this.remotePort = undefined
			this.remoteFamily = undefined
			this.localAddress = undefined
			this.localPort = undefined
			this.#handle = pipeNew()
			setOnConnect(this.#handle, (err) => {
				if (this.#destroyed) return
				if (err) {
					this.#connecting = false
					this.#emitError(err)
					return
				}
				this.#connecting = false
				this.#connected = true
				this.#startReading()
				this.emit('connect')
			})
			pipeConnect(this.#handle, path)
		} catch (e) {
			this.#emitError(e)
		}
	}

	async #doConnect(host, port) {
		let addresses
		try {
			addresses = await _getaddrinfo(host, port, { family: AF_INET })
			if (this.#destroyed) return
			if (addresses.length === 0) {
				addresses = await _getaddrinfo(host, port)
			}
		} catch (e) {
			if (this.#destroyed) return
			this.#emitError(e)
			return
		}

		if (this.#destroyed) return

		const addr = addresses[0]
		try {
			this.#handle = tcpNew(addr.family)
		} catch (e) {
			this.#emitError(e)
			return
		}

		try {
			setOnConnect(this.#handle, (err) => {
				if (this.#destroyed) return
				if (err) {
					this.#connecting = false
					this.#emitError(err)
					return
				}
				this.#connecting = false
				this.#connected = true
				this.#setupRemoteInfo()
				this.#startReading()
				this.emit('connect')
			})
			tcpConnect(this.#handle, addr.address, port)
		} catch (e) {
			this.#emitError(e)
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
			return false
		}

		const chunk = typeof data === 'string'
			? new TextEncoder().encode(data)
			: data instanceof Uint8Array
				? data
				: new Uint8Array(data)

		this.#writeBuf.push({ chunk, callback })
		this.#flush()
		return this.#writeBuf.length === 0
	}

	async #flush() {
		if (this.#writing || this.#writeBuf.length === 0 || !this.#handle) return

		this.#writing = true
		while (this.#writeBuf.length > 0 && !this.#destroyed) {
			const cur = this.#writeBuf[0]
			try {
				await _write(this.#handle, cur.chunk)
				this.#writeBuf.shift()
				if (cur.callback) cur.callback(null)
			} catch (e) {
				this.#writing = false
				this.#emitError(e)
				return
			}
		}
		this.#writing = false
		if (!this.#destroyed) this.emit('drain')
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

		if (data !== undefined && data !== null) {
			this.write(data, encoding)
		}

		if (this.#writeEnded) return this
		this.#writeEnded = true

		if (callback) this.once('finish', callback)

		const doEnd = () => {
			if (this.#writeBuf.length > 0) {
				this.once('drain', doEnd)
				return
			}
			if (this.#handle && this.#connected) {
				setOnShutdown(this.#handle, (err) => {
					this.emit('finish')
					if (this.#readEnded) {
						this.destroy()
					} else if (!this.#allowHalfOpen && this.#paused) {
						/* Without this, a paused socket (uv_read_stop) won't
						 * see the peer's FIN — the EOF callback never fires,
						 * destroy() is never called, and the fd leaks in TCP
						 * CLOSED state until the process exits. Resuming lets
						 * libuv deliver the EOF, which goes through the read
						 * EOF handler and destroys cleanly. Any bytes still in
						 * flight are emitted as 'data' first; that matches
						 * Node.js semantics (end() doesn't suppress data). */
						this.#paused = false
						readStart(this.#handle)
					}
				})
				try {
					_shutdown(this.#handle)
				} catch (e) {
					// ignore errors during shutdown
					this.emit('finish')
					if (this.#readEnded) {
						this.destroy()
					}
				}
			} else {
				this.emit('finish')
				this.destroy()
			}
		}

		doEnd()
		return this
	}

	destroy(err) {
		if (this.#destroyed) return this
		this.#destroyed = true

		if (this.#handle) {
			_close(this.#handle)
			this.#handle = null
		}

		this.#connected = false
		this.#connecting = false
		this.#writeBuf = []

		if (err) this.emit('error', err)
		this.emit('close', !!err)
		return this
	}

	setNoDelay(noDelay = true) {
		if (this.#pipe) return this
		if (this.#handle) {
			tcpNodelay(this.#handle, noDelay)
		}
		return this
	}

	setKeepAlive(enable = false) {
		if (this.#pipe) return this
		if (this.#handle) {
			tcpKeepalive(this.#handle, enable)
		}
		return this
	}

	address() {
		if (!this.#handle) return null
		try {
			if (this.#pipe) return {}
			return formatAddr(tcpGetsockname(this.#handle))
		} catch (e) {
			return null
		}
	}

	get readable() { return this.#connected && !this.#readEnded && !this.#destroyed }
	get writable() { return this.#connected && !this.#writeEnded && !this.#destroyed }
	get destroyed() { return this.#destroyed }

	pause() {
		if (this.#handle && !this.#paused) {
			this.#paused = true
			readStop(this.#handle)
		}
		return this
	}

	resume() {
		if (this.#handle && this.#paused) {
			this.#paused = false
			readStart(this.#handle)
		}
		return this
	}

	get isPaused() { return this.#paused }

	unshift(chunk) {
		if (!chunk || chunk.length === 0) return
		// Queue the chunk to be re-emitted as 'data' on the next microtask,
		// so listeners added after unshift() but in the same tick receive it.
		this.#unshiftBuf = chunk
		process.nextTick(() => {
			if (this.#destroyed || !this.#unshiftBuf) return
			const buf = this.#unshiftBuf
			this.#unshiftBuf = null
			this.emit('data', buf)
		})
	}

	ref() { return this }
	unref() { return this }

	#emitError(err) {
		if (this.listenerCount('error') > 0) {
			this.emit('error', err)
		}
		this.destroy()
	}
}

/**
 * TCP Server
 *
 * Events: 'listening', 'connection', 'close', 'error'
 */
export class Server extends EventEmitter {
	#handle = null
	#listening = false
	#closed = false
	#connections = new Set()
	#pipe = false
	#pipePath = null

	constructor(options, connectionListener) {
		super()
		if (typeof options === 'function') {
			connectionListener = options
			options = {}
		}
		if (connectionListener) {
			this.on('connection', connectionListener)
		}
	}

	listen(port, host, backlog, callback) {
		if (typeof port === 'object') {
			const options = port
			callback = host
			port = options.port
			host = options.host
			backlog = options.backlog
			if (options.path !== undefined) port = options.path
		}
		if (typeof port === 'string') {
			const path = port
			if (typeof host === 'function') {
				callback = host
				backlog = undefined
			} else if (typeof host === 'number') {
				if (typeof backlog === 'function') callback = backlog
				backlog = host
			} else if (typeof backlog === 'function') {
				callback = backlog
				backlog = undefined
			}
			backlog = backlog || 128
			if (callback) this.once('listening', callback)
			try {
				this.#pipe = true
				this.#pipePath = path
				this.#handle = pipeNew()
				pipeBind(this.#handle, path)
				setOnConnection(this.#handle, (clientHandle) => {
					if (clientHandle instanceof Error) {
						if (this.listenerCount('error') > 0) {
							this.emit('error', clientHandle)
						}
						return
					}
					const sock = new Socket({ _handle: clientHandle, _pipe: true })
					this.#connections.add(sock)
					sock.on('close', () => this.#connections.delete(sock))
					this.emit('connection', sock)
				})
				_listen(this.#handle, backlog)
				this.#listening = true
				queueMicrotask(() => this.emit('listening'))
			} catch (e) {
				if (this.#handle) {
					try { _close(this.#handle) } catch {}
					this.#handle = null
				}
				this.#pipe = false
				this.#pipePath = null
				queueMicrotask(() => {
					if (this.listenerCount('error') > 0) {
						this.emit('error', e)
					} else {
						throw e
					}
				})
			}
			return this
		}
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
					if (this.listenerCount('error') > 0) {
						this.emit('error', clientHandle)
					}
					return
				}
				const sock = new Socket({ _handle: clientHandle })
				this.#connections.add(sock)
				sock.on('close', () => this.#connections.delete(sock))
				this.emit('connection', sock)
			})

			_listen(this.#handle, backlog)
			this.#listening = true

			queueMicrotask(() => this.emit('listening'))
		} catch (e) {
			queueMicrotask(() => {
				if (this.listenerCount('error') > 0) {
					this.emit('error', e)
				} else {
					throw e
				}
			})
		}

		return this
	}

	address() {
		if (!this.#handle) return null
		try {
			if (this.#pipe) return pipeGetsockname(this.#handle) || this.#pipePath
			return formatAddr(tcpGetsockname(this.#handle))
		} catch (e) {
			if (this.#pipe) return this.#pipePath
			return null
		}
	}

	close(callback) {
		if (this.#closed) return this
		this.#closed = true

		if (callback) this.once('close', callback)

		if (this.#handle) {
			_close(this.#handle)
			this.#handle = null
		}
		this.#listening = false

		// Destroy all active connections
		for (const conn of this.#connections) {
			conn.destroy()
		}
		this.#connections.clear()

		queueMicrotask(() => this.emit('close'))
		return this
	}

	ref() { return this }
	unref() { return this }

	get listening() { return this.#listening }
}

/**
 * Create a TCP server.
 */
export function createServer(options, connectionListener) {
	return new Server(options, connectionListener)
}

/**
 * Create a TCP connection.
 */
export function createConnection(options, callback) {
	if (typeof options === 'number') {
		options = { port: options, host: arguments[1] }
		callback = arguments[2]
	}
	const sock = new Socket()
	return sock.connect(options, callback)
}

export const connect = createConnection

export default {
	Socket,
	Server,
	createServer,
	createConnection,
	connect,
}
