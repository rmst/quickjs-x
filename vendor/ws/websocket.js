import { EventEmitter } from 'node:events'
import { connect as netConnect } from 'node:net'
// TLSSocket not yet implemented in qn — wss:// will error at connect time
import { randomBytes, createHash } from 'node:crypto'

import Receiver from './receiver.js'
import Sender from './sender.js'
import { isBlob } from './validation.js'

import {
	BINARY_TYPES,
	CLOSE_TIMEOUT,
	EMPTY_BUFFER,
	GUID,
	kForOnEventAttribute,
	kListener,
	kStatusCode,
	kWebSocket,
	NOOP
} from './constants.js'
import { EventTarget } from './event-target.js'

const { addEventListener, removeEventListener } = EventTarget
import { toBuffer } from './buffer-util.js'

const readyStates = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']
const protocolVersions = [8, 13]
const subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/

/**
 * Class representing a WebSocket.
 *
 * @extends EventEmitter
 */
class WebSocket extends EventEmitter {
	/**
	 * Create a new `WebSocket`.
	 *
	 * @param {(String|URL)} address The URL to which to connect
	 * @param {(String|String[])} [protocols] The subprotocols
	 * @param {Object} [options] Connection options
	 */
	constructor(address, protocols, options) {
		super()

		this._binaryType = BINARY_TYPES[0]
		this._closeCode = 1006
		this._closeFrameReceived = false
		this._closeFrameSent = false
		this._closeMessage = EMPTY_BUFFER
		this._closeTimer = null
		this._errorEmitted = false
		this._extensions = {}
		this._paused = false
		this._protocol = ''
		this._readyState = WebSocket.CONNECTING
		this._receiver = null
		this._sender = null
		this._socket = null

		if (address !== null) {
			this._bufferedAmount = 0
			this._isServer = false
			this._redirects = 0

			if (protocols === undefined) {
				protocols = []
			} else if (!Array.isArray(protocols)) {
				if (typeof protocols === 'object' && protocols !== null) {
					options = protocols
					protocols = []
				} else {
					protocols = [protocols]
				}
			}

			initAsClient(this, address, protocols, options)
		} else {
			this._autoPong = options.autoPong
			this._closeTimeout = options.closeTimeout
			this._isServer = true
		}
	}

	/**
	 * For historical reasons, the custom "nodebuffer" type is used by the default
	 * instead of "blob".
	 *
	 * @type {String}
	 */
	get binaryType() {
		return this._binaryType
	}

	set binaryType(type) {
		if (!BINARY_TYPES.includes(type)) return

		this._binaryType = type

		//
		// Allow to change `binaryType` on the fly.
		//
		if (this._receiver) this._receiver._binaryType = type
	}

	/**
	 * @type {Number}
	 */
	get bufferedAmount() {
		if (!this._socket) return this._bufferedAmount

		return (
			(this._socket._writableState ? this._socket._writableState.length : 0) +
			this._sender._bufferedBytes
		)
	}

	/**
	 * @type {String}
	 */
	get extensions() {
		return Object.keys(this._extensions).join()
	}

	/**
	 * @type {Boolean}
	 */
	get isPaused() {
		return this._paused
	}

	/* istanbul ignore next */
	get onclose() {
		return null
	}

	/* istanbul ignore next */
	get onerror() {
		return null
	}

	/* istanbul ignore next */
	get onopen() {
		return null
	}

	/* istanbul ignore next */
	get onmessage() {
		return null
	}

	/**
	 * @type {String}
	 */
	get protocol() {
		return this._protocol
	}

	/**
	 * @type {Number}
	 */
	get readyState() {
		return this._readyState
	}

	/**
	 * @type {String}
	 */
	get url() {
		return this._url
	}

