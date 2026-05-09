import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test, testQnOnly, $, execAsync, QN, mktempdir } from './util.js'

// HTTP server code (ESM, runs under qn)
const SERVER_CODE = `
import { createServer } from 'node:http'
const server = createServer((req, res) => {
	res.setHeader('Connection', 'close')
	const url = new URL(req.url, 'http://localhost')
	let body = ''
	req.on('data', chunk => body += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
	req.on('end', () => {
		if (url.pathname === '/get') {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({
				args: Object.fromEntries(url.searchParams),
				headers: req.headers,
				url: req.url
			}))
		} else if (url.pathname === '/post' && req.method === 'POST') {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			let json = null
			try { json = JSON.parse(body) } catch {}
			res.end(JSON.stringify({ data: body, json, headers: req.headers }))
		} else if (url.pathname === '/put' && req.method === 'PUT') {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ data: body, headers: req.headers }))
		} else if (url.pathname === '/delete' && req.method === 'DELETE') {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ deleted: true }))
		} else if (url.pathname === '/headers') {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ headers: req.headers }))
		} else if (url.pathname === '/status/404') {
			res.writeHead(404, { 'Content-Type': 'text/plain' })
			res.end('Not Found')
		} else if (url.pathname === '/status/500') {
			res.writeHead(500, { 'Content-Type': 'text/plain' })
			res.end('Internal Server Error')
		} else if (url.pathname === '/redirect') {
			res.writeHead(302, { 'Location': '/get' })
			res.end()
		} else if (url.pathname === '/redirect-chain') {
			res.writeHead(302, { 'Location': '/redirect' })
			res.end()
		} else if (url.pathname === '/text') {
			res.writeHead(200, { 'Content-Type': 'text/plain' })
			res.end('Hello, World!')
		} else if (url.pathname === '/echo-method') {
			res.writeHead(200, { 'Content-Type': 'text/plain' })
			res.end(req.method)
		} else if (url.pathname === '/delay') {
			setTimeout(() => {
				res.writeHead(200, { 'Content-Type': 'text/plain' })
				res.end('delayed')
			}, 2000)
		} else {
			res.writeHead(404)
			res.end('Not Found')
		}
	})
})
server.listen(0, '127.0.0.1', () => {
	console.log(server.address().port)
})
`

/**
 * Start a test HTTP server as a qn subprocess
 * @returns {Promise<{port: number, close: () => void}>}
 */
function startServer() {
	const serverDir = mktempdir()
	const serverFile = join(serverDir, 'server.js')
	writeFileSync(serverFile, SERVER_CODE)
	return new Promise((resolve, reject) => {
		const child = spawn(QN(), [serverFile], {
			stdio: ['ignore', 'pipe', 'inherit']
		})

		const cleanup = () => {
			child.kill()
			try { rmSync(serverDir, { recursive: true }) } catch {}
		}

		let output = ''
		child.stdout.on('data', (data) => {
			output += data.toString()
			const port = parseInt(output.trim(), 10)
			if (!isNaN(port)) {
				// Give server a moment to be fully ready
				setTimeout(() => {
					resolve({
						port,
						close: cleanup
					})
				}, 50)
			}
		})

		child.on('error', reject)
		child.on('exit', (code) => {
			if (code !== null && code !== 0) {
				reject(new Error(`Server process exited with code ${code}`))
			}
		})
	})
}

