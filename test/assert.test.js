import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

describe('node:assert shim', () => {
	test('notStrictEqual passes for different values', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			assert.notStrictEqual(1, 2)
			assert.notStrictEqual('a', 'b')
			assert.notStrictEqual(null, undefined)
			assert.notStrictEqual({}, {})  // Different references
			console.log(JSON.stringify({ passed: true }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('notStrictEqual throws for equal values', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let threw = false
			try {
				assert.notStrictEqual(1, 1)
			} catch (e) {
				threw = true
			}
			console.log(JSON.stringify({ threw }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	test('notDeepStrictEqual passes for different values', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			assert.notDeepStrictEqual({ a: 1 }, { a: 2 })
			assert.notDeepStrictEqual([1, 2], [1, 3])
			assert.notDeepStrictEqual({ a: { b: 1 }}, { a: { b: 2 }})
			console.log(JSON.stringify({ passed: true }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('notDeepStrictEqual throws for deeply equal values', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let threw = false
			try {
				assert.notDeepStrictEqual({ a: 1 }, { a: 1 })
			} catch (e) {
				threw = true
			}
			console.log(JSON.stringify({ threw }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	test('throws passes when function throws', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			assert.throws(() => {
				throw new Error('test error')
			})
			console.log(JSON.stringify({ passed: true }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('throws fails when function does not throw', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let threw = false
			try {
				assert.throws(() => {
					// doesn't throw
				})
			} catch (e) {
				threw = e.message.includes('Missing expected exception')
			}
			console.log(JSON.stringify({ threw }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	test('throws with RegExp validates error message', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			assert.throws(() => {
				throw new Error('test error message')
			}, /test error/)
			console.log(JSON.stringify({ passed: true }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('throws with RegExp fails on mismatch', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let threw = false
			try {
				assert.throws(() => {
					throw new Error('actual message')
				}, /expected pattern/)
			} catch (e) {
				threw = e.name === 'AssertionError'
			}
			console.log(JSON.stringify({ threw }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	test('throws with Error constructor validates instanceof', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			assert.throws(() => {
				throw new TypeError('wrong type')
			}, TypeError)
			console.log(JSON.stringify({ passed: true }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('throws with Error constructor fails on wrong type', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let threw = false
			try {
				assert.throws(() => {
					throw new Error('generic')
				}, TypeError)
			} catch (e) {
				threw = e.name === 'AssertionError'
			}
			console.log(JSON.stringify({ threw }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	test('throws with predicate validator calls function with the thrown error', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let arrowSawCode = false
			let normalSawCode = false
			let normalSawThis = false
			const throwCoded = () => {
				const err = new Error('coded')
				err.code = 'ERR_TEST'
				throw err
			}
			assert.throws(throwCoded, (err) => {
				arrowSawCode = err?.code === 'ERR_TEST'
				return arrowSawCode
			})
			assert.throws(throwCoded, function validator(err) {
				normalSawCode = err?.code === 'ERR_TEST'
				normalSawThis = this && Object.getPrototypeOf(this) === Object.prototype
				return normalSawCode
			})
			console.log(JSON.stringify({ arrowSawCode, normalSawCode, normalSawThis }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { arrowSawCode: true, normalSawCode: true, normalSawThis: true })
	})

	test('throws with predicate validator fails unless it returns true', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let threw = false
			try {
				assert.throws(() => {
					throw new Error('coded')
				}, () => 'truthy')
			} catch (e) {
				threw = e.name === 'AssertionError'
			}
			console.log(JSON.stringify({ threw }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	test('throws with object validates properties', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			assert.throws(() => {
				const err = new Error('test')
				err.code = 'ERR_TEST'
				throw err
			}, { code: 'ERR_TEST' })
			console.log(JSON.stringify({ passed: true }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('throws with object and RegExp property', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			assert.throws(() => {
				throw new Error('detailed error message')
			}, { message: /detailed.*message/ })
			console.log(JSON.stringify({ passed: true }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('doesNotThrow passes when function does not throw', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			assert.doesNotThrow(() => {
				// safe code
			})
			console.log(JSON.stringify({ passed: true }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('doesNotThrow fails when function throws', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let threw = false
			try {
				assert.doesNotThrow(() => {
					throw new Error('oops')
				})
			} catch (e) {
				threw = e.message.includes('unwanted exception')
			}
			console.log(JSON.stringify({ threw }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	test('doesNotThrow with predicate validator fails only when it matches', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			const throwCoded = () => {
				const err = new Error('coded')
				err.code = 'ERR_TEST'
				throw err
			}
			let matched = false
			let rethrew = false
			try {
				assert.doesNotThrow(throwCoded, (err) => err?.code === 'ERR_TEST')
			} catch (e) {
				matched = e.name === 'AssertionError'
			}
			try {
				assert.doesNotThrow(throwCoded, (err) => err?.code === 'OTHER')
			} catch (e) {
				rethrew = e.code === 'ERR_TEST'
			}
			console.log(JSON.stringify({ matched, rethrew }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { matched: true, rethrew: true })
	})

	test('named exports work', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { throws, notStrictEqual, notDeepStrictEqual, doesNotThrow, rejects, doesNotReject } from 'node:assert'
			throws(() => { throw new Error() })
			notStrictEqual(1, 2)
			notDeepStrictEqual({a: 1}, {a: 2})
			doesNotThrow(() => {})
			await rejects(async () => { throw new Error('x') })
			await doesNotReject(async () => {})
			console.log(JSON.stringify({ passed: true }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('rejects passes when async fn rejects', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			await assert.rejects(async () => {
				throw new Error('rejected')
			})
			console.log(JSON.stringify({ passed: true }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('rejects accepts a thenable directly (not a function)', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			await assert.rejects(Promise.reject(new Error('rejected')), /rejected/)
			console.log(JSON.stringify({ passed: true }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('rejects fails when promise resolves', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let threw = false
			try {
				await assert.rejects(async () => { return 'ok' })
			} catch (e) {
				threw = e.name === 'AssertionError' && e.message.includes('Missing expected rejection')
			}
			console.log(JSON.stringify({ threw }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	test('rejects with RegExp validates error message', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			await assert.rejects(async () => {
				throw new Error('detailed rejection message')
			}, /rejection/)
			console.log(JSON.stringify({ passed: true }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('rejects with RegExp fails on mismatch', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let threw = false
			try {
				await assert.rejects(async () => {
					throw new Error('actual')
				}, /expected/)
			} catch (e) {
				threw = e.name === 'AssertionError'
			}
			console.log(JSON.stringify({ threw }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	test('rejects with Error constructor validates instanceof', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			await assert.rejects(async () => {
				throw new TypeError('wrong type')
			}, TypeError)
			console.log(JSON.stringify({ passed: true }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('rejects with object validates properties', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			await assert.rejects(async () => {
				const err = new Error('boom')
				err.code = 'ERR_X'
				throw err
			}, { code: 'ERR_X', message: /boom/ })
			console.log(JSON.stringify({ passed: true }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('rejects with predicate validator calls function with the rejected error', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let sawCode = false
			await assert.rejects(async () => {
				const err = new Error('coded')
				err.code = 'ERR_TEST'
				throw err
			}, (err) => {
				sawCode = err?.code === 'ERR_TEST'
				return sawCode
			})
			console.log(JSON.stringify({ sawCode }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { sawCode: true })
	})

	test('rejects with predicate validator fails unless it returns true', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let threw = false
			try {
				await assert.rejects(async () => {
					throw new Error('coded')
				}, () => 'truthy')
			} catch (e) {
				threw = e.name === 'AssertionError'
			}
			console.log(JSON.stringify({ threw }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	test('rejects throws TypeError when fn returns non-promise', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let threw = false
			try {
				await assert.rejects(() => 42)
			} catch (e) {
				threw = e instanceof TypeError
			}
			console.log(JSON.stringify({ threw }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	test('doesNotReject with predicate validator fails only when it matches', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			const rejectCoded = async () => {
				const err = new Error('coded')
				err.code = 'ERR_TEST'
				throw err
			}
			let matched = false
			let rethrew = false
			try {
				await assert.doesNotReject(rejectCoded, (err) => err?.code === 'ERR_TEST')
			} catch (e) {
				matched = e.name === 'AssertionError'
			}
			try {
				await assert.doesNotReject(rejectCoded, (err) => err?.code === 'OTHER')
			} catch (e) {
				rethrew = e.code === 'ERR_TEST'
			}
			console.log(JSON.stringify({ matched, rethrew }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { matched: true, rethrew: true })
	})

	test('doesNotReject passes when promise resolves', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			await assert.doesNotReject(async () => { return 'ok' })
			console.log(JSON.stringify({ passed: true }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})

	test('doesNotReject fails when promise rejects', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert'
			let threw = false
			try {
				await assert.doesNotReject(async () => { throw new Error('oops') })
			} catch (e) {
				threw = e.message.includes('unwanted rejection')
			}
			console.log(JSON.stringify({ threw }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})
})

describe('node:assert/strict shim', () => {
	test('default import works and aliases equal to strictEqual', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import assert from 'node:assert/strict'
			assert.equal(1, 1)
			assert.strictEqual('a', 'a')
			assert.deepEqual({ a: 1 }, { a: 1 })
			let threw = false
			try { assert.equal(1, '1') } catch (e) { threw = e.name === 'AssertionError' }
			console.log(JSON.stringify({ threw, equalIsStrict: assert.equal === assert.strictEqual }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true, equalIsStrict: true })
	})

	test('named exports are available', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { strictEqual, deepStrictEqual, ok, equal, throws } from 'node:assert/strict'
			ok(true)
			strictEqual(2, 2)
			deepStrictEqual([1, 2], [1, 2])
			equal('x', 'x')
			throws(() => { throw new Error('boom') }, /boom/)
			console.log(JSON.stringify({ passed: true }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { passed: true })
	})
})