	/**
	 * Set up the socket and the internal resources.
	 *
	 * @param {*} socket The network socket between the server and client
	 * @param {Buffer} head The first packet of the upgraded stream
	 * @param {Object} options Options object
	 * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
	 *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
	 *     multiple times in the same tick
	 * @param {Function} [options.generateMask] The function used to generate the
	 *     masking key
	 * @param {Number} [options.maxPayload=0] The maximum allowed message size
	 * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
	 *     not to skip UTF-8 validation for text and close messages
	 * @private
	 */
	setSocket(socket, head, options) {
		const receiver = new Receiver({
			allowSynchronousEvents: options.allowSynchronousEvents,
			binaryType: this.binaryType,
			extensions: this._extensions,
			isServer: this._isServer,
			maxPayload: options.maxPayload,
			skipUTF8Validation: options.skipUTF8Validation
		})

		const sender = new Sender(socket, this._extensions, options.generateMask)

		this._receiver = receiver
		this._sender = sender
		this._socket = socket

		receiver[kWebSocket] = this
		sender[kWebSocket] = this
		socket[kWebSocket] = this

		receiver.on('conclude', receiverOnConclude)
		receiver.on('drain', receiverOnDrain)
		receiver.on('error', receiverOnError)
		receiver.on('message', receiverOnMessage)
		receiver.on('ping', receiverOnPing)
		receiver.on('pong', receiverOnPong)

		sender.onerror = senderOnError

		//
		// These methods may not be available if `socket` is just a `Duplex`.
		//
		if (socket.setTimeout) socket.setTimeout(0)
		if (socket.setNoDelay) socket.setNoDelay()

		if (head.length > 0) socket.unshift(head)

		socket.on('close', socketOnClose)
		socket.on('data', socketOnData)
		socket.on('end', socketOnEnd)
		socket.on('error', socketOnError)

		this._readyState = WebSocket.OPEN
		this.emit('open')
	}

	/**
	 * Emit the `'close'` event.
	 *
	 * @private
	 */
	emitClose() {
		if (!this._socket) {
			this._readyState = WebSocket.CLOSED
			this.emit('close', this._closeCode, this._closeMessage)
			return
		}

		this._receiver.removeAllListeners()
		this._readyState = WebSocket.CLOSED
		this.emit('close', this._closeCode, this._closeMessage)
	}

	/**
	 * Start a closing handshake.
	 *
	 * @param {Number} [code] Status code explaining why the connection is closing
	 * @param {(String|Buffer)} [data] The reason why the connection is
	 *     closing
	 * @public
	 */
	close(code, data) {
		if (this.readyState === WebSocket.CLOSED) return
		if (this.readyState === WebSocket.CONNECTING) {
			const msg = 'WebSocket was closed before the connection was established'
			abortHandshake(this, this._socket, msg)
			return
		}

		if (this.readyState === WebSocket.CLOSING) {
			if (
				this._closeFrameSent &&
				(this._closeFrameReceived || this._receiver._writableState.errorEmitted)
			) {
				this._socket.end()
			}

			return
		}

		this._readyState = WebSocket.CLOSING
		this._sender.close(code, data, !this._isServer, (err) => {
			//
			// This error is handled by the `'error'` listener on the socket. We only
			// want to know if the close frame has been sent here.
			//
			if (err) return

			this._closeFrameSent = true

			if (
				this._closeFrameReceived ||
				this._receiver._writableState.errorEmitted
			) {
				this._socket.end()
			}
		})

		setCloseTimer(this)
	}

	/**
	 * Pause the socket.
	 *
	 * @public
	 */
	pause() {
		if (
			this.readyState === WebSocket.CONNECTING ||
			this.readyState === WebSocket.CLOSED
		) {
			return
		}

		this._paused = true
		this._socket.pause()
	}

	/**
	 * Send a ping.
	 *
	 * @param {*} [data] The data to send
	 * @param {Boolean} [mask] Indicates whether or not to mask `data`
	 * @param {Function} [cb] Callback which is executed when the ping is sent
	 * @public
	 */
	ping(data, mask, cb) {
		if (this.readyState === WebSocket.CONNECTING) {
			throw new Error('WebSocket is not open: readyState 0 (CONNECTING)')
		}

		if (typeof data === 'function') {
			cb = data
			data = mask = undefined
		} else if (typeof mask === 'function') {
			cb = mask
			mask = undefined
		}

		if (typeof data === 'number') data = data.toString()

		if (this.readyState !== WebSocket.OPEN) {
			sendAfterClose(this, data, cb)
			return
		}

		if (mask === undefined) mask = !this._isServer
		this._sender.ping(data || EMPTY_BUFFER, mask, cb)
	}

