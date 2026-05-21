import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, testQnOnly, execAsync } from './util.js'

describe('node:http Server', () => {
	testQnOnly('http.get receives response over TCP', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'

			const server = http.createServer((req, res) => {
				res.writeHead(201, { 'Content-Type': 'text/plain', 'X-Path': req.url })
				res.end('hello client')
			})

			server.listen(0, '127.0.0.1', () => {
				const { port } = server.address()
				http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
					let body = ''
					res.on('data', (chunk) => { body += chunk })
					res.on('end', () => {
						console.log(res.statusCode)
						console.log(res.headers['x-path'])
						console.log(body)
						server.close()
					})
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const lines = output.split('\n')
			assert.equal(lines[0], '201')
			assert.equal(lines[1], '/events')
			assert.equal(lines[2], 'hello client')
		})
	})

	testQnOnly('http.request sends request body over TCP', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'

			const server = http.createServer((req, res) => {
				let body = ''
				req.on('data', (chunk) => { body += chunk })
				req.on('end', () => {
					res.end(req.method + ' ' + req.url + ' ' + body)
				})
			})

			server.listen(0, '127.0.0.1', () => {
				const { port } = server.address()
				const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/submit' }, (res) => {
					let body = ''
					res.on('data', (chunk) => { body += chunk })
					res.on('end', () => {
						console.log(body)
						server.close()
					})
				})
				req.end('payload')
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'POST /submit payload')
		})
	})

	testQnOnly('http client decodes chunked responses', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'

			const server = http.createServer((req, res) => {
				res.write('alpha')
				res.write('beta')
				res.end('gamma')
			})

			server.listen(0, '127.0.0.1', () => {
				const { port } = server.address()
				http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
					let body = ''
					res.on('data', (chunk) => { body += chunk })
					res.on('end', () => {
						console.log(body)
						server.close()
					})
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'alphabetagamma')
		})
	})

	testQnOnly('http.request supports socketPath', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { unlinkSync } from 'node:fs'

			const socketPath = ${JSON.stringify(`${dir}/http.sock`)}
			try { unlinkSync(socketPath) } catch {}

			const server = http.createServer((req, res) => {
				res.end('socket:' + req.url)
			})

			server.listen(socketPath, () => {
				http.get({ socketPath, path: '/status' }, (res) => {
					let body = ''
					res.on('data', (chunk) => { body += chunk })
					res.on('end', () => {
						console.log(body)
						server.close(() => {
							try { unlinkSync(socketPath) } catch {}
						})
					})
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'socket:/status')
		})
	})

	testQnOnly('basic GET request', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer((req, res) => {
				res.writeHead(200, { 'Content-Type': 'text/plain' })
				res.end('hello world')
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					client.write('GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
				})
				let data = ''
				client.on('data', (chunk) => {
					data += new TextDecoder().decode(chunk)
				})
				client.on('end', () => {
					console.log(data)
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.ok(output.includes('HTTP/1.1 200 OK'))
			assert.ok(output.includes('content-type: text/plain'))
			assert.ok(output.includes('hello world'))
		})
	})

	testQnOnly('request method and url', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer((req, res) => {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ method: req.method, url: req.url }))
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					client.write('POST /api/test?q=1 HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
				})
				let data = ''
				client.on('data', (chunk) => {
					data += new TextDecoder().decode(chunk)
				})
				client.on('end', () => {
					// Extract JSON body from HTTP response
					const body = data.split('\\r\\n\\r\\n').pop()
					console.log(body)
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const parsed = JSON.parse(output)
			assert.equal(parsed.method, 'POST')
			assert.equal(parsed.url, '/api/test?q=1')
		})
	})

	testQnOnly('request headers', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer((req, res) => {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({
					host: req.headers['host'],
					custom: req.headers['x-custom'],
				}))
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					client.write('GET / HTTP/1.1\\r\\nHost: example.com\\r\\nX-Custom: test-value\\r\\nConnection: close\\r\\n\\r\\n')
				})
				let data = ''
				client.on('data', (chunk) => {
					data += new TextDecoder().decode(chunk)
				})
				client.on('end', () => {
					const body = data.split('\\r\\n\\r\\n').pop()
					console.log(body)
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const parsed = JSON.parse(output)
			assert.equal(parsed.host, 'example.com')
			assert.equal(parsed.custom, 'test-value')
		})
	})

	testQnOnly('POST with body', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer((req, res) => {
				let body = ''
				req.on('data', (chunk) => {
					body += new TextDecoder().decode(chunk)
				})
				req.on('end', () => {
					res.writeHead(200, { 'Content-Type': 'text/plain' })
					res.end('received:' + body)
				})
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const bodyStr = 'hello body'
				const client = createConnection(addr.port, '127.0.0.1', () => {
					client.write(
						'POST /data HTTP/1.1\\r\\n' +
						'Host: localhost\\r\\n' +
						'Content-Length: ' + bodyStr.length + '\\r\\n' +
						'Connection: close\\r\\n' +
						'\\r\\n' +
						bodyStr
					)
				})
				let data = ''
				client.on('data', (chunk) => {
					data += new TextDecoder().decode(chunk)
				})
				client.on('end', () => {
					const body = data.split('\\r\\n\\r\\n').pop()
					console.log(body)
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'received:hello body')
		})
	})

	test('req.on(data) emits Buffer chunks (string coercion utf-8 decodes)', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { Buffer } from 'node:buffer'

			const server = http.createServer((req, res) => {
				let body = ''
				let firstChunkIsBuffer = null
				req.on('data', (chunk) => {
					if (firstChunkIsBuffer === null) firstChunkIsBuffer = Buffer.isBuffer(chunk)
					body += chunk // implicit string coercion should utf-8 decode
				})
				req.on('end', () => {
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify({ body, firstChunkIsBuffer }))
				})
			})

			server.listen(0, '127.0.0.1', async () => {
				const addr = server.address()
				const r = await fetch('http://127.0.0.1:' + addr.port + '/', {
					method: 'POST',
					body: '{"hello":"world"}',
				})
				console.log(await r.text())
				server.close()
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.deepStrictEqual(JSON.parse(output), {
				body: '{"hello":"world"}',
				firstChunkIsBuffer: true,
			})
		})
	})

	testQnOnly('response status codes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer((req, res) => {
				if (req.url === '/ok') {
					res.writeHead(200)
					res.end('ok')
				} else if (req.url === '/notfound') {
					res.writeHead(404)
					res.end('not found')
				} else if (req.url === '/error') {
					res.writeHead(500)
					res.end('error')
				}
			})

			server.listen(0, '127.0.0.1', async () => {
				const addr = server.address()

				const doReq = (path) => new Promise((resolve) => {
					const client = createConnection(addr.port, '127.0.0.1', () => {
						client.write('GET ' + path + ' HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
					})
					let data = ''
					client.on('data', (chunk) => { data += new TextDecoder().decode(chunk) })
					client.on('end', () => resolve(data))
				})

				const r1 = await doReq('/ok')
				const r2 = await doReq('/notfound')
				const r3 = await doReq('/error')

				console.log(r1.includes('200 OK') ? '200' : 'fail')
				console.log(r2.includes('404 Not Found') ? '404' : 'fail')
				console.log(r3.includes('500 Internal Server Error') ? '500' : 'fail')

				server.close()
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const lines = output.split('\n')
			assert.equal(lines[0], '200')
			assert.equal(lines[1], '404')
			assert.equal(lines[2], '500')
		})
	})

	testQnOnly('response setHeader/getHeader/removeHeader', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer((req, res) => {
				res.setHeader('X-Foo', 'bar')
				res.setHeader('X-Remove', 'gone')
				res.removeHeader('X-Remove')
				console.log('hasFoo:' + res.hasHeader('X-Foo'))
				console.log('getFoo:' + res.getHeader('X-Foo'))
				console.log('hasRemove:' + res.hasHeader('X-Remove'))
				res.writeHead(200)
				res.end('ok')
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					client.write('GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
				})
				let data = ''
				client.on('data', (chunk) => { data += new TextDecoder().decode(chunk) })
				client.on('end', () => {
					console.log('hasXFoo:' + data.includes('x-foo: bar'))
					console.log('hasXRemove:' + data.includes('x-remove'))
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const lines = output.split('\n')
			assert.equal(lines[0], 'hasFoo:true')
			assert.equal(lines[1], 'getFoo:bar')
			assert.equal(lines[2], 'hasRemove:false')
			assert.equal(lines[3], 'hasXFoo:true')
			assert.equal(lines[4], 'hasXRemove:false')
		})
	})

	testQnOnly('chunked transfer encoding with write()', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer((req, res) => {
				res.writeHead(200, { 'Content-Type': 'text/plain' })
				res.write('chunk1')
				res.write('chunk2')
				res.end('chunk3')
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					client.write('GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
				})
				let data = ''
				client.on('data', (chunk) => {
					data += new TextDecoder().decode(chunk)
				})
				client.on('end', () => {
					console.log('chunked:' + data.includes('transfer-encoding: chunked'))
					console.log('has1:' + data.includes('chunk1'))
					console.log('has2:' + data.includes('chunk2'))
					console.log('has3:' + data.includes('chunk3'))
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const lines = output.split('\n')
			assert.equal(lines[0], 'chunked:true')
			assert.equal(lines[1], 'has1:true')
			assert.equal(lines[2], 'has2:true')
			assert.equal(lines[3], 'has3:true')
		})
	})

	testQnOnly('server.close()', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'

			const server = http.createServer((req, res) => {
				res.end('ok')
			})

			server.listen(0, '127.0.0.1', () => {
				console.log('listening:' + server.listening)
				server.close(() => {
					console.log('closed')
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const lines = output.split('\n')
			assert.equal(lines[0], 'listening:true')
			assert.equal(lines[1], 'closed')
		})
	})

	testQnOnly('using fetch as client against qn http server', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'

			const server = http.createServer((req, res) => {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ msg: 'from qn server' }))
			})

			server.listen(0, '127.0.0.1', async () => {
				const addr = server.address()
				const res = await fetch('http://127.0.0.1:' + addr.port + '/test')
				const data = await res.json()
				console.log(JSON.stringify(data))
				server.close()
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const data = JSON.parse(output)
			assert.equal(data.msg, 'from qn server')
		})
	})

	testQnOnly('keep-alive: multiple requests on one connection', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			let count = 0
			const server = http.createServer((req, res) => {
				count++
				res.writeHead(200, { 'Content-Type': 'text/plain' })
				res.end('request ' + count)
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					// First request (keep-alive by default in HTTP/1.1)
					client.write('GET /a HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n')
				})
				let data = ''
				let gotFirst = false
				client.on('data', (chunk) => {
					data += new TextDecoder().decode(chunk)
					// After first response arrives, send second request with Connection: close
					if (!gotFirst && data.includes('request 1')) {
						gotFirst = true
						client.write('GET /b HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
					}
				})
				client.on('end', () => {
					const responses = data.split('HTTP/1.1').filter(Boolean)
					console.log('count:' + responses.length)
					console.log('has1:' + data.includes('request 1'))
					console.log('has2:' + data.includes('request 2'))
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const lines = output.split('\n')
			assert.equal(lines[0], 'count:2')
			assert.equal(lines[1], 'has1:true')
			assert.equal(lines[2], 'has2:true')
		})
	})

	testQnOnly('keep-alive: POST with body then GET on same connection', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer((req, res) => {
				if (req.method === 'POST') {
					let body = ''
					req.on('data', (c) => body += new TextDecoder().decode(c))
					req.on('end', () => {
						res.writeHead(200)
						res.end('post:' + body)
					})
				} else {
					res.writeHead(200)
					res.end('get')
				}
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const bodyStr = 'hello'
				const client = createConnection(addr.port, '127.0.0.1', () => {
					client.write(
						'POST /a HTTP/1.1\\r\\n' +
						'Host: localhost\\r\\n' +
						'Content-Length: ' + bodyStr.length + '\\r\\n' +
						'\\r\\n' +
						bodyStr
					)
				})
				let data = ''
				let sentSecond = false
				client.on('data', (chunk) => {
					data += new TextDecoder().decode(chunk)
					if (!sentSecond && data.includes('post:hello')) {
						sentSecond = true
						client.write('GET /b HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
					}
				})
				client.on('end', () => {
					console.log('hasPost:' + data.includes('post:hello'))
					console.log('hasGet:' + data.includes('get'))
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const lines = output.split('\n')
			assert.equal(lines[0], 'hasPost:true')
			assert.equal(lines[1], 'hasGet:true')
		})
	})

	testQnOnly('header timeout: slow client gets disconnected', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer((req, res) => {
				res.end('should not reach')
			})
			server.headerTimeout = 100  // 100ms

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					// Send partial headers, never finish
					client.write('GET / HTTP/1.1\\r\\nHost: ')
				})
				let ended = false
				client.on('end', () => { ended = true })
				client.on('close', () => {
					console.log('disconnected:' + ended)
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.ok(output.includes('disconnected:'))
		})
	})

	testQnOnly('keep-alive timeout: idle connection gets closed', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer((req, res) => {
				res.writeHead(200)
				res.end('ok')
			})
			server.keepAliveTimeout = 100  // 100ms

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					client.write('GET / HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n')
				})
				let data = ''
				client.on('data', (chunk) => {
					data += new TextDecoder().decode(chunk)
				})
				client.on('close', () => {
					// Connection should close after keepAliveTimeout since we didn't send another request
					console.log('hasOk:' + data.includes('ok'))
					console.log('closed')
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const lines = output.split('\n')
			assert.equal(lines[0], 'hasOk:true')
			assert.equal(lines[1], 'closed')
		})
	})

	testQnOnly('rejects Content-Length + Transfer-Encoding (smuggling prevention)', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer((req, res) => {
				res.end('should not reach')
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					client.write(
						'POST / HTTP/1.1\\r\\n' +
						'Host: localhost\\r\\n' +
						'Content-Length: 5\\r\\n' +
						'Transfer-Encoding: chunked\\r\\n' +
						'Connection: close\\r\\n' +
						'\\r\\n' +
						'hello'
					)
				})
				let data = ''
				client.on('data', (chunk) => {
					data += new TextDecoder().decode(chunk)
				})
				client.on('end', () => {
					console.log('status400:' + data.includes('400 Bad Request'))
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'status400:true')
		})
	})

	testQnOnly('rejects invalid Content-Length value', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer((req, res) => {
				res.end('should not reach')
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					client.write(
						'POST / HTTP/1.1\\r\\n' +
						'Host: localhost\\r\\n' +
						'Content-Length: -1\\r\\n' +
						'Connection: close\\r\\n' +
						'\\r\\n'
					)
				})
				let data = ''
				client.on('data', (chunk) => {
					data += new TextDecoder().decode(chunk)
				})
				client.on('end', () => {
					console.log('status400:' + data.includes('400 Bad Request'))
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'status400:true')
		})
	})

	testQnOnly('rejects too many headers', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'

			const server = http.createServer({ maxHeaderCount: 2 }, (req, res) => {
				res.end('should not reach')
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					client.write(
						'GET / HTTP/1.1\\r\\n' +
						'Host: localhost\\r\\n' +
						'X-A: 1\\r\\n' +
						'X-B: 2\\r\\n' +
						'Connection: close\\r\\n' +
						'\\r\\n'
					)
				})
				let data = ''
				client.on('data', (chunk) => {
					data += new TextDecoder().decode(chunk)
				})
				client.on('end', () => {
					console.log('status431:' + data.includes('431'))
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'status431:true')
		})
	})
})
