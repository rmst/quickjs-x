import { describe } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { testQnOnly, execAsync } from './util.js'

const testDir = path.dirname(new URL(import.meta.url).pathname)
const certPem = readFileSync(path.join(testDir, 'fixtures', 'test-cert.pem'), 'utf8')
const keyPem = readFileSync(path.join(testDir, 'fixtures', 'test-key.pem'), 'utf8')

describe('node:tls', () => {
	testQnOnly('connects a TLS client and server with Node-style socket metadata', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import tls, { TLSSocket } from 'node:tls'

			let serverEncrypted = false
			const server = tls.createServer({
				cert: ${JSON.stringify(certPem)},
				key: ${JSON.stringify(keyPem)},
			}, (socket) => {
				serverEncrypted = socket.encrypted
				socket.write('server-first')
			})
			const timer = setTimeout(() => { console.error('timeout'); process.exit(2) }, 5000)

			server.listen(0, '127.0.0.1', () => {
				const events = []
				const client = tls.connect({
					host: '127.0.0.1',
					port: server.address().port,
					rejectUnauthorized: false,
				}, () => events.push('callback'))
				client.on('connect', () => events.push('connect'))
				client.on('secureConnect', () => events.push('secureConnect'))
				client.on('data', (data) => {
					console.log(JSON.stringify({
						events,
						instance: client instanceof TLSSocket,
						encrypted: client.encrypted,
						authorized: client.authorized,
						protocol: client.getProtocol(),
						serverEncrypted,
						data: data.toString(),
					}))
					client.destroy()
					server.close(() => clearTimeout(timer))
				})
				client.on('error', (err) => { throw err })
			})
		`)
		const result = JSON.parse(await execAsync(bin, [`${dir}/test.js`]))
		assert.deepStrictEqual(result, {
			events: ['connect', 'callback', 'secureConnect'],
			instance: true,
			encrypted: true,
			authorized: false,
			protocol: 'TLSv1.2',
			serverEncrypted: true,
			data: 'server-first',
		})
	})

	testQnOnly('buffers writes made before the TLS handshake completes', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import tls from 'node:tls'

			const server = tls.createServer({
				cert: ${JSON.stringify(certPem)},
				key: ${JSON.stringify(keyPem)},
			}, (socket) => socket.on('data', data => socket.write('echo:' + data)))
			const timer = setTimeout(() => { console.error('timeout'); process.exit(2) }, 5000)

			server.listen(0, '127.0.0.1', () => {
				const client = tls.connect({
					host: '127.0.0.1',
					port: server.address().port,
					rejectUnauthorized: false,
				})
				client.write('early')
				client.on('data', data => {
					console.log(data.toString())
					client.destroy()
					server.close(() => clearTimeout(timer))
				})
				client.on('error', err => { throw err })
			})
		`)
		assert.strictEqual(await execAsync(bin, [`${dir}/test.js`]), 'echo:early')
	})

	testQnOnly('throws for unsupported TLS options', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import tls from 'node:tls'
			const results = []
			try {
				tls.connect({ host: 'localhost', port: 443, ca: 'unsupported' })
				results.push('missing-ca-error')
			} catch (err) {
				results.push(err.message.includes('ca') ? 'ca' : err.message)
			}
			try {
				new tls.TLSSocket({})
				results.push('missing-wrap-error')
			} catch (err) {
				results.push(err.message.includes('wrapping') ? 'wrap' : err.message)
			}
			console.log(results.join('|'))
		`)
		assert.strictEqual(await execAsync(bin, [`${dir}/test.js`]), 'ca|wrap')
	})
})
