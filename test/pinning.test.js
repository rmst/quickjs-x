import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { testQnOnly, execAsync } from './util.js'

const NO_NODE = process.env.NO_NODEJS_TESTS

const testDir = path.dirname(new URL(import.meta.url).pathname)
const certFile = path.join(testDir, 'fixtures', 'test-cert.pem')
const keyFile = path.join(testDir, 'fixtures', 'test-key.pem')

/* Compute the expected pin hashes from the test fixture cert. The
 * SPKI hash is what `openssl x509 -pubkey | openssl pkey -pubin
 * -outform DER | openssl dgst -sha256 -binary | base64` produces. */
function computeExpectedPins() {
	const pem = readFileSync(certFile, 'utf8')
	const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/)
	const der = Buffer.from(m[1].replace(/\s+/g, ''), 'base64')
	const certSha256 = createHash('sha256').update(der).digest('base64')

	/* Walk ASN.1 to extract SPKI substring — same algorithm as
	 * qn:tls.extractSpki, replicated here so we don't depend on it
	 * (else a bug there would be invisible to these tests). */
	const buf = der
	const parseLen = (off) => {
		const f = buf[off]
		if (f < 0x80) return [f, 1]
		const n = f & 0x7f
		let len = 0
		for (let i = 0; i < n; i++) len = len * 256 + buf[off + 1 + i]
		return [len, 1 + n]
	}
	const tlv = (off) => {
		const tag = buf[off]
		const [len, lb] = parseLen(off + 1)
		return { tag, contentOff: off + 1 + lb, totalLen: 1 + lb + len }
	}
	const outer = tlv(0)
	const tbs = tlv(outer.contentOff)
	let off = tbs.contentOff
	if (buf[off] === 0xa0) off += tlv(off).totalLen   // version [0]
	off += tlv(off).totalLen   // serial
	off += tlv(off).totalLen   // sigAlg
	off += tlv(off).totalLen   // issuer
	off += tlv(off).totalLen   // validity
	off += tlv(off).totalLen   // subject
	const spki = tlv(off)
	const spkiDer = buf.subarray(off, off + spki.totalLen)
	const spkiSha256 = createHash('sha256').update(spkiDer).digest('base64')

	return { certSha256, spkiSha256 }
}

const HTTPS_SERVER_CODE = `
const https = require('https');
const fs = require('fs');
const server = https.createServer({
	cert: fs.readFileSync(${JSON.stringify(certFile)}),
	key: fs.readFileSync(${JSON.stringify(keyFile)}),
}, (req, res) => {
	res.setHeader('Connection', 'close');
	res.writeHead(200, { 'Content-Type': 'text/plain' });
	res.end('hello');
});
server.listen(0, '127.0.0.1', () => {
	console.log(server.address().port);
});
`

function startHttpsServer() {
	return new Promise((resolve, reject) => {
		const child = spawn('node', ['-e', HTTPS_SERVER_CODE], {
			stdio: ['ignore', 'pipe', 'inherit']
		})
		let output = ''
		child.stdout.on('data', (data) => {
			output += data.toString()
			const port = parseInt(output.trim(), 10)
			if (!isNaN(port)) {
				setTimeout(() => resolve({ port, close: () => child.kill() }), 50)
			}
		})
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code !== null && code !== 0)
				reject(new Error(`HTTPS server exited with code ${code}`))
		})
	})
}

