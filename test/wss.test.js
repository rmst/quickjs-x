import { describe } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { testQnOnly, execAsync } from './util.js'

const testDir = path.dirname(new URL(import.meta.url).pathname)
const certFile = path.join(testDir, 'fixtures', 'test-cert.pem')
const keyFile = path.join(testDir, 'fixtures', 'test-key.pem')
const certPem = readFileSync(certFile, 'utf8')
const keyPem = readFileSync(keyFile, 'utf8')
const wsModuleUrl = new URL('../vendor/ws/index.js', import.meta.url).href
const NO_NODE = !!process.env.NO_NODEJS_TESTS

function runQnScript(name, source, options, check) {
	testQnOnly(name, async ({ bin, dir }) => {
		const script = path.join(dir, 'test.js')
		writeFileSync(script, source)
		const output = await execAsync(bin, [script], options)
		check(output)
	})
}

describe('WSS', () => {
	runQnScript('echoes messages over TLS and exposes secure metadata', `
		import https from 'node:https'
		import { WebSocket, WebSocketServer } from 'ws'

		let verifySecure = false
		const server = https.createServer({
			cert: ${JSON.stringify(certPem)},
			key: ${JSON.stringify(keyPem)},
		})
		const wss = new WebSocketServer({
			server,
			verifyClient(info) {
				verifySecure = info.secure
				return true
			},
		})
		const timer = setTimeout(() => { console.error('timeout'); process.exit(2) }, 5000)

		wss.on('connection', (socket) => {
			socket.on('message', (data) => socket.send(data))
		})

		server.listen(0, '127.0.0.1', () => {
			const client = new WebSocket('wss://127.0.0.1:' + server.address().port, {
				rejectUnauthorized: false,
			})
			client.on('open', () => client.send('hello'))
			client.on('message', (data) => {
				console.log([
					verifySecure,
					client._socket.encrypted,
					client._socket.authorized,
					client._socket.getProtocol(),
					data.toString(),
				].join('|'))
				client.once('close', () => {
					wss.close(() => server.close(() => clearTimeout(timer)))
				})
				client.close()
			})
			client.on('error', (err) => { throw err })
		})
	`, {}, output => {
		assert.strictEqual(output, 'true|true|false|TLSv1.2|hello')
	})

	runQnScript('validates a WSS server with NODE_EXTRA_CA_CERTS', `
		import https from 'node:https'
		import { WebSocket, WebSocketServer } from 'ws'

		const server = https.createServer({
			cert: ${JSON.stringify(certPem)},
			key: ${JSON.stringify(keyPem)},
		})
		const wss = new WebSocketServer({ server })
		const timer = setTimeout(() => { console.error('timeout'); process.exit(2) }, 5000)

		wss.on('connection', (socket) => socket.send('trusted'))
		server.listen(0, '127.0.0.1', () => {
			const client = new WebSocket('wss://localhost:' + server.address().port)
			client.on('message', (data) => {
				console.log(client._socket.authorized + '|' + data.toString())
				client.once('close', () => {
					wss.close(() => server.close(() => clearTimeout(timer)))
				})
				client.close()
			})
			client.on('error', (err) => { throw err })
		})
	`, { env: { NODE_EXTRA_CA_CERTS: certFile } }, output => {
		assert.strictEqual(output, 'true|trusted')
	})

	runQnScript('handles bidirectional burst traffic over WSS', `
		import https from 'node:https'
		import { WebSocket, WebSocketServer } from 'ws'

		const count = 64
		const server = https.createServer({
			cert: ${JSON.stringify(certPem)},
			key: ${JSON.stringify(keyPem)},
		})
		const wss = new WebSocketServer({ server })
		let receivedCount = 0
		const timer = setTimeout(() => { console.error('timeout after ' + receivedCount); process.exit(2) }, 5000)

		wss.on('connection', socket => {
			for (let i = 0; i < count; i++) socket.send('server:' + i)
			socket.on('message', data => socket.send('echo:' + data))
		})
		server.listen(0, '127.0.0.1', () => {
			const received = new Set()
			const client = new WebSocket('wss://127.0.0.1:' + server.address().port, {
				rejectUnauthorized: false,
			})
			client.on('open', () => {
				for (let i = 0; i < count; i++) client.send('client:' + i)
			})
			client.on('message', data => {
				received.add(data.toString())
				receivedCount = received.size
				if (received.size !== count * 2) return
				console.log(received.has('server:63') + '|' + received.has('echo:client:63'))
				client.once('close', () => {
					wss.close(() => server.close(() => clearTimeout(timer)))
				})
				client.close()
			})
			client.on('error', err => { throw err })
		})
	`, {}, output => {
		assert.strictEqual(output, 'true|true')
	})

	runQnScript('rejects an untrusted WSS certificate', `
		import https from 'node:https'
		import { WebSocket, WebSocketServer } from 'ws'

		const server = https.createServer({
			cert: ${JSON.stringify(certPem)},
			key: ${JSON.stringify(keyPem)},
		})
		const wss = new WebSocketServer({ server })
		const timer = setTimeout(() => { console.error('timeout'); process.exit(2) }, 5000)

		server.listen(0, '127.0.0.1', () => {
			const client = new WebSocket('wss://127.0.0.1:' + server.address().port)
			client.on('open', () => { throw new Error('unexpected open') })
			client.on('error', (err) => {
				client.send('after failure')
				console.log(err.message.startsWith('TLS handshake failed'))
				wss.close(() => server.close(() => clearTimeout(timer)))
			})
		})
	`, {}, output => {
		assert.strictEqual(output, 'true')
	})

	runQnScript('rejects a trusted certificate for the wrong servername', `
		import https from 'node:https'
		import { WebSocket, WebSocketServer } from 'ws'

		const server = https.createServer({
			cert: ${JSON.stringify(certPem)},
			key: ${JSON.stringify(keyPem)},
		})
		const wss = new WebSocketServer({ server })
		const timer = setTimeout(() => { console.error('timeout'); process.exit(2) }, 5000)

		server.listen(0, '127.0.0.1', () => {
			const client = new WebSocket('wss://127.0.0.1:' + server.address().port, {
				servername: 'wrong.example',
			})
			client.on('open', () => { throw new Error('unexpected open') })
			client.on('error', (err) => {
				console.log(err.message.startsWith('TLS handshake failed'))
				wss.close(() => server.close(() => clearTimeout(timer)))
			})
		})
	`, { env: { NODE_EXTRA_CA_CERTS: certFile } }, output => {
		assert.strictEqual(output, 'true')
	})

	runQnScript('preserves a frame coalesced with the client upgrade response', `
		import tls from 'node:tls'
		import { createHash } from 'node:crypto'
		import { WebSocket } from 'ws'

		const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
		const server = tls.createServer({
			cert: ${JSON.stringify(certPem)},
			key: ${JSON.stringify(keyPem)},
		}, (socket) => {
			let request = Buffer.alloc(0)
			socket.on('data', (chunk) => {
				request = Buffer.concat([request, chunk])
				if (request.indexOf('\\r\\n\\r\\n') === -1) return
				const key = request.toString().match(/Sec-WebSocket-Key: ([^\\r]+)/i)[1]
				const accept = createHash('sha1').update(key + GUID).digest('base64')
				const response = Buffer.from(
					'HTTP/1.1 101 Switching Protocols\\r\\n' +
					'Upgrade: websocket\\r\\n' +
					'Connection: Upgrade\\r\\n' +
					'Sec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n'
				)
				const frame = Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('ready')])
				socket.write(Buffer.concat([response, frame]))
			})
		})
		const timer = setTimeout(() => { console.error('timeout'); process.exit(2) }, 5000)

		server.listen(0, '127.0.0.1', () => {
			const client = new WebSocket('wss://127.0.0.1:' + server.address().port, {
				rejectUnauthorized: false,
			})
			client.on('message', (data) => {
				console.log(data.toString())
				client.terminate()
				server.close(() => clearTimeout(timer))
			})
			client.on('error', (err) => { throw err })
		})
	`, {}, output => {
		assert.strictEqual(output, 'ready')
	})

	runQnScript('preserves a frame coalesced with the server upgrade request', `
		import https from 'node:https'
		import tls from 'node:tls'
		import { WebSocketServer } from 'ws'

		const server = https.createServer({
			cert: ${JSON.stringify(certPem)},
			key: ${JSON.stringify(keyPem)},
		})
		const wss = new WebSocketServer({ server })
		const timer = setTimeout(() => { console.error('timeout'); process.exit(2) }, 5000)
		let client

		wss.on('connection', (socket) => {
			socket.on('message', (data) => {
				console.log(data.toString())
				client.destroy()
				wss.close(() => server.close(() => clearTimeout(timer)))
			})
		})

		server.listen(0, '127.0.0.1', () => {
			const key = 'MDEyMzQ1Njc4OWFiY2RlZg=='
			client = tls.connect({
				host: '127.0.0.1',
				port: server.address().port,
				rejectUnauthorized: false,
			}, () => {
				const request = Buffer.from(
					'GET / HTTP/1.1\\r\\n' +
					'Host: 127.0.0.1\\r\\n' +
					'Connection: Upgrade\\r\\n' +
					'Upgrade: websocket\\r\\n' +
					'Sec-WebSocket-Version: 13\\r\\n' +
					'Sec-WebSocket-Key: ' + key + '\\r\\n\\r\\n'
				)
				const frame = Buffer.from([0x81, 0x81, 1, 2, 3, 4, 'x'.charCodeAt(0) ^ 1])
				client.write(Buffer.concat([request, frame]))
			})
		})
	`, {}, output => {
		assert.strictEqual(output, 'x')
	})

	if (!NO_NODE) testQnOnly('connects a qn WSS client to a Node.js WSS server', async ({ bin, dir }) => {
		const serverScript = path.join(dir, 'node-server.mjs')
		const clientScript = path.join(dir, 'qn-client.js')
		writeFileSync(serverScript, `
			import https from 'node:https'
			import { readFileSync } from 'node:fs'
			import { WebSocketServer } from ${JSON.stringify(wsModuleUrl)}

			const server = https.createServer({
				cert: readFileSync(${JSON.stringify(certFile)}),
				key: readFileSync(${JSON.stringify(keyFile)}),
			})
			const wss = new WebSocketServer({ server })
			wss.on('connection', socket => socket.on('message', data => socket.send('node:' + data)))
			server.listen(0, '127.0.0.1', () => console.log(server.address().port))
		`)
		writeFileSync(clientScript, `
			import { spawn } from 'node:child_process'
			import { WebSocket } from 'ws'

			const server = spawn('node', [${JSON.stringify(serverScript)}], { stdio: ['ignore', 'pipe', 'pipe'] })
			let stderr = ''
			server.stderr.on('data', data => stderr += data)
			const timer = setTimeout(() => { server.kill('SIGKILL'); console.error('timeout'); process.exit(2) }, 5000)
			const port = await new Promise((resolve, reject) => {
				let stdout = ''
				server.stdout.on('data', data => {
					stdout += data
					const match = stdout.match(/^(\\d+)/)
					if (match) resolve(Number(match[1]))
				})
				server.on('error', reject)
				server.on('exit', code => {
					if (code !== null) reject(new Error('Node.js WSS server exited: ' + code + ' ' + stderr))
				})
			})
			const client = new WebSocket('wss://127.0.0.1:' + port, { servername: 'localhost' })
			const received = await new Promise((resolve, reject) => {
				client.on('open', () => client.send('hello'))
				client.on('message', data => resolve(data.toString()))
				client.on('error', reject)
			})
			console.log(received)
			await new Promise(resolve => { client.on('close', resolve); client.close() })
			server.kill('SIGTERM')
			await new Promise(resolve => server.on('close', resolve))
			clearTimeout(timer)
		`)

		const output = await execAsync(bin, [clientScript], {
			env: { NODE_EXTRA_CA_CERTS: certFile },
		})
		assert.strictEqual(output, 'node:hello')
	})

	if (!NO_NODE) testQnOnly('accepts a Node.js WSS client on a qn WSS server', async ({ bin, dir }) => {
		const clientScript = path.join(dir, 'node-client.mjs')
		const serverScript = path.join(dir, 'qn-server.js')
		writeFileSync(clientScript, `
			import { WebSocket } from ${JSON.stringify(wsModuleUrl)}

			const client = new WebSocket('wss://127.0.0.1:' + process.argv[2], { servername: 'localhost' })
			client.on('open', () => client.send('hello'))
			client.on('message', data => {
				console.log(data.toString())
				client.close()
			})
			client.on('error', err => { throw err })
		`)
		writeFileSync(serverScript, `
			import https from 'node:https'
			import { spawn } from 'node:child_process'
			import { WebSocketServer } from 'ws'

			const server = https.createServer({
				cert: ${JSON.stringify(certPem)},
				key: ${JSON.stringify(keyPem)},
			})
			const wss = new WebSocketServer({ server })
			wss.on('connection', socket => socket.on('message', data => socket.send('qn:' + data)))
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
			const client = spawn('node', [${JSON.stringify(clientScript)}, String(server.address().port)], {
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			let stdout = ''
			let stderr = ''
			client.stdout.on('data', data => stdout += data)
			client.stderr.on('data', data => stderr += data)
			const timer = setTimeout(() => { client.kill('SIGKILL'); console.error('timeout'); process.exit(2) }, 5000)
			const code = await new Promise((resolve, reject) => {
				client.on('error', reject)
				client.on('close', resolve)
			})
			clearTimeout(timer)
			if (code !== 0) throw new Error('Node.js WSS client exited: ' + code + ' ' + stderr)
			console.log(stdout.trim())
			await new Promise(resolve => wss.close(resolve))
			await new Promise(resolve => server.close(resolve))
		`)

		const output = await execAsync(bin, [serverScript], {
			env: { NODE_EXTRA_CA_CERTS: certFile },
		})
		assert.strictEqual(output, 'qn:hello')
	})
})
