/**
 * qn:http - Modern HTTP server using Web standard Request/Response
 *
 * Similar to Deno.serve() / Bun.serve() — takes a (Request) => Response
 * handler instead of the Node.js (req, res) callback style.
 */

import { createServer as createTcpServer } from 'node:net'
import { Request } from 'node:fetch/Request'
import { handleHttpConnection, writeResponse } from 'node:http/parse'

const DEFAULT_HEADER_TIMEOUT = 60_000  // 60 seconds
const DEFAULT_KEEP_ALIVE_TIMEOUT = 5_000  // 5 seconds

/**
 * Start an HTTP server with a Web standard (Request) => Response handler.
 *
 * @param {Object|Function} optionsOrHandler - Options object or handler function
 * @param {Function} [handlerOrOptions] - Handler function or options object
 * @returns {Promise<HttpServer>}
 *
 * @example
 *   const server = await serve({ port: 8080 }, (req) => new Response("hello"))
 *   const server = await serve((req) => new Response("hello"), { port: 8080 })
 *   const server = await serve((req) => new Response("hello"))
 */
export function serve(optionsOrHandler, handlerOrOptions) {
	let handler, options
	if (typeof optionsOrHandler === 'function') {
		handler = optionsOrHandler
		options = handlerOrOptions || {}
	} else {
		options = optionsOrHandler || {}
		handler = handlerOrOptions
	}
	if (typeof handler !== 'function')
		throw new TypeError('serve: handler must be a function')

	const port = options.port ?? 0
	const hostname = options.hostname ?? '127.0.0.1'
	const onError = options.onError || null
	const headerTimeout = options.headerTimeout ?? DEFAULT_HEADER_TIMEOUT
	const keepAliveTimeout = options.keepAliveTimeout ?? DEFAULT_KEEP_ALIVE_TIMEOUT

	const tcpServer = createTcpServer()
	const activeSockets = new Set()

	tcpServer.on('connection', (socket) => {
		activeSockets.add(socket)
		socket.on('close', () => activeSockets.delete(socket))
		socket.on('error', () => {})
		handleHttpConnection(
			socket,
			{ headerTimeout, keepAliveTimeout },
			async ({ head, socket, keepAlive, bodyIter, signal }) => {
				const host = head.headers['host'] || 'localhost'
				const url = `http://${host}${head.url}`

				const request = new Request(url, {
					method: head.method,
					headers: head.headers,
					body: bodyIter,
					signal,
				})

				try {
					const response = await handler(request)

					const writeFn = (data) => new Promise((resolve, reject) => {
						if (socket.destroyed) { reject(new Error('socket closed')); return }
						const onClose = () => reject(new Error('socket closed'))
						socket.once('close', onClose)
						socket.write(data, (err) => {
							socket.off('close', onClose)
							err ? reject(err) : resolve()
						})
					})

					await writeResponse(writeFn, response, { keepAlive })
				} catch (err) {
					if (err?.name === 'AbortError' || err?.message === 'socket closed') throw err
					if (!socket.destroyed) {
						try {
							socket.write('HTTP/1.1 500 Internal Server Error\r\nconnection: close\r\ncontent-length: 21\r\n\r\nInternal Server Error')
						} catch {}
					}
					if (onError) onError(err)
					socket.end()
					return
				}
			},
		)
	})

	return new Promise((resolve, reject) => {
		tcpServer.on('error', reject)
		tcpServer.listen(port, hostname, undefined, () => {
			tcpServer.removeListener('error', reject)
			resolve(new HttpServer(tcpServer, activeSockets))
		})
	})
}

class HttpServer {
	#server
	#sockets

	constructor(server, sockets) {
		this.#server = server
		this.#sockets = sockets
	}

	address() {
		return this.#server.address()
	}

	close() {
		this.#server.close()
		for (const socket of this.#sockets) {
			socket.destroy()
		}
	}
}