	/**
	 * Send a pong.
	 *
	 * @param {*} [data] The data to send
	 * @param {Boolean} [mask] Indicates whether or not to mask `data`
	 * @param {Function} [cb] Callback which is executed when the pong is sent
	 * @public
	 */
	pong(data, mask, cb) {
		if (this.readyState === WebSocket.CONNECTING) {
			throw new Error('WebSocket is not open: readyState 0 (CONNECTING)')
		}

		if (typeof data === 'function') {
			cb = data
			data = mask = undefined
		} else if (typeof mask === 'function') {
			cb = mask
			mask = undefined
		}

		if (typeof data === 'number') data = data.toString()

		if (this.readyState !== WebSocket.OPEN) {
			sendAfterClose(this, data, cb)
			return
		}

		if (mask === undefined) mask = !this._isServer
		this._sender.pong(data || EMPTY_BUFFER, mask, cb)
	}

	/**
	 * Resume the socket.
	 *
	 * @public
	 */
	resume() {
		if (
			this.readyState === WebSocket.CONNECTING ||
			this.readyState === WebSocket.CLOSED
		) {
			return
		}

		this._paused = false
		if (!this._receiver._writableState.needDrain) this._socket.resume()
	}

	/**
	 * Send a data message.
	 *
	 * @param {*} data The message to send
	 * @param {Object} [options] Options object
	 * @param {Boolean} [options.binary] Specifies whether `data` is binary or
	 *     text
	 * @param {Boolean} [options.compress] Specifies whether or not to compress
	 *     `data`
	 * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
	 *     last one
	 * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
	 * @param {Function} [cb] Callback which is executed when data is written out
	 * @public
	 */
	send(data, options, cb) {
		if (this.readyState === WebSocket.CONNECTING) {
			throw new Error('WebSocket is not open: readyState 0 (CONNECTING)')
		}

		if (typeof options === 'function') {
			cb = options
			options = {}
		}

		if (typeof data === 'number') data = data.toString()

		if (this.readyState !== WebSocket.OPEN) {
			sendAfterClose(this, data, cb)
			return
		}

		const opts = {
			binary: typeof data !== 'string',
			mask: !this._isServer,
			compress: false,
			fin: true,
			...options
		}

		// No permessage-deflate support
		opts.compress = false

		this._sender.send(data || EMPTY_BUFFER, opts, cb)
	}

	/**
	 * Forcibly close the connection.
	 *
	 * @public
	 */
	terminate() {
		if (this.readyState === WebSocket.CLOSED) return
		if (this.readyState === WebSocket.CONNECTING) {
			const msg = 'WebSocket was closed before the connection was established'
			abortHandshake(this, this._socket, msg)
			return
		}

		if (this._socket) {
			this._readyState = WebSocket.CLOSING
			this._socket.destroy()
		}
	}
}

/**
 * @constant {Number} CONNECTING
 * @memberof WebSocket
 */
Object.defineProperty(WebSocket, 'CONNECTING', {
	enumerable: true,
	value: readyStates.indexOf('CONNECTING')
})

/**
 * @constant {Number} CONNECTING
 * @memberof WebSocket.prototype
 */
Object.defineProperty(WebSocket.prototype, 'CONNECTING', {
	enumerable: true,
	value: readyStates.indexOf('CONNECTING')
})

/**
 * @constant {Number} OPEN
 * @memberof WebSocket
 */
Object.defineProperty(WebSocket, 'OPEN', {
	enumerable: true,
	value: readyStates.indexOf('OPEN')
})

/**
 * @constant {Number} OPEN
 * @memberof WebSocket.prototype
 */
Object.defineProperty(WebSocket.prototype, 'OPEN', {
	enumerable: true,
	value: readyStates.indexOf('OPEN')
})

/**
 * @constant {Number} CLOSING
 * @memberof WebSocket
 */
Object.defineProperty(WebSocket, 'CLOSING', {
	enumerable: true,
	value: readyStates.indexOf('CLOSING')
})

/**
 * @constant {Number} CLOSING
 * @memberof WebSocket.prototype
 */
Object.defineProperty(WebSocket.prototype, 'CLOSING', {
	enumerable: true,
	value: readyStates.indexOf('CLOSING')
})

/**
 * @constant {Number} CLOSED
 * @memberof WebSocket
 */
Object.defineProperty(WebSocket, 'CLOSED', {
	enumerable: true,
	value: readyStates.indexOf('CLOSED')
})

/**
 * @constant {Number} CLOSED
 * @memberof WebSocket.prototype
 */
Object.defineProperty(WebSocket.prototype, 'CLOSED', {
	enumerable: true,
	value: readyStates.indexOf('CLOSED')
})