describe('Certificate pinning (qn:tls extractSpki)', () => {
	testQnOnly('extractSpki produces the same hash as openssl', async ({ bin, dir }) => {
		const { spkiSha256 } = computeExpectedPins()
		writeFileSync(`${dir}/test.js`, `
			import { extractSpki } from 'qn:tls'
			import { createHash } from 'node:crypto'
			import { readFileSync } from 'node:fs'
			const pem = readFileSync(${JSON.stringify(certFile)}, 'utf8')
			const m = pem.match(/-----BEGIN CERTIFICATE-----([\\s\\S]*?)-----END CERTIFICATE-----/)
			const der = Buffer.from(m[1].replace(/\\s+/g, ''), 'base64')
			const spki = extractSpki(der)
			const h = createHash('sha256').update(spki).digest('base64')
			console.log(h)
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		assert.strictEqual(output, spkiSha256)
	})

	testQnOnly('extractSpki rejects malformed input', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { extractSpki } from 'qn:tls'
			try {
				extractSpki(new Uint8Array([0x01, 0x02, 0x03]))
				console.log('FAIL: expected throw')
			} catch (e) {
				console.log('threw')
			}
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		assert.strictEqual(output, 'threw')
	})
})

describe('qn:fetch pin registry', () => {
	testQnOnly('pin/unpin/getPin/clearPins basic behavior', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { pin, unpin, clearPins, getPin } from 'qn:fetch'
			pin('example.com', { spkiSha256: 'AAAA' })
			console.log('1:', getPin('example.com')?.spkiSha256)
			console.log('2:', getPin('EXAMPLE.com')?.spkiSha256)  // case-insensitive
			console.log('3:', getPin('other.com'))
			pin('https://api.foo.bar/path', { spkiSha256: 'BBBB' })
			console.log('4:', getPin('api.foo.bar')?.spkiSha256)  // URL form
			pin('*', { spkiSha256: 'CCCC' })
			console.log('5:', getPin('unknown.host')?.spkiSha256)  // wildcard
			console.log('6:', getPin('example.com')?.spkiSha256)   // exact wins
			unpin('example.com')
			console.log('7:', getPin('example.com')?.spkiSha256)   // wildcard now
			clearPins()
			console.log('8:', getPin('example.com'), getPin('*'))
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		assert.strictEqual(output,
			'1: AAAA\n2: AAAA\n3: null\n4: BBBB\n5: CCCC\n6: AAAA\n7: CCCC\n8: null null')
	})

	testQnOnly('pin requires certSha256 or spkiSha256', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { pin } from 'qn:fetch'
			try { pin('example.com', {}); console.log('FAIL') }
			catch (e) { console.log(e.message.includes('requires') ? 'ok' : e.message) }
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		assert.strictEqual(output, 'ok')
	})
})

if (!NO_NODE) describe('Pinning over HTTPS fetch', { concurrency: false }, () => {
	testQnOnly('correct SPKI pin allows fetch to succeed', async ({ bin, dir }) => {
		const { spkiSha256 } = computeExpectedPins()
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				import { pin } from 'qn:fetch'
				pin('localhost', { spkiSha256: ${JSON.stringify(spkiSha256)} })
				const r = await fetch('https://localhost:${port}/')
				console.log(r.status + ' ' + await r.text())
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, '200 hello')
		} finally { close() }
	})

	testQnOnly('correct cert pin allows fetch to succeed', async ({ bin, dir }) => {
		const { certSha256 } = computeExpectedPins()
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				import { pin } from 'qn:fetch'
				pin('localhost', { certSha256: ${JSON.stringify(certSha256)} })
				const r = await fetch('https://localhost:${port}/')
				console.log(r.status)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, '200')
		} finally { close() }
	})

	testQnOnly('wrong SPKI pin rejects the fetch', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				import { pin } from 'qn:fetch'
				pin('localhost', { spkiSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })
				try {
					await fetch('https://localhost:${port}/')
					console.log('should-not-reach')
				} catch (e) {
					console.log(e.message.includes('SPKI') ? 'rejected' : e.message)
				}
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'rejected')
		} finally { close() }
	})

	testQnOnly('wrong cert pin rejects the fetch', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				import { pin } from 'qn:fetch'
				pin('localhost', { certSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })
				try {
					await fetch('https://localhost:${port}/')
					console.log('should-not-reach')
				} catch (e) {
					console.log(e.message.includes('leaf cert') ? 'rejected' : e.message)
				}
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'rejected')
		} finally { close() }
	})

	testQnOnly('backup pin in array allows succeed', async ({ bin, dir }) => {
		const { spkiSha256 } = computeExpectedPins()
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				import { pin } from 'qn:fetch'
				pin('localhost', {
					spkiSha256: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
					             ${JSON.stringify(spkiSha256)}]
				})
				const r = await fetch('https://localhost:${port}/')
				console.log(r.status)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, '200')
		} finally { close() }
	})

	testQnOnly('both certSha256 and spkiSha256 must match (defense in depth)',
		async ({ bin, dir }) => {
		const { certSha256 } = computeExpectedPins()
		const { port, close } = await startHttpsServer()
		try {
			/* certSha256 is correct but spkiSha256 is wrong → must reject */
			writeFileSync(`${dir}/test.js`, `
				import { pin } from 'qn:fetch'
				pin('localhost', {
					certSha256: ${JSON.stringify(certSha256)},
					spkiSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
				})
				try {
					await fetch('https://localhost:${port}/')
					console.log('should-not-reach')
				} catch (e) {
					console.log(e.message.includes('SPKI') ? 'rejected' : e.message)
				}
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'rejected')
		} finally { close() }
	})

	testQnOnly('changing pin between fetches uses fresh connection',
		async ({ bin, dir }) => {
		const { spkiSha256 } = computeExpectedPins()
		const { port, close } = await startHttpsServer()
		try {
			/* First fetch with no pin (pools the conn). Second fetch with a
			 * wrong pin must NOT reuse the pooled connection — it must fail. */
			writeFileSync(`${dir}/test.js`, `
				import { pin, unpin } from 'qn:fetch'
				const r1 = await fetch('https://localhost:${port}/')
				console.log('first:', r1.status)
				pin('localhost', { spkiSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })
				try {
					await fetch('https://localhost:${port}/')
					console.log('FAIL: pooled conn was reused without pin check')
				} catch (e) {
					console.log('second:', e.message.includes('SPKI') ? 'rejected' : 'wrong-error')
				}
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'first: 200\nsecond: rejected')
		} finally { close() }
	})

	/*
	 * trustOnlyPin mode: pin is the sole identity check. The test cert
	 * is self-signed (no public CA chain), so without NODE_EXTRA_CA_CERTS
	 * loaded the chain validation would normally fail — we use the same
	 * fixture as a stand-in for the self-signed scenario by NOT setting
	 * NODE_EXTRA_CA_CERTS in these tests' env.
	 */
	testQnOnly('trustOnlyPin succeeds with no CA loaded when pin matches',
		async ({ bin, dir }) => {
		const { spkiSha256 } = computeExpectedPins()
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				import { pin } from 'qn:fetch'
				pin('localhost', {
					spkiSha256: ${JSON.stringify(spkiSha256)},
					trustOnlyPin: true,
				})
				const r = await fetch('https://localhost:${port}/')
				console.log(r.status + ' ' + await r.text())
			`)
			/* Deliberately omit NODE_EXTRA_CA_CERTS to simulate self-signed. */
			const output = await execAsync(bin, [`${dir}/test.js`], { env: {} })
			assert.strictEqual(output, '200 hello')
		} finally { close() }
	})

	testQnOnly('trustOnlyPin still rejects wrong pin with no CA loaded',
		async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				import { pin } from 'qn:fetch'
				pin('localhost', {
					spkiSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
					trustOnlyPin: true,
				})
				try {
					await fetch('https://localhost:${port}/')
					console.log('should-not-reach')
				} catch (e) {
					console.log(e.message.includes('SPKI') ? 'rejected' : e.message)
				}
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], { env: {} })
			assert.strictEqual(output, 'rejected')
		} finally { close() }
	})

	testQnOnly('without trustOnlyPin, self-signed cert is rejected even with correct pin',
		async ({ bin, dir }) => {
		const { spkiSha256 } = computeExpectedPins()
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				import { pin } from 'qn:fetch'
				pin('localhost', { spkiSha256: ${JSON.stringify(spkiSha256)} })
				try {
					await fetch('https://localhost:${port}/')
					console.log('should-not-reach')
				} catch (e) {
					/* BearSSL chain validation rejects before pin runs */
					console.log(e.message.includes('handshake') ? 'rejected' : e.message)
				}
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], { env: {} })
			assert.strictEqual(output, 'rejected')
		} finally { close() }
	})
})
