import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { testQnOnly, $, execAsync } from './util.js'

describe('qn:http serve()', () => {
	testQnOnly('basic GET returns text', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, (req) => new Response("hello"))
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
			const text = await res.text()
			server.close()
			console.log(JSON.stringify({ status: res.status, text }))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { status: 200, text: "hello" })
	})

	testQnOnly('handler receives method, url, headers', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, (req) => {
				const url = new URL(req.url)
				return new Response(JSON.stringify({
					method: req.method,
					path: url.pathname,
					search: url.search,
					xTest: req.headers.get('x-test'),
				}), { headers: { 'content-type': 'application/json' } })
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/hello?a=1\`, {
				headers: { 'X-Test': 'test-value' },
			})
			const data = await res.json()
			server.close()
			console.log(JSON.stringify(data))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const data = JSON.parse(output)
		assert.strictEqual(data.method, "GET")
		assert.strictEqual(data.path, "/hello")
		assert.strictEqual(data.search, "?a=1")
		assert.strictEqual(data.xTest, "test-value")
	})

	testQnOnly('POST with body', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, async (req) => {
				const body = await req.text()
				return new Response("echo:" + body)
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/echo\`, {
				method: "POST",
				body: "hello world",
			})
			const text = await res.text()
			server.close()
			console.log(JSON.stringify({ status: res.status, text }))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { status: 200, text: "echo:hello world" })
	})

	testQnOnly('custom status code and headers', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, (req) => {
				return new Response("not found", {
					status: 404,
					headers: { 'x-custom': 'value' },
				})
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/missing\`)
			const text = await res.text()
			server.close()
			console.log(JSON.stringify({
				status: res.status,
				text,
				xCustom: res.headers.get('x-custom'),
			}))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 404)
		assert.strictEqual(result.text, "not found")
		assert.strictEqual(result.xCustom, "value")
	})

	testQnOnly('JSON response', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, (req) => {
				return Response.json({ message: "hello", num: 42 })
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
			const data = await res.json()
			server.close()
			console.log(JSON.stringify(data))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { message: "hello", num: 42 })
	})

	testQnOnly('multiple sequential requests', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			let count = 0
			const server = await serve({ port: 0 }, (req) => {
				count++
				return new Response("request " + count)
			})
			const addr = server.address()
			const results = []
			for (let i = 0; i < 3; i++) {
				const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
				results.push(await res.text())
			}
			server.close()
			console.log(JSON.stringify(results))
		`)
		const output = $({ timeout: 10000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), ["request 1", "request 2", "request 3"])
	})

	testQnOnly('handler(req) and serve(handler) argument order', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve((req) => new Response("alt order"), { port: 0 })
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
			const text = await res.text()
			server.close()
			console.log(JSON.stringify({ text }))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { text: "alt order" })
	})

	testQnOnly('streaming response body', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, (req) => {
				async function* chunks() {
					yield new TextEncoder().encode("chunk1,")
					yield new TextEncoder().encode("chunk2,")
					yield new TextEncoder().encode("chunk3")
				}
				return new Response(chunks(), {
					headers: { 'content-type': 'text/plain' },
				})
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
			const text = await res.text()
			server.close()
			console.log(JSON.stringify({ text }))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { text: "chunk1,chunk2,chunk3" })
	})

	testQnOnly('large POST body', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, async (req) => {
				const body = await req.arrayBuffer()
				const bytes = new Uint8Array(body)
				let sum = 0
				for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) >>> 0
				return Response.json({ length: bytes.length, checksum: sum })
			})
			const addr = server.address()
			const data = new Uint8Array(64 * 1024)
			for (let i = 0; i < data.length; i++) data[i] = i & 0xff
			let expected = 0
			for (let i = 0; i < data.length; i++) expected = (expected + data[i]) >>> 0
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`, {
				method: "POST",
				body: data,
			})
			const result = await res.json()
			server.close()
			console.log(JSON.stringify({ ...result, expected }))
		`)
		const output = $({ timeout: 10000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.length, 64 * 1024)
		assert.strictEqual(result.checksum, result.expected)
	})

	testQnOnly('handler error returns 500 to client', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const errors = []
			const server = await serve({
				port: 0,
				onError: (err) => errors.push(err.message),
			}, (req) => {
				throw new Error('handler boom')
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
			console.log(JSON.stringify({
				status: res.status,
				body: await res.text(),
				errorCaught: errors[0],
			}))
			server.close()
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 500)
		assert.strictEqual(result.body, 'Internal Server Error')
		assert.strictEqual(result.errorCaught, 'handler boom')
	})

	testQnOnly('handler async error returns 500 to client', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const errors = []
			const server = await serve({
				port: 0,
				onError: (err) => errors.push(err.message),
			}, async (req) => {
				await new Promise(r => setTimeout(r, 10))
				throw new Error('async boom')
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
			console.log(JSON.stringify({
				status: res.status,
				body: await res.text(),
				errorCaught: errors[0],
			}))
			server.close()
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 500)
		assert.strictEqual(result.body, 'Internal Server Error')
		assert.strictEqual(result.errorCaught, 'async boom')
	})

	testQnOnly('request has abort signal', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, (req) => {
				return Response.json({
					hasSignal: req.signal !== undefined,
					aborted: req.signal.aborted,
				})
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
			const data = await res.json()
			server.close()
			console.log(JSON.stringify(data))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const data = JSON.parse(output)
		assert.strictEqual(data.hasSignal, true)
		assert.strictEqual(data.aborted, false)
	})

	testQnOnly('keep-alive: multiple requests on one connection', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			import { createConnection } from 'node:net'

			let count = 0
			const server = await serve({ port: 0 }, (req) => {
				count++
				return new Response("request " + count)
			})
			const addr = server.address()
			const client = createConnection(addr.port, '127.0.0.1', () => {
				client.write('GET /a HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n')
			})
			let data = ''
			let gotFirst = false
			client.on('data', (chunk) => {
				data += new TextDecoder().decode(chunk)
				if (!gotFirst && data.includes('request 1')) {
					gotFirst = true
					client.write('GET /b HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
				}
			})
			client.on('end', () => {
				const responses = data.split('HTTP/1.1').filter(Boolean)
				console.log(JSON.stringify({
					count: responses.length,
					has1: data.includes('request 1'),
					has2: data.includes('request 2'),
					keepAlive: data.includes('connection: keep-alive'),
				}))
				server.close()
			})
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.count, 2)
		assert.strictEqual(result.has1, true)
		assert.strictEqual(result.has2, true)
		assert.strictEqual(result.keepAlive, true)
	})

	testQnOnly('keep-alive: POST with body then GET on same connection', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			import { createConnection } from 'node:net'

			const server = await serve({ port: 0 }, async (req) => {
				if (req.method === 'POST') {
					const body = await req.text()
					return new Response("post:" + body)
				}
				return new Response("get")
			})
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
				console.log(JSON.stringify({
					hasPost: data.includes('post:hello'),
					hasGet: data.includes('get'),
				}))
				server.close()
			})
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.hasPost, true)
		assert.strictEqual(result.hasGet, true)
	})

	testQnOnly('keep-alive: unconsumed POST body is drained', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			import { createConnection } from 'node:net'

			let count = 0
			const server = await serve({ port: 0 }, (req) => {
				count++
				// Intentionally do NOT read the POST body
				return new Response("ok:" + count)
			})
			const addr = server.address()
			const bodyStr = 'ignored body'
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
				if (!sentSecond && data.includes('ok:1')) {
					sentSecond = true
					client.write('GET /b HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
				}
			})
			client.on('end', () => {
				console.log(JSON.stringify({
					has1: data.includes('ok:1'),
					has2: data.includes('ok:2'),
				}))
				server.close()
			})
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.has1, true)
		assert.strictEqual(result.has2, true)
	})

	testQnOnly('proxied streaming response is cancelled when downstream disconnects', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			import { createConnection } from 'node:net'

			const sleep = ms => new Promise(r => setTimeout(r, ms))
			let cancelled = 0

			function slowBody() {
				let i = 0
				return {
					[Symbol.asyncIterator]() {
						return {
							async next() {
								await sleep(10)
								if (i++ >= 1000) return { done: true }
								return { value: new Uint8Array(64 * 1024), done: false }
							},
							async return() {
								cancelled++
								return { done: true }
							},
						}
					},
				}
			}

			const remote = await serve({ port: 0, hostname: '127.0.0.1' }, (req) => {
				const url = new URL(req.url)
				if (url.pathname === '/cancelled') return Response.json({ cancelled })
				return new Response(slowBody(), {
					headers: { 'content-length': String(64 * 1024 * 1000) },
				})
			})
			const remotePort = remote.address().port

			const main = await serve({ port: 0, hostname: '127.0.0.1' }, async () => {
				const res = await fetch('http://127.0.0.1:' + remotePort + '/stream')
				return new Response(res.body, {
					status: res.status,
					headers: res.headers,
				})
			})
			const mainPort = main.address().port

			await new Promise((resolve, reject) => {
				const client = createConnection(mainPort, '127.0.0.1')
				let gotHeaders = false
				const timeout = setTimeout(() => {
					client.destroy()
					reject(new Error('timed out waiting for response headers'))
				}, 2000)
				client.on('connect', () => {
					client.write('GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
				})
				client.on('data', (chunk) => {
					if (!gotHeaders && chunk.toString().includes('\\r\\n\\r\\n')) {
						gotHeaders = true
						clearTimeout(timeout)
						client.destroy()
						resolve()
					}
				})
				client.on('error', reject)
			})

			let result = null
			for (let i = 0; i < 50; i++) {
				await sleep(20)
				result = await fetch('http://127.0.0.1:' + remotePort + '/cancelled').then(r => r.json())
				if (result.cancelled > 0) break
			}

			main.close()
			remote.close()
			console.log(JSON.stringify(result))
		`)
		const output = $({ timeout: 10000 })`${bin} ${dir}/test.js`
		assert.ok(JSON.parse(output).cancelled > 0)
	})

	testQnOnly('downstream disconnect during no-body response does not throw cleanup error', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			import { createConnection } from 'node:net'

			let errors = []
			const server = await serve({
				port: 0,
				hostname: '127.0.0.1',
				onError: (err) => errors.push(err?.message || String(err)),
			}, () => new Response(null, { status: 204 }))
			const port = server.address().port

			await new Promise((resolve, reject) => {
				const client = createConnection(port, '127.0.0.1')
				client.on('connect', () => {
					client.write('GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
					client.destroy()
					resolve()
				})
				client.on('error', reject)
			})

			await new Promise(r => setTimeout(r, 50))
			server.close()
			console.log(JSON.stringify({ errors }))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { errors: [] })
	})

	testQnOnly('connection: close respected on first request', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			import { createConnection } from 'node:net'

			const server = await serve({ port: 0 }, (req) => {
				return new Response("hello")
			})
			const addr = server.address()
			const client = createConnection(addr.port, '127.0.0.1', () => {
				client.write('GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
			})
			let data = ''
			client.on('data', (chunk) => {
				data += new TextDecoder().decode(chunk)
			})
			client.on('end', () => {
				console.log(JSON.stringify({
					hasClose: data.includes('connection: close'),
					hasHello: data.includes('hello'),
				}))
				server.close()
			})
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.hasClose, true)
		assert.strictEqual(result.hasHello, true)
	})

	// Regression: a user-supplied Connection header used to be appended to the
	// hardcoded "Connection: close" from buildRequest, producing duplicate
	// headers on the wire ("Connection: close" twice). Receivers that
	// concatenate duplicates into "close, close" then failed strict-equality
	// keep-alive detection. buildRequest now drops user-supplied Connection.
	testQnOnly('fetch drops user-supplied Connection header (no duplicate on wire)', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as net from 'node:net'
			const srv = net.createServer((sock) => {
				let buf = ''
				sock.on('data', c => {
					buf += new TextDecoder().decode(c)
					if (buf.includes('\\r\\n\\r\\n')) {
						sock.write('HTTP/1.1 200 OK\\r\\ncontent-length: 2\\r\\nconnection: close\\r\\n\\r\\nok')
						sock.end()
					}
				})
				sock.on('end', () => {
					const lines = buf.split('\\r\\n')
					const connHeaders = lines.filter(l => /^connection:/i.test(l))
					console.log(JSON.stringify({ connHeaderCount: connHeaders.length, headers: connHeaders }))
				})
			})
			await new Promise(r => srv.listen(0, '127.0.0.1', r))
			const port = srv.address().port
			await fetch('http://127.0.0.1:' + port + '/', {
				method: 'POST',
				headers: { 'content-type': 'text/plain', 'connection': 'close' },
				body: 'x',
			}).then(r => r.text())
			await new Promise(r => setTimeout(r, 100))
			srv.close()
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output.trim())
		assert.strictEqual(result.connHeaderCount, 1, `Expected exactly one Connection header, got: ${JSON.stringify(result.headers)}`)
	})

	// Regression: Connection is a comma-separated list (RFC 7230 §6.1).
	// detectKeepAlive used to do `conn === 'close'` which failed when the
	// header contained a list like "close, close" (two duplicate values
	// from a buggy proxy), silently flipping the server into keep-alive
	// mode.
	testQnOnly('Connection header parses as token list, not strict string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			import * as net from 'node:net'
			let secondReqArrived = false
			const srv = await serve({ port: 0, keepAliveTimeout: 500 }, () => {
				if (secondReqArrived) return new Response('second')
				secondReqArrived = true
				return new Response('first')
			})
			const port = srv.address().port

			// Send a single request with a comma-list "close, close" Connection header,
			// then check whether the server closes (correct) or keeps the socket open
			// waiting for a second request (the bug — strict 'close' equality failed).
			const sock = net.connect(port, '127.0.0.1')
			await new Promise(r => sock.once('connect', r))
			sock.write('POST / HTTP/1.1\\r\\nHost: x\\r\\nConnection: close, close\\r\\nContent-Length: 1\\r\\n\\r\\nx')
			let buf = ''
			sock.on('data', c => buf += new TextDecoder().decode(c))
			const closed = await new Promise(r => {
				sock.on('end', () => r(true))
				setTimeout(() => r(false), 1000)
			})
			sock.destroy()
			srv.close()
			console.log(JSON.stringify({ closed, gotResponse: buf.includes('first') }))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output.trim())
		assert.strictEqual(result.gotResponse, true)
		assert.strictEqual(result.closed, true, 'server should close the connection when Connection: "close, close" is received')
	})

	testQnOnly('error after first request does not crash server', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			let callCount = 0
			const server = await serve({ port: 0, onError: () => {} }, (req) => {
				callCount++
				if (callCount === 1) throw new Error('first fails')
				return new Response('ok:' + callCount)
			})
			const addr = server.address()
			const base = \`http://127.0.0.1:\${addr.port}\`

			// First request: should get 500
			const r1 = await fetch(base + '/a')
			const t1 = await r1.text()

			// Second request: should succeed (server still alive)
			const r2 = await fetch(base + '/b')
			const t2 = await r2.text()

			server.close()
			console.log(JSON.stringify({ s1: r1.status, t1, s2: r2.status, t2 }))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.s1, 500)
		assert.strictEqual(result.t1, 'Internal Server Error')
		assert.strictEqual(result.s2, 200)
		assert.strictEqual(result.t2, 'ok:2')
	})
})