;[
	'binaryType',
	'bufferedAmount',
	'extensions',
	'isPaused',
	'protocol',
	'readyState',
	'url'
].forEach((property) => {
	Object.defineProperty(WebSocket.prototype, property, { enumerable: true })
})

//
// Add the `onopen`, `onerror`, `onclose`, and `onmessage` attributes.
// See https://html.spec.whatwg.org/multipage/comms.html#the-websocket-interface
//
;['open', 'error', 'close', 'message'].forEach((method) => {
	Object.defineProperty(WebSocket.prototype, `on${method}`, {
		enumerable: true,
		get() {
			for (const listener of this.listeners(method)) {
				if (listener[kForOnEventAttribute]) return listener[kListener]
			}

			return null
		},
		set(handler) {
			for (const listener of this.listeners(method)) {
				if (listener[kForOnEventAttribute]) {
					this.removeListener(method, listener)
					break
				}
			}

			if (typeof handler !== 'function') return

			this.addEventListener(method, handler, {
				[kForOnEventAttribute]: true
			})
		}
	})
})

WebSocket.prototype.addEventListener = addEventListener
WebSocket.prototype.removeEventListener = removeEventListener

export default WebSocket

/**
 * Initialize a WebSocket client.
 *
 * @param {WebSocket} websocket The client to initialize
 * @param {(String|URL)} address The URL to which to connect
 * @param {Array} protocols The subprotocols
 * @param {Object} [options] Connection options
 * @private
 */