describe('fetch()', () => {
	test('GET request returns response', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/get')
				console.log(JSON.stringify({
					ok: res.ok,
					status: res.status,
					type: typeof res.headers
				}))
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			const result = JSON.parse(output)
			assert.strictEqual(result.ok, true)
			assert.strictEqual(result.status, 200)
			assert.strictEqual(result.type, 'object')
		} finally {
			close()
		}
	})

	test('response.json() parses JSON body', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/get?foo=bar')
				const data = await res.json()
				console.log(data.args.foo)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			assert.strictEqual(output, 'bar')
		} finally {
			close()
		}
	})

	test('response.text() returns string body', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/text')
				const text = await res.text()
				console.log(text)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			assert.strictEqual(output, 'Hello, World!')
		} finally {
			close()
		}
	})

	test('POST with JSON body', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/post', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ hello: 'world' })
				})
				const data = await res.json()
				console.log(JSON.stringify(data.json))
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			assert.deepStrictEqual(JSON.parse(output), { hello: 'world' })
		} finally {
			close()
		}
	})

	test('POST with URLSearchParams body', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/post', {
					method: 'POST',
					body: new URLSearchParams({ grant_type: 'authorization_code', code: 'abc' }),
				})
				const data = await res.json()
				console.log(JSON.stringify({
					body: data.data,
					contentType: data.headers['content-type'],
					contentLength: data.headers['content-length'],
				}))
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			const result = JSON.parse(output)
			assert.strictEqual(result.body, 'grant_type=authorization_code&code=abc')
			assert.match(result.contentType, /^application\/x-www-form-urlencoded/)
			assert.strictEqual(result.contentLength, String(result.body.length))
		} finally {
			close()
		}
	})

	test('custom headers are sent', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/headers', {
					headers: { 'X-Custom-Header': 'test-value' }
				})
				const data = await res.json()
				console.log(data.headers['x-custom-header'])
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			assert.strictEqual(output, 'test-value')
		} finally {
			close()
		}
	})

	test('PUT request works', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/put', {
					method: 'PUT',
					body: 'test data'
				})
				const data = await res.json()
				console.log(data.data)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			assert.strictEqual(output, 'test data')
		} finally {
			close()
		}
	})

	test('DELETE request works', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/delete', {
					method: 'DELETE'
				})
				console.log(res.status)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			assert.strictEqual(output, '200')
		} finally {
			close()
		}
	})

	test('404 returns ok=false', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/status/404')
				console.log(JSON.stringify({ ok: res.ok, status: res.status }))
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			const result = JSON.parse(output)
			assert.strictEqual(result.ok, false)
			assert.strictEqual(result.status, 404)
		} finally {
			close()
		}
	})

	test('follows redirects by default', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/redirect')
				console.log(res.status)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			assert.strictEqual(output, '200')
		} finally {
			close()
		}
	})

	test('follows redirect chains', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/redirect-chain')
				console.log(JSON.stringify({ status: res.status, redirected: res.redirected }))
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			const result = JSON.parse(output)
			assert.strictEqual(result.status, 200)
			assert.strictEqual(result.redirected, true)
		} finally {
			close()
		}
	})

	test('redirect: manual returns redirect status', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/redirect', { redirect: 'manual' })
				console.log(JSON.stringify({
					status: res.status,
					hasLocation: res.headers.has('location')
				}))
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			const result = JSON.parse(output)
			assert.strictEqual(result.status, 302)
			assert.strictEqual(result.hasLocation, true)
		} finally {
			close()
		}
	})

	test('invalid URL throws TypeError', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				await fetch('not-a-url')
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'TypeError')
	})

	test('URL object accepted as input', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const url = new URL('http://127.0.0.1:${port}/get')
				const res = await fetch(url)
				console.log(res.ok)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			assert.strictEqual(output, 'true')
		} finally {
			close()
		}
	})

	test('AbortController aborts fetch', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const controller = new AbortController()
				setTimeout(() => controller.abort(), 50)
				try {
					await fetch('http://127.0.0.1:${port}/delay', { signal: controller.signal })
					console.log('no error')
				} catch (e) {
					console.log(e.name)
				}
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			assert.strictEqual(output, 'AbortError')
		} finally {
			close()
		}
	})
})

