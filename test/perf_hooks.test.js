import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, $ } from './util.js'

describe('node:perf_hooks', () => {
	test('performance.now returns a positive number', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { performance } from 'node:perf_hooks'
			console.log(JSON.stringify({
				type: typeof performance.now(),
				positive: performance.now() > 0,
			}))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), { type: 'number', positive: true })
	})

	test('performance.timeOrigin + now ≈ Date.now', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { performance } from 'node:perf_hooks'
			const diff = Math.abs(Date.now() - (performance.timeOrigin + performance.now()))
			console.log(JSON.stringify({ originType: typeof performance.timeOrigin, ok: diff < 1000 }))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), { originType: 'number', ok: true })
	})

	test('mark/measure produce entries with expected shape', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { performance } from 'node:perf_hooks'
			performance.mark('a')
			await new Promise(r => setTimeout(r, 5))
			performance.mark('b')
			const m = performance.measure('ab', 'a', 'b')
			console.log(JSON.stringify({
				measureType: m.entryType,
				durationPositive: m.duration > 0,
				marks: performance.getEntriesByType('mark').length,
				measures: performance.getEntriesByType('measure').length,
				byNameA: performance.getEntriesByName('a').length,
			}))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), {
			measureType: 'measure', durationPositive: true,
			marks: 2, measures: 1, byNameA: 1,
		})
	})

	test('clearMarks and clearMeasures', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { performance } from 'node:perf_hooks'
			performance.mark('a')
			performance.mark('b')
			performance.measure('m', 'a')
			performance.clearMarks('a')
			const after1 = performance.getEntriesByType('mark').length
			performance.clearMarks()
			const after2 = performance.getEntriesByType('mark').length
			performance.clearMeasures()
			const after3 = performance.getEntriesByType('measure').length
			console.log(JSON.stringify({ after1, after2, after3 }))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), { after1: 1, after2: 0, after3: 0 })
	})

	test('PerformanceObserver constructs and observe/disconnect no-op', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { PerformanceObserver } from 'node:perf_hooks'
			const obs = new PerformanceObserver(() => {})
			obs.observe({ entryTypes: ['measure'] })
			obs.disconnect()
			console.log(JSON.stringify({
				takeRecords: Array.isArray(obs.takeRecords()),
				supported: PerformanceObserver.supportedEntryTypes.includes('mark'),
			}))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), { takeRecords: true, supported: true })
	})

	test('PerformanceObserver receives mark/measure entries', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { performance, PerformanceObserver } from 'node:perf_hooks'
			const seen = []
			const obs = new PerformanceObserver((list) => {
				for (const e of list.getEntries()) seen.push(e.name + ':' + e.entryType)
			})
			obs.observe({ entryTypes: ['mark', 'measure'] })
			performance.mark('a')
			performance.mark('b')
			performance.measure('ab', 'a', 'b')
			await new Promise(r => setTimeout(r, 10))
			obs.disconnect()
			console.log(JSON.stringify({
				gotMark: seen.includes('a:mark') && seen.includes('b:mark'),
				gotMeasure: seen.includes('ab:measure'),
				count: seen.length,
			}))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), {
			gotMark: true, gotMeasure: true, count: 3,
		})
	})

	test('performance.now is small (ms since process start)', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { performance } from 'node:perf_hooks'
			// At process start now() should be tiny — definitely under 60s
			console.log(JSON.stringify({ small: performance.now() < 60_000 }))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), { small: true })
	})

	test('measure throws when referenced mark does not exist', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { performance } from 'node:perf_hooks'
			let threw = false, msg = ''
			try { performance.measure('m', 'no-such-mark') } catch (e) { threw = true; msg = e.message }
			console.log(JSON.stringify({ threw, hasName: msg.includes('no-such-mark') }))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), { threw: true, hasName: true })
	})

	test('monitorEventLoopDelay returns histogram-shaped object', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { monitorEventLoopDelay } from 'node:perf_hooks'
			const h = monitorEventLoopDelay()
			h.enable()
			h.disable()
			console.log(JSON.stringify({
				hasEnable: typeof h.enable === 'function',
				hasPercentile: typeof h.percentile === 'function',
				hasMin: typeof h.min === 'number',
			}))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), {
			hasEnable: true, hasPercentile: true, hasMin: true,
		})
	})

	test('globalThis.performance matches node:perf_hooks performance', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { performance } from 'node:perf_hooks'
			console.log(JSON.stringify({
				sameNow: typeof globalThis.performance.now === 'function',
				originMatches: globalThis.performance.timeOrigin === performance.timeOrigin,
			}))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), {
			sameNow: true, originMatches: true,
		})
	})
})

describe('process.hrtime', () => {
	test('process.hrtime() returns [seconds, nanoseconds] tuple', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			const t = process.hrtime()
			console.log(JSON.stringify({
				isArray: Array.isArray(t),
				len: t.length,
				secType: typeof t[0],
				nsType: typeof t[1],
				nsInRange: t[1] >= 0 && t[1] < 1e9,
			}))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), {
			isArray: true, len: 2, secType: 'number', nsType: 'number', nsInRange: true,
		})
	})

	test('process.hrtime(prev) returns positive diff', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			const t = process.hrtime()
			// busy spin briefly to ensure measurable diff
			let x = 0
			for (let i = 0; i < 100000; i++) x += i
			const d = process.hrtime(t)
			const totalNs = d[0] * 1e9 + d[1]
			console.log(JSON.stringify({
				isArray: Array.isArray(d),
				len: d.length,
				positive: totalNs > 0,
				nsInRange: d[1] >= 0 && d[1] < 1e9,
				_x: x > 0,
			}))
		`)
		const r = JSON.parse($`${bin} ${dir}/test.js`)
		assert.strictEqual(r.isArray, true)
		assert.strictEqual(r.len, 2)
		assert.strictEqual(r.positive, true)
		assert.strictEqual(r.nsInRange, true)
	})

	test('process.hrtime.bigint() returns BigInt', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			const a = process.hrtime.bigint()
			const b = process.hrtime.bigint()
			console.log(JSON.stringify({
				type: typeof a,
				monotonic: b >= a,
			}))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), { type: 'bigint', monotonic: true })
	})

	test('process.hrtime throws TypeError for invalid arg', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			let threw = false
			try { process.hrtime(123) } catch (e) { threw = e instanceof TypeError }
			console.log(JSON.stringify({ threw }))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), { threw: true })
	})
})
