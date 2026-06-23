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
			import { createConnection } from 'node:net'
			import { createProxy } from 'qn:proxy'

			const backend = http.createServer((req, res) => {
				const body = JSON.stringify({
					host: req.headers.host,
					xff: req.headers['x-forwarded-for'],
					xfp: req.headers['x-forwarded-proto'],
					xfh: req.headers['x-forwarded-host'],
				})
				res.writeHead(200, {
					'content-type': 'application/json',
					'content-length': String(Buffer.byteLength(body)),
				})
				res.end(body)
			})
			await new Promise(r => backend.listen(0, '127.0.0.1', r))
			const backendPort = backend.address().port

			const proxy = await createProxy({
				port: 0,
				hostname: '127.0.0.1',
				route: () => \`http://127.0.0.1:\${backendPort}\`,
			})
			const proxyPort = proxy.address().port

			const data = await new Promise((resolve, reject) => {
				const client = createConnection(proxyPort, '127.0.0.1')
				let response = ''
				client.on('connect', () => {
					client.write('GET / HTTP/1.1\\r\\nHost: myapp.example.com\\r\\nConnection: close\\r\\n\\r\\n')
				})
				client.on('data', chunk => response += chunk)
				client.on('end', () => {
					resolve(JSON.parse(response.split('\\r\\n\\r\\n')[1]))
				})
				client.on('error', reject)
			})

			console.log(JSON.stringify(data))
			await proxy.close()
			backend.close()
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const data = JSON.parse(output)
		assert.strictEqual(data.host, 'myapp.example.com')
		assert.ok(data.xff, 'x-forwarded-for should be set')
		assert.strictEqual(data.xfp, 'http')
		assert.strictEqual(data.xfh, 'myapp.example.com')
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

	testQnOnly('preserves Host header for WebSocket backend handshake', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { WebSocket, WebSocketServer } from 'ws'
			import { createProxy } from 'qn:proxy'

			const backendHTTP = http.createServer()
			const backendWS = new WebSocketServer({ server: backendHTTP })
			backendWS.on('connection', (ws, req) => {
				ws.send(JSON.stringify({
					host: req.headers.host,
					xfh: req.headers['x-forwarded-host'],
				}))
			})
			await new Promise(r => backendHTTP.listen(0, '127.0.0.1', r))
			const backendPort = backendHTTP.address().port

			const proxy = await createProxy({
				port: 0,
				hostname: '127.0.0.1',
				route: () => \`http://127.0.0.1:\${backendPort}\`,
			})
			const proxyPort = proxy.address().port

			const client = new WebSocket(\`ws://127.0.0.1:\${proxyPort}/ws\`, {
				headers: { host: 'preview.example.local' },
			})

			const received = await new Promise((resolve, reject) => {
				const t = setTimeout(() => reject(new Error('ws timeout')), 5000)
				client.on('message', (data) => {
					clearTimeout(t)
					resolve(JSON.parse(data.toString()))
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
		assert.strictEqual(result.host, 'preview.example.local')
		assert.strictEqual(result.xfh, 'preview.example.local')
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

	testQnOnly('proxy CLI routes wildcard hosts with exact precedence', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			import { spawn } from 'node:child_process'
			import { writeFileSync } from 'node:fs'
			import { createConnection } from 'node:net'

			const qn = ${JSON.stringify(bin)}
			const configPath = ${JSON.stringify(`${dir}/homeproxy.conf`)}
			const runnerPath = ${JSON.stringify(`${dir}/proxy-cli-runner.js`)}

			const makeBackend = async (name) => {
				const server = http.createServer((req, res) => {
					const body = JSON.stringify({
						name,
						host: req.headers.host,
						xfh: req.headers['x-forwarded-host'],
					})
					res.writeHead(200, {
						'content-type': 'application/json',
						'content-length': String(Buffer.byteLength(body)),
					})
					res.end(body)
				})
				await new Promise(r => server.listen(0, '127.0.0.1', r))
				return server
			}

			const closeServer = server => new Promise(resolve => server.close(resolve))
			const target = server => \`http://127.0.0.1:\${server.address().port}\`

			const fallbackBackend = await makeBackend('fallback-wildcard')
			const wildcardBackend = await makeBackend('preview-wildcard')
			const exactBackend = await makeBackend('exact')

			writeFileSync(configPath, [
				\`*.local \${target(fallbackBackend)}\`,
				\`*.preview.local \${target(wildcardBackend)}\`,
				\`exact.preview.local \${target(exactBackend)}\`,
				'',
			].join('\\n'))
			writeFileSync(runnerPath, "import 'qn:proxy/cli'\\n")

			const child = spawn(qn, [runnerPath, '--config', configPath, '--port', '0', '--hostname', '127.0.0.1'], {
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			let closed = false
			let killTimer = null
			child.on('close', () => {
				closed = true
				if (killTimer) clearTimeout(killTimer)
			})

			const stopProxy = () => new Promise(resolve => {
				if (closed) { resolve(); return }
				child.once('close', resolve)
				child.kill('SIGTERM')
				killTimer = setTimeout(() => {
					if (!closed) child.kill('SIGKILL')
				}, 500)
			})

			let stderr = ''
			child.stderr.on('data', d => stderr += d.toString())
			const proxyPort = await new Promise((resolve, reject) => {
				let settled = false
				let stdout = ''
				const done = (fn, value) => {
					if (settled) return
					settled = true
					clearTimeout(timer)
					fn(value)
				}
				const timer = setTimeout(() => done(reject, new Error('timed out waiting for proxy CLI: ' + stderr)), 5000)
				child.stdout.on('data', d => {
					stdout += d.toString()
					const match = stdout.match(/listening on [^:]+:(\\d+)/)
					if (match) done(resolve, Number(match[1]))
				})
				child.on('error', err => done(reject, err))
				child.on('exit', (code, signal) => {
					if (code !== 0 && !settled)
						done(reject, new Error(\`proxy CLI exited before listening: code=\${code} signal=\${signal} stderr=\${stderr}\`))
				})
			})

			const fetchHost = host => new Promise((resolve, reject) => {
				const client = createConnection(proxyPort, '127.0.0.1')
				let response = ''
				client.on('connect', () => {
					client.write(\`GET /test HTTP/1.1\\r\\nHost: \${host}\\r\\nConnection: close\\r\\n\\r\\n\`)
				})
				client.on('data', chunk => response += chunk)
				client.on('end', () => {
					const [head, body = ''] = response.split('\\r\\n\\r\\n')
					const status = Number(head.match(/HTTP\\/1\\.1 (\\d+)/)?.[1] || 0)
					resolve({
						status,
						body: body ? JSON.parse(body) : null,
					})
				})
				client.on('error', reject)
			})

			try {
				const preview = await fetchHost('app.session.preview.local')
				const exact = await fetchHost('exact.preview.local')
				const fallback = await fetchHost('other.local')
				console.log(JSON.stringify({ preview, exact, fallback }))
			} finally {
				await stopProxy()
				await closeServer(fallbackBackend)
				await closeServer(wildcardBackend)
				await closeServer(exactBackend)
			}
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		const result = JSON.parse(output)
		assert.strictEqual(result.preview.status, 200)
		assert.strictEqual(result.preview.body.name, 'preview-wildcard')
		assert.strictEqual(result.preview.body.host, 'app.session.preview.local')
		assert.strictEqual(result.preview.body.xfh, 'app.session.preview.local')
		assert.strictEqual(result.exact.status, 200)
		assert.strictEqual(result.exact.body.name, 'exact')
		assert.strictEqual(result.fallback.status, 200)
		assert.strictEqual(result.fallback.body.name, 'fallback-wildcard')
	})
})
