import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

describe('globals', () => {
	test('performance.now() returns a number', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const t = performance.now()
			console.log(typeof t)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'number')
	})

	test('performance.now() increases over time', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const t1 = performance.now()
			let x = 0
			for (let i = 0; i < 100000; i++) x += i
			const t2 = performance.now()
			console.log(JSON.stringify({ increased: t2 > t1 }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { increased: true })
	})

	test('btoa encodes string to base64', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.log(btoa('Hello, World!'))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'SGVsbG8sIFdvcmxkIQ==')
	})

	test('atob decodes base64 to string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.log(atob('SGVsbG8sIFdvcmxkIQ=='))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'Hello, World!')
	})

	test('atob and btoa are inverse operations', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const original = 'The quick brown fox jumps over the lazy dog'
			const encoded = btoa(original)
			const decoded = atob(encoded)
			console.log(JSON.stringify({ match: decoded === original }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { match: true })
	})

	test('btoa handles empty string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.log(btoa(''))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), '')
	})

	test('atob handles empty string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.log(JSON.stringify({ empty: atob('') === '' }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { empty: true })
	})

	test('ReadableStream with getReader', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const rs = new ReadableStream({
				start(controller) {
					controller.enqueue("hello ")
					controller.enqueue("world")
					controller.close()
				}
			})
			const reader = rs.getReader()
			let result = ""
			for (;;) {
				const { value, done } = await reader.read()
				if (done) break
				result += value
			}
			console.log(result)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'hello world')
	})

	test('ReadableStream async iteration', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const rs = new ReadableStream({
				start(controller) {
					controller.enqueue("a")
					controller.enqueue("b")
					controller.enqueue("c")
					controller.close()
				}
			})
			const chunks = []
			for await (const chunk of rs) chunks.push(chunk)
			console.log(chunks.join(","))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'a,b,c')
	})

	test('ReadableStream empty stream', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const rs = new ReadableStream({
				start(controller) {
					controller.close()
				}
			})
			const chunks = []
			for await (const chunk of rs) chunks.push(chunk)
			console.log(chunks.length)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, '0')
	})

	testQnOnly('ReadableStream error propagation', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const rs = new ReadableStream({
				start(controller) {
					controller.enqueue("ok")
					controller.error(new Error("boom"))
				}
			})
			const reader = rs.getReader()
			const first = await reader.read()
			console.log(first.value)
			try {
				await reader.read()
				console.log("no error")
			} catch (e) {
				console.log(e.message)
			}
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'ok\nboom')
	})

	testQnOnly('console.time and timeEnd output timing', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.time('test')
			let x = 0
			for (let i = 0; i < 10000; i++) x += i
			console.timeEnd('test')
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.match(output, /^test: \d+\.\d+ms$/)
	})

	testQnOnly('console.time with default label', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.time()
			console.timeEnd()
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.match(output, /^default: \d+\.\d+ms$/)
	})

	testQnOnly('console.timeLog outputs intermediate timing', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.time('myTimer')
			console.timeLog('myTimer')
			console.timeEnd('myTimer')
		`)

		const output = $`${bin} ${dir}/test.js`
		const lines = output.split('\n')
		assert.strictEqual(lines.length, 2)
		assert.match(lines[0], /^myTimer: \d+\.\d+ms$/)
		assert.match(lines[1], /^myTimer: \d+\.\d+ms$/)
	})

	testQnOnly('console.timeEnd warns for non-existent label', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.timeEnd('nonexistent')
		`)

		const output = $({ stdio: ['pipe', 'pipe', 'pipe'] })`${bin} ${dir}/test.js 2>&1`
		assert.match(output, /Warning.*nonexistent/)
	})

	testQnOnly('console.time warns for duplicate label', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.time('dup')
			console.time('dup')
			console.timeEnd('dup')
		`)

		const output = $({ stdio: ['pipe', 'pipe', 'pipe'] })`${bin} ${dir}/test.js 2>&1`
		assert.match(output, /Warning.*dup.*already exists/)
	})

	testQnOnly('console.timeLog with extra data', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.time('data')
			console.timeLog('data', 'extra', 'info')
			console.timeEnd('data')
		`)

		const output = $`${bin} ${dir}/test.js`
		const lines = output.split('\n')
		assert.match(lines[0], /^data: \d+\.\d+ms extra info$/)
	})

	test('structuredClone clones primitives and plain objects', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const src = { a: 1, b: 'two', c: true, d: null, e: undefined, f: [1, 2, 3], g: { nested: 'x' } }
			const dst = structuredClone(src)
			console.log(JSON.stringify({
				equal: JSON.stringify(dst) === JSON.stringify(src),
				notSame: dst !== src,
				nestedNotSame: dst.g !== src.g,
				arrayNotSame: dst.f !== src.f,
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { equal: true, notSame: true, nestedNotSame: true, arrayNotSame: true })
	})

	test('structuredClone clones Date', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const d = new Date(1700000000000)
			const c = structuredClone(d)
			console.log(JSON.stringify({
				equal: c.getTime() === d.getTime(),
				notSame: c !== d,
				isDate: c instanceof Date,
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { equal: true, notSame: true, isDate: true })
	})

	test('structuredClone clones RegExp', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const r = /foo(bar)?/gi
			const c = structuredClone(r)
			console.log(JSON.stringify({
				source: c.source === r.source,
				flags: c.flags === r.flags,
				notSame: c !== r,
				isRegExp: c instanceof RegExp,
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { source: true, flags: true, notSame: true, isRegExp: true })
	})

	test('structuredClone clones Map', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const m = new Map([['a', 1], ['b', { nested: 2 }]])
			const c = structuredClone(m)
			console.log(JSON.stringify({
				size: c.size === 2,
				a: c.get('a') === 1,
				b: c.get('b').nested === 2,
				notSameMap: c !== m,
				notSameValue: c.get('b') !== m.get('b'),
				isMap: c instanceof Map,
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { size: true, a: true, b: true, notSameMap: true, notSameValue: true, isMap: true })
	})

	test('structuredClone clones Set', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const s = new Set([1, 'two', { x: 3 }])
			const c = structuredClone(s)
			console.log(JSON.stringify({
				size: c.size === 3,
				has1: c.has(1),
				hasTwo: c.has('two'),
				isSet: c instanceof Set,
				notSame: c !== s,
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { size: true, has1: true, hasTwo: true, isSet: true, notSame: true })
	})

	test('structuredClone handles circular references', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const a = { name: 'a' }
			a.self = a
			const c = structuredClone(a)
			console.log(JSON.stringify({
				name: c.name === 'a',
				selfRefersToClone: c.self === c,
				notOriginal: c !== a,
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { name: true, selfRefersToClone: true, notOriginal: true })
	})

	test('structuredClone clones ArrayBuffer with copy semantics', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const ab = new ArrayBuffer(4)
			new Uint8Array(ab).set([1, 2, 3, 4])
			const c = structuredClone(ab)
			new Uint8Array(c)[0] = 99
			console.log(JSON.stringify({
				notSame: c !== ab,
				originalUntouched: new Uint8Array(ab)[0] === 1,
				cloneModified: new Uint8Array(c)[0] === 99,
				size: c.byteLength === 4,
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { notSame: true, originalUntouched: true, cloneModified: true, size: true })
	})

	test('structuredClone clones typed arrays', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const u = new Uint8Array([1, 2, 3, 4])
			const c = structuredClone(u)
			c[0] = 99
			console.log(JSON.stringify({
				isUint8: c instanceof Uint8Array,
				originalUntouched: u[0] === 1,
				cloneModified: c[0] === 99,
				bufferIsCopy: c.buffer !== u.buffer,
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isUint8: true, originalUntouched: true, cloneModified: true, bufferIsCopy: true })
	})

	test('structuredClone clones Buffer as Uint8Array', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const b = Buffer.from([1, 2, 3])
			const c = structuredClone(b)
			console.log(JSON.stringify({
				ctor: c.constructor.name,
				isBuffer: Buffer.isBuffer(c),
				bytes: Array.from(c),
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { ctor: 'Uint8Array', isBuffer: false, bytes: [1, 2, 3] })
	})

	test('structuredClone throws DataCloneError on functions', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				structuredClone(() => 1)
				console.log('no error')
			} catch (e) {
				console.log(JSON.stringify({ name: e.name, isDOMException: e instanceof DOMException }))
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { name: 'DataCloneError', isDOMException: true })
	})
})
