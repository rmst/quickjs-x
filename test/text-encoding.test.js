import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

describe('TextEncoder', () => {
	test('encode ASCII string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const encoder = new TextEncoder()
			const encoded = encoder.encode('hello')
			console.log(JSON.stringify({
				isUint8Array: encoded instanceof Uint8Array,
				bytes: Array.from(encoded)
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			isUint8Array: true,
			bytes: [104, 101, 108, 108, 111]
		})
	})

	test('encode Unicode string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const encoder = new TextEncoder()
			const encoded = encoder.encode('世界')
			console.log(JSON.stringify({
				bytes: Array.from(encoded)
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		// '世' = E4 B8 96, '界' = E7 95 8C
		assert.deepStrictEqual(JSON.parse(output), {
			bytes: [0xE4, 0xB8, 0x96, 0xE7, 0x95, 0x8C]
		})
	})

	test('encode emoji (4-byte UTF-8)', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const encoder = new TextEncoder()
			const encoded = encoder.encode('🌍')
			console.log(JSON.stringify({
				bytes: Array.from(encoded)
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		// '🌍' = F0 9F 8C 8D
		assert.deepStrictEqual(JSON.parse(output), {
			bytes: [0xF0, 0x9F, 0x8C, 0x8D]
		})
	})

	test('encode empty string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const encoder = new TextEncoder()
			const encoded = encoder.encode('')
			console.log(JSON.stringify({
				length: encoded.length
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { length: 0 })
	})

	test('encoding property is utf-8', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const encoder = new TextEncoder()
			console.log(JSON.stringify({ encoding: encoder.encoding }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { encoding: 'utf-8' })
	})
})

describe('TextDecoder', () => {
	test('decode ASCII bytes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const decoder = new TextDecoder()
			const bytes = new Uint8Array([104, 101, 108, 108, 111])
			console.log(JSON.stringify({ result: decoder.decode(bytes) }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { result: 'hello' })
	})

	test('decode Unicode bytes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const decoder = new TextDecoder()
			// '世界' in UTF-8
			const bytes = new Uint8Array([0xE4, 0xB8, 0x96, 0xE7, 0x95, 0x8C])
			console.log(JSON.stringify({ result: decoder.decode(bytes) }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { result: '世界' })
	})

	test('decode emoji bytes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const decoder = new TextDecoder()
			// '🌍' in UTF-8
			const bytes = new Uint8Array([0xF0, 0x9F, 0x8C, 0x8D])
			console.log(JSON.stringify({ result: decoder.decode(bytes) }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { result: '🌍' })
	})

	test('decode empty input returns empty string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const decoder = new TextDecoder()
			console.log(JSON.stringify({
				emptyArray: decoder.decode(new Uint8Array([])),
				undefined: decoder.decode()
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			emptyArray: '',
			undefined: ''
		})
	})

	test('decode ArrayBuffer directly', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const decoder = new TextDecoder()
			const buffer = new Uint8Array([104, 105]).buffer
			console.log(JSON.stringify({ result: decoder.decode(buffer) }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { result: 'hi' })
	})

	test('encoding property is utf-8', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const decoder = new TextDecoder()
			console.log(JSON.stringify({ encoding: decoder.encoding }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { encoding: 'utf-8' })
	})

	test('accepts utf-8 and utf8 encoding names', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const d1 = new TextDecoder('utf-8')
			const d2 = new TextDecoder('utf8')
			const d3 = new TextDecoder('UTF-8')
			console.log(JSON.stringify({
				e1: d1.encoding,
				e2: d2.encoding,
				e3: d3.encoding
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			e1: 'utf-8',
			e2: 'utf-8',
			e3: 'utf-8'
		})
	})
})

describe('TextDecoder stream mode', () => {
	test('buffers incomplete 3-byte sequence across chunks', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const dec = new TextDecoder()
			// '€' = 0xE2 0x82 0xAC, split between chunks
			const a = dec.decode(new Uint8Array([0xE2, 0x82]), { stream: true })
			const b = dec.decode(new Uint8Array([0xAC]), { stream: true })
			const c = dec.decode()
			console.log(JSON.stringify({ a, b, c, combined: a + b + c }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			a: '', b: '€', c: '', combined: '€'
		})
	})

	test('buffers incomplete 4-byte emoji across chunks', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const dec = new TextDecoder()
			// '😀' = 0xF0 0x9F 0x98 0x80
			let s = ''
			s += dec.decode(new Uint8Array([0xF0]), { stream: true })
			s += dec.decode(new Uint8Array([0x9F, 0x98]), { stream: true })
			s += dec.decode(new Uint8Array([0x80]), { stream: true })
			s += dec.decode()
			console.log(JSON.stringify({ s }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { s: '😀' })
	})

	test('emits complete codepoints when chunk ends on boundary', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const dec = new TextDecoder()
			const r = dec.decode(new Uint8Array([0xE2, 0x82, 0xAC]), { stream: true })
			console.log(JSON.stringify({ r }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { r: '€' })
	})

	test('strips BOM only on first emitted chunk', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const dec = new TextDecoder()
			const a = dec.decode(new Uint8Array([0xEF, 0xBB, 0xBF, 0x68]), { stream: true })
			const b = dec.decode(new Uint8Array([0x69]), { stream: true })
			const c = dec.decode()
			console.log(JSON.stringify({ combined: a + b + c }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { combined: 'hi' })
	})
})

describe('TextDecoder BOM handling', () => {
	test('strips BOM by default', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const decoder = new TextDecoder()
			// UTF-8 BOM (0xEF 0xBB 0xBF) followed by "hello"
			const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, 0x68, 0x65, 0x6C, 0x6C, 0x6F])
			const result = decoder.decode(bytes)
			console.log(JSON.stringify({ result, length: result.length }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { result: 'hello', length: 5 })
	})

	test('keeps BOM when ignoreBOM is true', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
			// UTF-8 BOM (0xEF 0xBB 0xBF) followed by "hello"
			const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, 0x68, 0x65, 0x6C, 0x6C, 0x6F])
			const result = decoder.decode(bytes)
			console.log(JSON.stringify({
				startsWithBOM: result.charCodeAt(0) === 0xFEFF,
				length: result.length
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { startsWithBOM: true, length: 6 })
	})

	test('does not strip BOM from middle of string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const decoder = new TextDecoder()
			// "a" + BOM + "b"
			const bytes = new Uint8Array([0x61, 0xEF, 0xBB, 0xBF, 0x62])
			const result = decoder.decode(bytes)
			console.log(JSON.stringify({
				length: result.length,
				hasBOMInMiddle: result.charCodeAt(1) === 0xFEFF
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { length: 3, hasBOMInMiddle: true })
	})
})

describe('TextEncoder/TextDecoder roundtrip', () => {
	test('roundtrip ASCII', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const encoder = new TextEncoder()
			const decoder = new TextDecoder()
			const original = 'Hello, World!'
			const encoded = encoder.encode(original)
			const decoded = decoder.decode(encoded)
			console.log(JSON.stringify({ match: original === decoded }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { match: true })
	})

	test('roundtrip Unicode', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const encoder = new TextEncoder()
			const decoder = new TextDecoder()
			const original = 'Hello 世界 🌍 مرحبا'
			const encoded = encoder.encode(original)
			const decoded = decoder.decode(encoded)
			console.log(JSON.stringify({ match: original === decoded }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { match: true })
	})
})