function initAsClient(websocket, address, protocols, options) {
	const opts = {
		allowSynchronousEvents: true,
		autoPong: true,
		closeTimeout: CLOSE_TIMEOUT,
		protocolVersion: protocolVersions[1],
		maxPayload: 100 * 1024 * 1024,
		skipUTF8Validation: false,
		perMessageDeflate: false,
		handshakeTimeout: undefined,
		...options,
		host: undefined,
		path: undefined,
		port: undefined
	}

	// Force no permessage-deflate
	opts.perMessageDeflate = false

	websocket._autoPong = opts.autoPong
	websocket._closeTimeout = opts.closeTimeout

	if (!protocolVersions.includes(opts.protocolVersion)) {
		throw new RangeError(
			`Unsupported protocol version: ${opts.protocolVersion} ` +
				`(supported versions: ${protocolVersions.join(', ')})`
		)
	}

	let parsedUrl

	if (address instanceof URL) {
		parsedUrl = address
	} else {
		try {
			parsedUrl = new URL(address)
		} catch (e) {
			throw new SyntaxError(`Invalid URL: ${address}`)
		}
	}

	if (parsedUrl.protocol === 'http:') {
		parsedUrl.protocol = 'ws:'
	} else if (parsedUrl.protocol === 'https:') {
		parsedUrl.protocol = 'wss:'
	}

	websocket._url = parsedUrl.href

	const isSecure = parsedUrl.protocol === 'wss:'
	let invalidUrlMessage

	if (parsedUrl.protocol !== 'ws:' && !isSecure) {
		invalidUrlMessage =
			'The URL\'s protocol must be one of "ws:", "wss:", ' +
			'"http:", or "https:"'
	} else if (parsedUrl.hash) {
		invalidUrlMessage = 'The URL contains a fragment identifier'
	}

	if (isSecure) {
		invalidUrlMessage =
			'wss:// is not yet supported (requires TLSSocket implementation). Use ws:// instead.'
	}

	if (invalidUrlMessage) {
		const err = new SyntaxError(invalidUrlMessage)
		emitErrorAndClose(websocket, err)
		return
	}

	const defaultPort = isSecure ? 443 : 80
	const key = randomBytes(16).toString('base64')
	const protocolSet = new Set()

	opts.port = +parsedUrl.port || defaultPort
	opts.host = parsedUrl.hostname.startsWith('[')
		? parsedUrl.hostname.slice(1, -1)
		: parsedUrl.hostname
	opts.path = parsedUrl.pathname + parsedUrl.search

	opts.headers = {
		...opts.headers,
		'Sec-WebSocket-Version': opts.protocolVersion,
		'Sec-WebSocket-Key': key,
		Connection: 'Upgrade',
		Upgrade: 'websocket'
	}

	if (protocols.length) {
		for (const protocol of protocols) {
			if (
				typeof protocol !== 'string' ||
				!subprotocolRegex.test(protocol) ||
				protocolSet.has(protocol)
			) {
				throw new SyntaxError(
					'An invalid or duplicated subprotocol was specified'
				)
			}

			protocolSet.add(protocol)
		}

		opts.headers['Sec-WebSocket-Protocol'] = protocols.join(',')
	}
	if (opts.origin) {
		if (opts.protocolVersion < 13) {
			opts.headers['Sec-WebSocket-Origin'] = opts.origin
		} else {
			opts.headers.Origin = opts.origin
		}
	}

	// Connect using raw TCP (wss:// is rejected above)
	const socket = netConnect({ host: opts.host, port: opts.port })

	websocket._socket = socket

	function onConnectError(err) {
		if (socket[kWebSocket] === undefined) return

		socket[kWebSocket] = undefined
		emitErrorAndClose(websocket, err)
	}

	socket.on('error', onConnectError)

	const onConnect = () => {
		// Build and send the HTTP upgrade request
		let request = `GET ${opts.path} HTTP/1.1\r\n`
		if (!hasHeader(opts.headers, 'host'))
			request += `Host: ${opts.host}${+opts.port !== defaultPort ? ':' + opts.port : ''}\r\n`
		for (const [headerKey, value] of Object.entries(opts.headers)) {
			request += `${headerKey}: ${value}\r\n`
		}
		request += '\r\n'
		socket.write(request)

		// Wait for the upgrade response
		let buffer = Buffer.alloc(0)
		const onData = (chunk) => {
			buffer = Buffer.concat([buffer, chunk])
			const headerEnd = buffer.indexOf('\r\n\r\n')
			if (headerEnd === -1) return

			socket.removeListener('data', onData)

			const headerStr = buffer.slice(0, headerEnd).toString()
			const remaining = buffer.slice(headerEnd + 4)

			// Parse status line
			const statusLine = headerStr.split('\r\n')[0]
			const statusMatch = statusLine.match(/^HTTP\/1\.1 (\d+)/)
			if (!statusMatch) {
				abortHandshake(websocket, socket, 'Invalid HTTP response')
				return
			}

			const statusCode = parseInt(statusMatch[1])

			// Parse headers
			const responseHeaders = {}
			for (const line of headerStr.split('\r\n').slice(1)) {
				const colonIdx = line.indexOf(':')
				if (colonIdx === -1) continue
				const name = line.slice(0, colonIdx).trim().toLowerCase()
				const value = line.slice(colonIdx + 1).trim()
				responseHeaders[name] = value
			}

			if (statusCode !== 101) {
				if (!websocket.emit('unexpected-response', null, { statusCode, headers: responseHeaders })) {
					abortHandshake(websocket, socket, `Unexpected server response: ${statusCode}`)
				}
				return
			}

			// Verify upgrade headers
			const upgrade = responseHeaders['upgrade']
			if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
				abortHandshake(websocket, socket, 'Invalid Upgrade header')
				return
			}

			const digest = createHash('sha1').update(key + GUID).digest('base64')
			if (responseHeaders['sec-websocket-accept'] !== digest) {
				abortHandshake(websocket, socket, 'Invalid Sec-WebSocket-Accept header')
				return
			}

			// Handle subprotocol
			const serverProt = responseHeaders['sec-websocket-protocol']
			if (serverProt !== undefined) {
				if (!protocolSet.size) {
					abortHandshake(websocket, socket, 'Server sent a subprotocol but none was requested')
					return
				}
				if (!protocolSet.has(serverProt)) {
					abortHandshake(websocket, socket, 'Server sent an invalid subprotocol')
					return
				}
				websocket._protocol = serverProt
			} else if (protocolSet.size) {
				abortHandshake(websocket, socket, 'Server sent no subprotocol')
				return
			}

			// Server sent extensions but we don't support any
			const secWebSocketExtensions = responseHeaders['sec-websocket-extensions']
			if (secWebSocketExtensions !== undefined) {
				abortHandshake(
					websocket,
					socket,
					'Server sent a Sec-WebSocket-Extensions header but no extension was requested'
				)
				return
			}

			// Remove the connect-time error handler now that setSocket will
			// register its own (socketOnError). Leaving both causes the
			// connect handler to clear kWebSocket before socketOnClose
			// can read it, preventing close-timer cleanup.
			socket.removeListener('error', onConnectError)

			websocket.setSocket(socket, remaining, {
				allowSynchronousEvents: opts.allowSynchronousEvents,
				generateMask: opts.generateMask,
				maxPayload: opts.maxPayload,
				skipUTF8Validation: opts.skipUTF8Validation
			})
		}
		socket.on('data', onData)
	}

	if (isSecure) {
		socket.on('secureConnect', onConnect)
	} else {
		socket.on('connect', onConnect)
	}

	if (opts.handshakeTimeout) {
		const timer = setTimeout(() => {
			abortHandshake(websocket, socket, 'Opening handshake has timed out')
		}, opts.handshakeTimeout)
		websocket.once('open', () => clearTimeout(timer))
	}
}