describe('Headers', () => {
	test('case-insensitive get', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const h = new Headers()
			h.set('Content-Type', 'application/json')
			console.log(h.get('content-type'))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'application/json')
	})

	test('append combines values', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const h = new Headers()
			h.append('Accept', 'text/html')
			h.append('Accept', 'application/json')
			console.log(h.get('accept'))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'text/html, application/json')
	})

	test('constructor accepts object', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const h = new Headers({ 'X-Foo': 'bar', 'X-Baz': 'qux' })
			console.log(h.get('x-foo') + ',' + h.get('x-baz'))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'bar,qux')
	})

	test('constructor accepts array of tuples', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const h = new Headers([['X-Foo', 'bar'], ['X-Baz', 'qux']])
			console.log(h.get('x-foo') + ',' + h.get('x-baz'))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'bar,qux')
	})

	test('has() checks existence', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const h = new Headers({ 'X-Foo': 'bar' })
			console.log(h.has('x-foo') + ',' + h.has('x-missing'))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'true,false')
	})

	test('delete() removes header', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const h = new Headers({ 'X-Foo': 'bar' })
			h.delete('x-foo')
			console.log(h.has('x-foo'))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'false')
	})

	test('iterable', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const h = new Headers({ 'X-Foo': 'bar' })
			const entries = [...h]
			console.log(JSON.stringify(entries))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), [['x-foo', 'bar']])
	})
})

describe('fetch body cleanup', () => {
	test('body.getReader().cancel() closes the connection', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/get?foo=bar')
				const reader = res.body.getReader()
				await reader.cancel()
				console.log('ok')
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			assert.strictEqual(output, 'ok')
		} finally {
			close()
		}
	})

	test('body.cancel() closes the connection', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('http://127.0.0.1:${port}/get?foo=bar')
				await res.body.cancel()
				console.log('ok')
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			assert.strictEqual(output, 'ok')
		} finally {
			close()
		}
	})

	testQnOnly('connection pooling reuses TCP connections', async ({ bin, dir }) => {
		// Use a keep-alive server that counts unique connections
		writeFileSync(`${dir}/test.js`, `
			import { createServer } from 'node:http'
			let connCount = 0
			const server = createServer((req, res) => {
				res.writeHead(200, { 'Content-Type': 'text/plain' })
				res.end('ok')
			})
			server.on('connection', () => { connCount++ })
			server.listen(0, '127.0.0.1', async () => {
				const port = server.address().port
				const N = 10
				for (let i = 0; i < N; i++) {
					const res = await fetch('http://127.0.0.1:' + port + '/get?i=' + i)
					await res.text()
				}
				// With connection pooling, all requests should reuse 1 connection
				console.log(connCount <= 2 ? 'ok' : 'connections:' + connCount)
				server.close()
			})
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		assert.strictEqual(output, 'ok')
	})

	testQnOnly('unconsumed responses do not leak sockets', async ({ bin, dir }) => {
		const { port, close } = await startServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				import { readdirSync } from 'node:fs'
				const countFds = () => {
					try { return readdirSync('/proc/self/fd').length }
					catch { return -1 }
				}
				const before = countFds()
				for (let i = 0; i < 50; i++) {
					const res = await fetch('http://127.0.0.1:${port}/get?i=' + i)
					// intentionally don't consume body
				}
				const after = countFds()
				// With background body draining, sockets are closed as soon as
				// the HTTP message is fully received — no fds should leak.
				const leaked = after - before
				console.log(leaked <= 10 ? 'ok' : 'leaked:' + leaked)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`])
			assert.strictEqual(output, 'ok')
		} finally {
			close()
		}
	})
})

