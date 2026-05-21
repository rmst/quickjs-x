import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { testQnOnly, execAsync } from './util.js'

describe('qn:proxy', () => {
	testQnOnly('forwards GET request to backend', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createProxy } from 'qn:proxy'

			const backend = http.createServer((req, res) => {
				res.writeHead(200, { 'content-type': 'text/plain', 'x-backend': 'yes' })
				res.end('hello from backend')
			})
			await new Promise(r => backend.listen(0, '127.0.0.1', r))
			const backendPort = backend.address().port

			const proxy = await createProxy({
				port: 0,
				hostname: '127.0.0.1',
				route: () => \`http://127.0.0.1:\${backendPort}\`,
			})
			const proxyPort = proxy.address().port

			const res = await fetch(\`http://127.0.0.1:\${proxyPort}/test\`)
			const text = await res.text()

			console.log(JSON.stringify({
				status: res.status,
				text,
				xBackend: res.headers.get('x-backend'),
			}))

			await proxy.close()
			backend.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 200)
		assert.strictEqual(result.text, 'hello from backend')
		assert.strictEqual(result.xBackend, 'yes')
	})

	testQnOnly('forwards POST body to backend', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createProxy } from 'qn:proxy'

			const backend = http.createServer(async (req, res) => {
				const chunks = []
				req.on('data', c => chunks.push(c))
				await new Promise(r => req.on('end', r))
				const body = Buffer.concat(chunks).toString()
				res.writeHead(200)
				res.end('echo:' + body)
			})
			await new Promise(r => backend.listen(0, '127.0.0.1', r))
			const backendPort = backend.address().port

			const proxy = await createProxy({
				port: 0,
				hostname: '127.0.0.1',
				route: () => \`http://127.0.0.1:\${backendPort}\`,
			})
			const proxyPort = proxy.address().port

			const res = await fetch(\`http://127.0.0.1:\${proxyPort}/echo\`, {
				method: 'POST',
				body: 'hello world',
			})
			const text = await res.text()

			console.log(JSON.stringify({ status: res.status, text }))
			await proxy.close()
			backend.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 200)
		assert.strictEqual(result.text, 'echo:hello world')
	})

	testQnOnly('streams Content-Length request bodies without buffering', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createConnection } from 'node:net'
			import { createProxy } from 'qn:proxy'

			const backend = http.createServer((req, res) => {
				req.once('data', (chunk) => {
					res.writeHead(200, { 'content-type': 'text/plain' })
					res.end('early:' + chunk)
				})
			})
			await new Promise(r => backend.listen(0, '127.0.0.1', r))
			const backendPort = backend.address().port

			const proxy = await createProxy({
				port: 0,
				hostname: '127.0.0.1',
				route: () => \`http://127.0.0.1:\${backendPort}\`,
			})
			const proxyPort = proxy.address().port

			const result = await new Promise((resolve, reject) => {
				const client = createConnection(proxyPort, '127.0.0.1')
				const timer = setTimeout(() => reject(new Error('timed out waiting for early response')), 1000)
				let data = ''
				client.on('connect', () => {
					client.write('POST /stream HTTP/1.1\\r\\nHost: proxy\\r\\nContent-Length: 10\\r\\nConnection: close\\r\\n\\r\\nhello')
				})
				client.on('data', (chunk) => {
					data += chunk
					if (data.includes('early:hello')) {
						clearTimeout(timer)
						client.destroy()
						resolve(data)
					}
				})
				client.on('error', (err) => { clearTimeout(timer); reject(err) })
			})

			console.log(result.includes('early:hello'))
			await proxy.close()
			backend.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		assert.strictEqual(output, 'true')
	})

	testQnOnly('sets X-Forwarded-* headers', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createProxy } from 'qn:proxy'

			const backend = http.createServer((req, res) => {
				res.writeHead(200)
				res.end(JSON.stringify({
					xff: req.headers['x-forwarded-for'],
					xfp: req.headers['x-forwarded-proto'],
					xfh: req.headers['x-forwarded-host'],
				}))
			})
			await new Promise(r => backend.listen(0, '127.0.0.1', r))
			const backendPort = backend.address().port

			const proxy = await createProxy({
				port: 0,
				hostname: '127.0.0.1',
				route: () => \`http://127.0.0.1:\${backendPort}\`,
			})
			const proxyPort = proxy.address().port

			const res = await fetch(\`http://127.0.0.1:\${proxyPort}/\`, {
				headers: { host: 'myapp.example.com' },
			})
			const data = await res.json()

			console.log(JSON.stringify(data))
			await proxy.close()
			backend.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const data = JSON.parse(output)
		assert.ok(data.xff, 'x-forwarded-for should be set')
		assert.strictEqual(data.xfp, 'http')
		assert.ok(data.xfh, 'x-forwarded-host should be set')
	})

	testQnOnly('returns 404 when route returns null', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createProxy } from 'qn:proxy'

			const proxy = await createProxy({
				port: 0,
				hostname: '127.0.0.1',
				route: () => null,
			})
			const proxyPort = proxy.address().port

			const res = await fetch(\`http://127.0.0.1:\${proxyPort}/\`)
			const text = await res.text()

			console.log(JSON.stringify({ status: res.status, text }))
			await proxy.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 404)
		assert.strictEqual(result.text, 'Not Found')
	})

	testQnOnly('returns 502 when backend is down', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createProxy } from 'qn:proxy'

			const proxy = await createProxy({
				port: 0,
				hostname: '127.0.0.1',
				route: () => 'http://127.0.0.1:1',
			})
			const proxyPort = proxy.address().port

			const res = await fetch(\`http://127.0.0.1:\${proxyPort}/\`)
			const text = await res.text()

			console.log(JSON.stringify({ status: res.status, text }))
			await proxy.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 502)
		assert.strictEqual(result.text, 'Bad Gateway')
	})

	testQnOnly('forwards path and query string', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createProxy } from 'qn:proxy'

			const backend = http.createServer((req, res) => {
				res.writeHead(200)
				res.end(req.url)
			})
			await new Promise(r => backend.listen(0, '127.0.0.1', r))
			const backendPort = backend.address().port

			const proxy = await createProxy({
				port: 0,
				hostname: '127.0.0.1',
				route: () => \`http://127.0.0.1:\${backendPort}\`,
			})
			const proxyPort = proxy.address().port

			const res = await fetch(\`http://127.0.0.1:\${proxyPort}/api/users?page=2&sort=name\`)
			const text = await res.text()

			console.log(JSON.stringify({ text }))
			await proxy.close()
			backend.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.strictEqual(result.text, '/api/users?page=2&sort=name')
	})

	testQnOnly('proxies WebSocket messages', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { WebSocket, WebSocketServer } from 'ws'
			import { createProxy } from 'qn:proxy'

			// Backend WebSocket server that echoes messages
			const backendHTTP = http.createServer()
			const backendWS = new WebSocketServer({ server: backendHTTP })
			backendWS.on('connection', (ws) => {
				ws.on('message', (data, isBinary) => {
					ws.send(isBinary ? data : 'echo:' + data.toString())
				})
			})
			await new Promise(r => backendHTTP.listen(0, '127.0.0.1', r))
			const backendPort = backendHTTP.address().port

			// Proxy
			const proxy = await createProxy({
				port: 0,
				hostname: '127.0.0.1',
				route: () => \`http://127.0.0.1:\${backendPort}\`,
			})
			const proxyPort = proxy.address().port

			// Connect WebSocket client through the proxy
			const client = new WebSocket(\`ws://127.0.0.1:\${proxyPort}/ws\`)

			const received = await new Promise((resolve, reject) => {
				const t = setTimeout(() => reject(new Error('ws timeout')), 5000)
				client.on('open', () => client.send('hello'))
				client.on('message', (data) => {
					clearTimeout(t)
					resolve(data.toString())
				})
				client.on('error', (err) => { clearTimeout(t); reject(err) })
			})

			console.log(JSON.stringify({ received }))

			await new Promise(r => { client.on('close', r); client.close() })
			await proxy.close()
			backendWS.close()
			backendHTTP.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.strictEqual(result.received, 'echo:hello')
	})

	testQnOnly('proxies WebSocket binary messages', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { WebSocket, WebSocketServer } from 'ws'
			import { createProxy } from 'qn:proxy'

			const backendHTTP = http.createServer()
			const backendWS = new WebSocketServer({ server: backendHTTP })
			backendWS.on('connection', (ws) => {
				ws.on('message', (data) => ws.send(data))
			})
			await new Promise(r => backendHTTP.listen(0, '127.0.0.1', r))
			const backendPort = backendHTTP.address().port

			const proxy = await createProxy({
				port: 0,
				hostname: '127.0.0.1',
				route: () => \`http://127.0.0.1:\${backendPort}\`,
			})
			const proxyPort = proxy.address().port

			const client = new WebSocket(\`ws://127.0.0.1:\${proxyPort}/\`)

			const received = await new Promise((resolve, reject) => {
				const t = setTimeout(() => reject(new Error('ws timeout')), 5000)
				client.on('open', () => {
					client.send(Buffer.from([1, 2, 3, 4, 5]))
				})
				client.on('message', (data, isBinary) => {
					clearTimeout(t)
					resolve({ data: [...Buffer.from(data)], isBinary })
				})
				client.on('error', (err) => { clearTimeout(t); reject(err) })
			})

			console.log(JSON.stringify(received))

			await new Promise(r => { client.on('close', r); client.close() })
			await proxy.close()
			backendWS.close()
			backendHTTP.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.deepStrictEqual(result.data, [1, 2, 3, 4, 5])
		assert.strictEqual(result.isBinary, true)
	})

	testQnOnly('path-based routing to multiple backends', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { createProxy } from 'qn:proxy'

			const backendA = http.createServer((req, res) => {
				res.writeHead(200)
				res.end('backend-a')
			})
			const backendB = http.createServer((req, res) => {
				res.writeHead(200)
				res.end('backend-b')
			})
			await Promise.all([
				new Promise(r => backendA.listen(0, '127.0.0.1', r)),
				new Promise(r => backendB.listen(0, '127.0.0.1', r)),
			])

			const proxy = await createProxy({
				port: 0,
				hostname: '127.0.0.1',
				route: (req) => {
					if (req.url.startsWith('/a')) return \`http://127.0.0.1:\${backendA.address().port}\`
					if (req.url.startsWith('/b')) return \`http://127.0.0.1:\${backendB.address().port}\`
					return null
				},
			})
			const proxyPort = proxy.address().port

			const [resA, resB, resC] = await Promise.all([
				fetch(\`http://127.0.0.1:\${proxyPort}/a\`).then(r => r.text()),
				fetch(\`http://127.0.0.1:\${proxyPort}/b\`).then(r => r.text()),
				fetch(\`http://127.0.0.1:\${proxyPort}/c\`).then(r => ({ status: r.status })),
			])

			console.log(JSON.stringify({ a: resA, b: resB, c: resC }))
			await proxy.close()
			backendA.close()
			backendB.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.strictEqual(result.a, 'backend-a')
		assert.strictEqual(result.b, 'backend-b')
		assert.strictEqual(result.c.status, 404)
	})
})
