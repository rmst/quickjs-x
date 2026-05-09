import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

describe('Web Crypto API (globalThis.crypto)', () => {
	/* ---- Existence ---- */

	test('globalThis.crypto exists with expected shape', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.log(JSON.stringify({
				crypto: typeof globalThis.crypto,
				getRandomValues: typeof crypto.getRandomValues,
				randomUUID: typeof crypto.randomUUID,
				subtle: typeof crypto.subtle,
				digest: typeof crypto.subtle.digest,
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			crypto: 'object',
			getRandomValues: 'function',
			randomUUID: 'function',
			subtle: 'object',
			digest: 'function',
		})
	})

	/* ---- getRandomValues ---- */

	test('getRandomValues fills a Uint8Array and returns it', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const u = new Uint8Array(32)
			const ret = crypto.getRandomValues(u)
			console.log(JSON.stringify({
				same: ret === u,
				len: u.length,
				notAllZero: u.some(b => b !== 0),
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { same: true, len: 32, notAllZero: true })
	})

	test('getRandomValues works on all integer typed arrays', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const types = [Int8Array, Uint8Array, Uint8ClampedArray,
				Int16Array, Uint16Array, Int32Array, Uint32Array,
				BigInt64Array, BigUint64Array]
			const results = types.map(T => {
				const a = new T(4)
				crypto.getRandomValues(a)
				return { name: T.name, ok: a.byteLength === 4 * a.BYTES_PER_ELEMENT }
			})
			console.log(JSON.stringify(results))
		`)

		const output = $`${bin} ${dir}/test.js`
		const results = JSON.parse(output)
		assert.strictEqual(results.length, 9)
		for (const r of results) assert.strictEqual(r.ok, true, r.name)
	})

	test('getRandomValues respects byteOffset on a shared buffer', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const buf = new ArrayBuffer(16)
			const head = new Uint8Array(buf, 0, 8)
			const tail = new Uint8Array(buf, 8, 8)
			crypto.getRandomValues(tail)
			console.log(JSON.stringify({
				headAllZero: [...head].every(b => b === 0),
				tailNotAllZero: [...tail].some(b => b !== 0),
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { headAllZero: true, tailNotAllZero: true })
	})

	test('getRandomValues with 0-length array does not throw', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const u = new Uint8Array(0)
			crypto.getRandomValues(u)
			console.log(JSON.stringify({ len: u.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { len: 0 })
	})

	test('getRandomValues throws on Float typed arrays', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const results = []
			for (const T of [Float32Array, Float64Array]) {
				let threw = false
				try { crypto.getRandomValues(new T(4)) } catch { threw = true }
				results.push({ name: T.name, threw })
			}
			console.log(JSON.stringify(results))
		`)

		const output = $`${bin} ${dir}/test.js`
		const results = JSON.parse(output)
		for (const r of results) assert.strictEqual(r.threw, true, r.name)
	})

	test('getRandomValues throws on non-typed-array input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const results = []
			for (const v of [null, undefined, [], {}, 'string', 42, new ArrayBuffer(8)]) {
				let threw = false
				try { crypto.getRandomValues(v) } catch { threw = true }
				results.push(threw)
			}
			console.log(JSON.stringify(results))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), [true, true, true, true, true, true, true])
	})

	test('getRandomValues throws QuotaExceededError when over 65536 bytes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			let threw = false, name = null
			try {
				crypto.getRandomValues(new Uint8Array(65537))
			} catch (e) {
				threw = true
				name = e.name
			}
			console.log(JSON.stringify({ threw, name }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true, name: 'QuotaExceededError' })
	})

	test('getRandomValues accepts exactly 65536 bytes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const u = new Uint8Array(65536)
			crypto.getRandomValues(u)
			console.log(JSON.stringify({ len: u.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { len: 65536 })
	})

	test('getRandomValues produces non-deterministic output', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const a = new Uint8Array(32), b = new Uint8Array(32)
			crypto.getRandomValues(a)
			crypto.getRandomValues(b)
			let differ = 0
			for (let i = 0; i < 32; i++) if (a[i] !== b[i]) differ++
			// 32 random bytes should overwhelmingly differ; allow some equal slots
			console.log(JSON.stringify({ differOver10: differ > 10 }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { differOver10: true })
	})

	/* ---- randomUUID ---- */

	test('crypto.randomUUID format', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const uuid = crypto.randomUUID()
			const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)
			console.log(JSON.stringify({ valid, length: uuid.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { valid: true, length: 36 })
	})

	test('crypto.randomUUID returns unique values', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const set = new Set()
			for (let i = 0; i < 100; i++) set.add(crypto.randomUUID())
			console.log(JSON.stringify({ unique: set.size }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { unique: 100 })
	})

	/* ---- subtle.digest ---- */

	test('subtle.digest returns a Promise<ArrayBuffer>', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const p = crypto.subtle.digest('SHA-256', new TextEncoder().encode('x'))
			const isPromise = p instanceof Promise
			const buf = await p
			console.log(JSON.stringify({
				isPromise,
				isArrayBuffer: buf instanceof ArrayBuffer,
				byteLength: buf.byteLength,
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			isPromise: true,
			isArrayBuffer: true,
			byteLength: 32,
		})
	})

	test('subtle.digest SHA-256 of "hello world" matches known value', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hello world'))
			const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
			console.log(hex)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
	})

	test('subtle.digest SHA-1 of "abc"', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode('abc'))
			const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
			console.log(hex)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'a9993e364706816aba3e25717850c26c9cd0d89d')
	})

	test('subtle.digest SHA-384 of "abc"', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const buf = await crypto.subtle.digest('SHA-384', new TextEncoder().encode('abc'))
			const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
			console.log(hex)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(),
			'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7')
	})

	test('subtle.digest SHA-512 of "abc"', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const buf = await crypto.subtle.digest('SHA-512', new TextEncoder().encode('abc'))
			const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
			console.log(hex)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(),
			'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f')
	})

	test('subtle.digest accepts {name: ...} algorithm form', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const buf = await crypto.subtle.digest({ name: 'SHA-256' }, new TextEncoder().encode('hello world'))
			const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
			console.log(hex)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
	})

	test('subtle.digest is case-insensitive on algorithm name', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const a = await crypto.subtle.digest('sha-256', new TextEncoder().encode('hello world'))
			const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hello world'))
			const hexA = [...new Uint8Array(a)].map(b => b.toString(16).padStart(2, '0')).join('')
			const hexB = [...new Uint8Array(b)].map(b => b.toString(16).padStart(2, '0')).join('')
			console.log(JSON.stringify({ match: hexA === hexB }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { match: true })
	})

	test('subtle.digest accepts ArrayBuffer input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const ab = new TextEncoder().encode('hello world').buffer
			const buf = await crypto.subtle.digest('SHA-256', ab)
			const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
			console.log(hex)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
	})

	test('subtle.digest accepts a DataView input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const ab = new TextEncoder().encode('hello world').buffer
			const dv = new DataView(ab)
			const buf = await crypto.subtle.digest('SHA-256', dv)
			const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
			console.log(hex)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
	})

	test('subtle.digest of empty input matches the well-known hash', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const buf = await crypto.subtle.digest('SHA-256', new Uint8Array(0))
			const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
			console.log(hex)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(),
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
	})

	test('subtle.digest rejects unsupported algorithm', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			let rejected = false, name = null
			try {
				await crypto.subtle.digest('MD5', new Uint8Array(0))
			} catch (e) {
				rejected = true
				name = e.name
			}
			console.log(JSON.stringify({ rejected, name }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { rejected: true, name: 'NotSupportedError' })
	})

	/* ---- Integration: PKCE-style flow ---- */

	test('PKCE-style code_verifier + code_challenge flow', ({ bin, dir }) => {
		// Validates that the typical OAuth/PKCE building blocks compose correctly:
		// random bytes -> base64url -> SHA-256 -> base64url
		writeFileSync(`${dir}/test.js`, `
			const b64url = (bytes) => btoa(String.fromCharCode(...bytes))
				.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

			const random = new Uint8Array(32)
			crypto.getRandomValues(random)
			const verifier = b64url(random)

			const challengeBytes = new Uint8Array(
				await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
			const challenge = b64url(challengeBytes)

			console.log(JSON.stringify({
				verifierLen: verifier.length,
				challengeLen: challenge.length,
				verifierClean: /^[A-Za-z0-9_-]+$/.test(verifier),
				challengeClean: /^[A-Za-z0-9_-]+$/.test(challenge),
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.verifierClean, true)
		assert.strictEqual(result.challengeClean, true)
		// 32 bytes -> 43 chars after base64url-no-pad
		assert.strictEqual(result.verifierLen, 43)
		assert.strictEqual(result.challengeLen, 43)
	})

	/* ---- qn-only constructor exposure ---- */

	testQnOnly('Crypto and SubtleCrypto are exposed on globalThis', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.log(JSON.stringify({
				Crypto: typeof globalThis.Crypto,
				SubtleCrypto: typeof globalThis.SubtleCrypto,
				cryptoIsCryptoInstance: globalThis.crypto instanceof globalThis.Crypto,
				subtleIsSubtleInstance: globalThis.crypto.subtle instanceof globalThis.SubtleCrypto,
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			Crypto: 'function',
			SubtleCrypto: 'function',
			cryptoIsCryptoInstance: true,
			subtleIsSubtleInstance: true,
		})
	})
})