function hasHeader(headers, name) {
	const lowerName = name.toLowerCase()
	return Object.keys(headers).some(key => key.toLowerCase() === lowerName)
}

/**
 * Emit the `'error'` and `'close'` events.
 *
 * @param {WebSocket} websocket The WebSocket instance
 * @param {Error} The error to emit
 * @private
 */
function emitErrorAndClose(websocket, err) {
	websocket._readyState = WebSocket.CLOSING
	//
	// The following assignment is practically useless and is done only for
	// consistency.
	//
	websocket._errorEmitted = true
	websocket.emit('error', err)
	websocket.emitClose()
}

/**
 * Abort the handshake and emit an error.
 *
 * @param {WebSocket} websocket The WebSocket instance
 * @param {*} stream The socket to destroy
 * @param {String} message The error message
 * @private
 */
function abortHandshake(websocket, stream, message) {
	websocket._readyState = WebSocket.CLOSING

	const err = new Error(message)
	Error.captureStackTrace(err, abortHandshake)

	if (stream) {
		stream.destroy(err)
		stream.once('error', websocket.emit.bind(websocket, 'error'))
		stream.once('close', websocket.emitClose.bind(websocket))
	} else {
		process.nextTick(emitErrorAndClose, websocket, err)
	}
}

/**
 * Handle cases where the `ping()`, `pong()`, or `send()` methods are called
 * when the `readyState` attribute is `CLOSING` or `CLOSED`.
 *
 * @param {WebSocket} websocket The WebSocket instance
 * @param {*} [data] The data to send
 * @param {Function} [cb] Callback
 * @private
 */
function sendAfterClose(websocket, data, cb) {
	if (data) {
		const length = isBlob(data) ? data.size : toBuffer(data).length

		//
		// The `_bufferedAmount` property is used only when the peer is a client and
		// the opening handshake fails. Under these circumstances, in fact, the
		// `setSocket()` method is not called, so the `_socket` and `_sender`
		// properties are set to `null`.
		//
		if (websocket._socket) websocket._sender._bufferedBytes += length
		else websocket._bufferedAmount += length
	}

	if (cb) {
		const err = new Error(
			`WebSocket is not open: readyState ${websocket.readyState} ` +
				`(${readyStates[websocket.readyState]})`
		)
		process.nextTick(cb, err)
	}
}

/**
 * The listener of the `Receiver` `'conclude'` event.
 *
 * @param {Number} code The status code
 * @param {Buffer} reason The reason for closing
 * @private
 */
function receiverOnConclude(code, reason) {
	const websocket = this[kWebSocket]

	websocket._closeFrameReceived = true
	websocket._closeMessage = reason
	websocket._closeCode = code

	if (websocket._socket[kWebSocket] === undefined) return

	websocket._socket.removeListener('data', socketOnData)
	process.nextTick(resume, websocket._socket)

	if (code === 1005) websocket.close()
	else websocket.close(code, reason)
}

/**
 * The listener of the `Receiver` `'drain'` event.
 *
 * @private
 */
function receiverOnDrain() {
	const websocket = this[kWebSocket]

	if (!websocket.isPaused) websocket._socket.resume()
}

/**
 * The listener of the `Receiver` `'error'` event.
 *
 * @param {(RangeError|Error)} err The emitted error
 * @private
 */
function receiverOnError(err) {
	const websocket = this[kWebSocket]

	if (websocket._socket[kWebSocket] !== undefined) {
		websocket._socket.removeListener('data', socketOnData)

		process.nextTick(resume, websocket._socket)

		websocket.close(err[kStatusCode])
	}

	if (!websocket._errorEmitted) {
		websocket._errorEmitted = true
		websocket.emit('error', err)
	}
}

/**
 * The listener of the `Receiver` `'finish'` event.
 *
 * @private
 */
