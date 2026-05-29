import { describe } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, testQnOnly, execAsync } from './util.js'

const testDir = path.dirname(new URL(import.meta.url).pathname)
const certFile = path.join(testDir, 'fixtures', 'test-cert.pem')
const keyFile = path.join(testDir, 'fixtures', 'test-key.pem')
const certPem = readFileSync(certFile, 'utf8')
const keyPem = readFileSync(keyFile, 'utf8')

describe('node:https', () => {
	test('https.get receives response from HTTPS server', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import https from 'node:https'
			import { readFileSync } from 'node:fs'

			const server = https.createServer({
				cert: readFileSync(${JSON.stringify(certFile)}),
				key: readFileSync(${JSON.stringify(keyFile)}),
			}, (req, res) => {
				res.writeHead(201, { 'Content-Type': 'text/plain', 'X-Path': req.url })
				res.end('hello secure client')
			})

			server.listen(0, '127.0.0.1', () => {
				const { port } = server.address()
				https.get({ host: '127.0.0.1', servername: 'localhost', port, path: '/events' }, (res) => {
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
		return execAsync(bin, [`${dir}/test.js`], {
			env: { NODE_EXTRA_CA_CERTS: certFile },
		}).then(output => {
			const lines = output.split('\n')
			assert.strictEqual(lines[0], '201')
			assert.strictEqual(lines[1], '/events')
			assert.strictEqual(lines[2], 'hello secure client')
		})
	})

	test('https.request sends request body', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import https from 'node:https'

			const server = https.createServer({
				cert: ${JSON.stringify(certPem)},
				key: ${JSON.stringify(keyPem)},
			}, (req, res) => {
				let body = ''
				req.on('data', (chunk) => { body += chunk })
				req.on('end', () => {
					res.end(req.method + ' ' + req.url + ' ' + body)
				})
			})

			server.listen(0, '127.0.0.1', () => {
				const { port } = server.address()
				const req = https.request({
					host: '127.0.0.1',
					servername: 'localhost',
					port,
					method: 'POST',
					path: '/submit',
				}, (res) => {
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
		return execAsync(bin, [`${dir}/test.js`], {
			env: { NODE_EXTRA_CA_CERTS: certFile },
		}).then(output => {
			assert.strictEqual(output, 'POST /submit payload')
		})
	})

	test('https client supports rejectUnauthorized false', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import https from 'node:https'
			import { readFileSync } from 'node:fs'

			const server = https.createServer({
				cert: readFileSync(${JSON.stringify(certFile)}),
				key: readFileSync(${JSON.stringify(keyFile)}),
			}, (req, res) => res.end('insecure-ok'))

			server.listen(0, '127.0.0.1', () => {
				const { port } = server.address()
				https.get({ host: '127.0.0.1', port, rejectUnauthorized: false }, (res) => {
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
			assert.strictEqual(output, 'insecure-ok')
		})
	})

	test('https client accepts supported Agent forms', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import https from 'node:https'

			const server = https.createServer({
				cert: ${JSON.stringify(certPem)},
				key: ${JSON.stringify(keyPem)},
			}, (req, res) => res.end('agent-ok'))

			server.listen(0, '127.0.0.1', () => {
				const { port } = server.address()
				const agent = new https.Agent()
				https.get({ host: '127.0.0.1', servername: 'localhost', port, agent }, (res) => {
					let body = ''
					res.on('data', (chunk) => { body += chunk })
					res.on('end', () => {
						console.log(body)
						server.close()
					})
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`], {
			env: { NODE_EXTRA_CA_CERTS: certFile },
		}).then(output => {
			assert.strictEqual(output, 'agent-ok')
		})
	})

	testQnOnly('HTTPS server handles keep-alive requests on one connection', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import https from 'node:https'
			import { createConnection } from 'node:net'
			import * as tls from 'qn:tls'

			async function connect(port) {
				const socket = await new Promise((resolve, reject) => {
					const s = createConnection(port, '127.0.0.1', () => resolve(s))
					s.on('error', reject)
				})
				socket.pause()
				const tr = tls.streamTransport(socket._handle)
				tls.ensureCACerts()
				const conn = tls.connect('localhost')
				await tls.handshake(conn, tr)
				return { socket, tr, conn }
			}

			async function readResponse(conn, tr) {
				let text = ''
				const buf = new ArrayBuffer(1024)
				while (!text.includes('\\r\\n\\r\\n')) {
					const n = await tls.read(conn, tr, buf, 0, 1024)
					if (n === 0) throw new Error('unexpected eof')
					text += new TextDecoder().decode(new Uint8Array(buf, 0, n))
				}
				const len = Number((text.match(/content-length: (\\d+)/i) || [])[1] || 0)
				while (text.split('\\r\\n\\r\\n')[1].length < len) {
					const n = await tls.read(conn, tr, buf, 0, 1024)
					if (n === 0) throw new Error('unexpected eof')
					text += new TextDecoder().decode(new Uint8Array(buf, 0, n))
				}
				return text.split('\\r\\n\\r\\n')[1].slice(0, len)
			}

			let count = 0
			const server = https.createServer({
				cert: ${JSON.stringify(certPem)},
				key: ${JSON.stringify(keyPem)},
			}, (req, res) => {
				count++
				res.end('response-' + count)
			})

			server.listen(0, '127.0.0.1', async () => {
				const { port } = server.address()
				const { socket, tr, conn } = await connect(port)
				await tls.writeAll(conn, tr, new TextEncoder().encode('GET /one HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: keep-alive\\r\\n\\r\\n'))
				const one = await readResponse(conn, tr)
				await tls.writeAll(conn, tr, new TextEncoder().encode('GET /two HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n'))
				const two = await readResponse(conn, tr)
				console.log(one + '|' + two)
				socket.destroy()
				server.close()
			})
		`)
		return execAsync(bin, [`${dir}/test.js`], {
			env: { NODE_EXTRA_CA_CERTS: certFile },
		}).then(output => {
			assert.strictEqual(output, 'response-1|response-2')
		})
	})

	testQnOnly('large HTTPS request applies backpressure and drains', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import https from 'node:https'

			const server = https.createServer({
				cert: ${JSON.stringify(certPem)},
				key: ${JSON.stringify(keyPem)},
			}, (req, res) => {
				let total = 0
				req.on('data', (chunk) => { total += chunk.byteLength })
				req.on('end', () => res.end(String(total)))
			})

			server.listen(0, '127.0.0.1', () => {
				const { port } = server.address()
				const req = https.request({
					host: '127.0.0.1',
					servername: 'localhost',
					port,
					method: 'POST',
					path: '/upload',
					headers: { 'Content-Length': String(256 * 1024) },
				}, (res) => {
					let body = ''
					res.on('data', (chunk) => { body += chunk })
					res.on('end', () => {
						console.log(JSON.stringify({ body, sawFalse, sawDrain }))
						server.close()
					})
				})
				let sawFalse = false
				let sawDrain = false
				req.on('drain', () => { sawDrain = true })
				const chunk = 'x'.repeat(1024)
				for (let i = 0; i < 256; i++) {
					if (!req.write(chunk)) sawFalse = true
				}
				req.end()
			})
		`)
		return execAsync(bin, [`${dir}/test.js`], {
			env: { NODE_EXTRA_CA_CERTS: certFile },
		}).then(output => {
			assert.deepStrictEqual(JSON.parse(output), {
				body: String(256 * 1024),
				sawFalse: true,
				sawDrain: true,
			})
		})
	})

	testQnOnly('client receives error when certificate verification fails', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import https from 'node:https'

			const server = https.createServer({
				cert: ${JSON.stringify(certPem)},
				key: ${JSON.stringify(keyPem)},
			}, (req, res) => res.end('should-not-reach'))

			server.listen(0, '127.0.0.1', () => {
				const { port } = server.address()
				const req = https.get({
					host: '127.0.0.1',
					servername: 'localhost',
					port,
				}, () => console.log('missing-response'))
				req.on('error', () => {
					console.log('error')
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.strictEqual(output, 'error')
		})
	})

	testQnOnly('HTTPS server rejects malformed TLS client without crashing', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import https from 'node:https'
			import { createConnection } from 'node:net'

			const server = https.createServer({
				cert: ${JSON.stringify(certPem)},
				key: ${JSON.stringify(keyPem)},
			}, (req, res) => res.end('unused'))

			server.listen(0, '127.0.0.1', () => {
				const { port } = server.address()
				const client = createConnection(port, '127.0.0.1', () => {
					client.write('not tls\\r\\n')
				})
				client.on('error', () => {})
				client.on('close', () => {
					server.close()
					console.log('closed')
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.strictEqual(output, 'closed')
		})
	})

	testQnOnly('unsupported HTTPS options throw explicit errors', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import https from 'node:https'
			try {
				https.get({ host: 'example.com', ca: 'not-supported' })
				console.log('missing-error')
			} catch (err) {
				console.log(err.message.includes('ca') ? 'ok' : err.message)
			}
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.strictEqual(output, 'ok')
		})
	})
})