describe('Response', () => {
	test('Response.json() creates JSON response', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const r = Response.json({ foo: 'bar' })
			console.log(JSON.stringify({
				status: r.status,
				contentType: r.headers.get('content-type'),
				body: await r.json()
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 200)
		assert.strictEqual(result.contentType, 'application/json')
		assert.deepStrictEqual(result.body, { foo: 'bar' })
	})

	test('Response.redirect() creates redirect', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const r = Response.redirect('https://example.com', 301)
			console.log(JSON.stringify({
				status: r.status,
				hasLocation: r.headers.get('location').includes('example.com')
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 301)
		assert.strictEqual(result.hasLocation, true)
	})

	test('clone() creates independent copy', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const r1 = Response.json({ test: true })
			const r2 = r1.clone()
			const body1 = await r1.json()
			const body2 = await r2.json()
			console.log(JSON.stringify({ same: JSON.stringify(body1) === JSON.stringify(body2) }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { same: true })
	})

	test('bodyUsed tracks consumption', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const r = Response.json({ test: true })
			const before = r.bodyUsed
			await r.text()
			const after = r.bodyUsed
			console.log(before + ',' + after)
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'false,true')
	})

	test('cannot consume body twice', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const r = Response.json({ test: true })
			await r.text()
			try {
				await r.text()
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'TypeError')
	})

	test('ok property reflects status', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const r200 = new Response(null, { status: 200 })
			const r404 = new Response(null, { status: 404 })
			console.log(r200.ok + ',' + r404.ok)
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'true,false')
	})
})

describe('fetch no-body responses', () => {
	// Per RFC 7230 §3.3.3, responses to HEAD plus 1xx/204/304 statuses
	// have no body. fetch() must not wait for body framing on these,
	// otherwise it stalls until the server's keep-alive timeout fires.
	testQnOnly('304 over qn:http keep-alive completes immediately', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, () =>
				new Response(null, { status: 304, headers: { ETag: '"x"' } }))
			const port = server.address().port
			const start = Date.now()
			const res = await fetch('http://127.0.0.1:' + port + '/')
			const text = await res.text()
			const elapsed = Date.now() - start
			console.log(JSON.stringify({
				status: res.status,
				etag: res.headers.get('etag'),
				body: text,
				fast: elapsed < 1000,
			}))
			server.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 304)
		assert.strictEqual(result.etag, '"x"')
		assert.strictEqual(result.body, '')
		assert.strictEqual(result.fast, true)
	})

	testQnOnly('204 over qn:http keep-alive completes immediately', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, () =>
				new Response(null, { status: 204 }))
			const port = server.address().port
			const start = Date.now()
			const res = await fetch('http://127.0.0.1:' + port + '/')
			const text = await res.text()
			const elapsed = Date.now() - start
			console.log(JSON.stringify({ status: res.status, body: text, fast: elapsed < 1000 }))
			server.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 204)
		assert.strictEqual(result.body, '')
		assert.strictEqual(result.fast, true)
	})

	testQnOnly('HEAD over qn:http keep-alive completes immediately', async ({ bin, dir }) => {
		// Server returns a body for GET, but HEAD must not wait for body bytes.
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, () =>
				new Response('hello world'))
			const port = server.address().port
			const start = Date.now()
			const res = await fetch('http://127.0.0.1:' + port + '/', { method: 'HEAD' })
			const text = await res.text()
			const elapsed = Date.now() - start
			console.log(JSON.stringify({ status: res.status, body: text, fast: elapsed < 1000 }))
			server.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 200)
		assert.strictEqual(result.body, '')
		assert.strictEqual(result.fast, true)
	})

	testQnOnly('5 sequential 304s complete fast (connection is reusable)', async ({ bin, dir }) => {
		// Without pooling + early no-body completion, each 304 would stall ~5s
		// (qn:http default keep-alive timeout) before fetch resolves.
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, () =>
				new Response(null, { status: 304 }))
			const port = server.address().port
			const start = Date.now()
			for (let i = 0; i < 5; i++) {
				const res = await fetch('http://127.0.0.1:' + port + '/?i=' + i)
				await res.text()
			}
			const elapsed = Date.now() - start
			console.log(JSON.stringify({ fast: elapsed < 2000, elapsed }))
			server.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.strictEqual(result.fast, true, 'expected fast completion, got ' + result.elapsed + 'ms')
	})
})