function receiverOnFinish() {
	this[kWebSocket].emitClose()
}

/**
 * The listener of the `Receiver` `'message'` event.
 *
 * @param {Buffer|ArrayBuffer|Buffer[])} data The message
 * @param {Boolean} isBinary Specifies whether the message is binary or not
 * @private
 */
function receiverOnMessage(data, isBinary) {
	this[kWebSocket].emit('message', data, isBinary)
}

/**
 * The listener of the `Receiver` `'ping'` event.
 *
 * @param {Buffer} data The data included in the ping frame
 * @private
 */
function receiverOnPing(data) {
	const websocket = this[kWebSocket]

	if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP)
	websocket.emit('ping', data)
}

/**
 * The listener of the `Receiver` `'pong'` event.
 *
 * @param {Buffer} data The data included in the pong frame
 * @private
 */
function receiverOnPong(data) {
	this[kWebSocket].emit('pong', data)
}

/**
 * Resume a readable stream
 *
 * @param {*} stream The readable stream
 * @private
 */
function resume(stream) {
	stream.resume()
}

/**
 * The `Sender` error event handler.
 *
 * @param {Error} The error
 * @private
 */
function senderOnError(err) {
	const websocket = this[kWebSocket]

	if (websocket.readyState === WebSocket.CLOSED) return
	if (websocket.readyState === WebSocket.OPEN) {
		websocket._readyState = WebSocket.CLOSING
		setCloseTimer(websocket)
	}

	//
	// `socket.end()` is used instead of `socket.destroy()` to allow the other
	// peer to finish sending queued data. There is no need to set a timer here
	// because `CLOSING` means that it is already set or not needed.
	//
	this._socket.end()

	if (!websocket._errorEmitted) {
		websocket._errorEmitted = true
		websocket.emit('error', err)
	}
}

/**
 * Set a timer to destroy the underlying raw socket of a WebSocket.
 *
 * @param {WebSocket} websocket The WebSocket instance
 * @private
 */
function setCloseTimer(websocket) {
	websocket._closeTimer = setTimeout(
		websocket._socket.destroy.bind(websocket._socket),
		websocket._closeTimeout
	)
}

/**
 * The listener of the socket `'close'` event.
 *
 * @private
 */
function socketOnClose() {
	const websocket = this[kWebSocket]

	this.removeListener('close', socketOnClose)
	this.removeListener('data', socketOnData)
	this.removeListener('end', socketOnEnd)

	if (websocket === undefined) return

	websocket._readyState = WebSocket.CLOSING

	let remaining

	//
	// The close frame might not have been received or the `'end'` event emitted,
	// for example, if the socket was destroyed due to an error. Ensure that the
	// `receiver` stream is closed after writing any remaining buffered data to
	// it.
	//
	if (
		!websocket._closeFrameReceived &&
		!websocket._receiver._writableState.errorEmitted
	) {
		// Check if the socket has a read() method and readable state
		if (this._readableState && this._readableState.length !== 0) {
			remaining = this.read(this._readableState.length)
		}

		if (remaining) {
			websocket._receiver.write(remaining)
		}
	}

	websocket._receiver.end()

	this[kWebSocket] = undefined

	clearTimeout(websocket._closeTimer)

	if (
		websocket._receiver._writableState.finished ||
		websocket._receiver._writableState.errorEmitted
	) {
		websocket.emitClose()
	} else {
		websocket._receiver.on('error', receiverOnFinish)
		websocket._receiver.on('finish', receiverOnFinish)
	}
}

/**
 * The listener of the socket `'data'` event.
 *
 * @param {Buffer} chunk A chunk of data
 * @private
 */
function socketOnData(chunk) {
	if (!this[kWebSocket]._receiver.write(chunk)) {
		this.pause()
	}
}

/**
 * The listener of the socket `'end'` event.
 *
 * @private
 */
function socketOnEnd() {
	const websocket = this[kWebSocket]

	websocket._readyState = WebSocket.CLOSING
	websocket._receiver.end()
	this.end()
}

/**
 * The listener of the socket `'error'` event.
 *
 * @private
 */
function socketOnError() {
	const websocket = this[kWebSocket]

	this.removeListener('error', socketOnError)
	this.on('error', NOOP)

	if (websocket) {
		websocket._readyState = WebSocket.CLOSING
		this.destroy()
	}
}
