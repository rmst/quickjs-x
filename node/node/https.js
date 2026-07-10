/**
 * node:https - HTTP/1.1 over BearSSL TLS
 * @see https://nodejs.org/api/https.html
 *
 * This module intentionally reuses node:http's request/server machinery and
 * swaps only the underlying socket transport. Unsupported TLS options throw
 * instead of being silently ignored.
 */

import {
	ClientRequest, HTTPServer, IncomingMessage, ServerResponse,
	STATUS_CODES,
} from 'node:http'
import { connect as tlsConnect, createServer as createTLSServer } from 'node:tls'

const DEFAULT_PORT = 443

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
		'clientCertEngine', 'crl', 'dhparam', 'ecdhCurve', 'honorCipherOrder',
		'minVersion', 'maxVersion', 'secureProtocol', 'secureOptions', 'session',
		'sigalgs',
	])
}

export class Server extends HTTPServer {
	constructor(options, requestListener) {
		if (typeof options === 'function') {
			requestListener = options
			options = {}
		}
		const secureServer = createTLSServer(options || {})
		super({ ...(options || {}), _server: secureServer, _connectionEvent: 'secureConnection' }, requestListener)
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
	createConnection: tlsConnect,
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
