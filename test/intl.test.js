import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, $ } from './util.js'

describe('Intl.Segmenter (grapheme)', () => {
	test('iterates ASCII as single graphemes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
			const out = [...seg.segment('hello')].map(s => s.segment)
			console.log(JSON.stringify(out))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), ['h', 'e', 'l', 'l', 'o'])
	})

	test('joins combining marks with their base', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
			// 'e' + combining acute = decomposed é (one grapheme, two codepoints)
			const out = [...seg.segment('e\\u0301')].map(s => ({
				len: s.segment.length, codepoints: [...s.segment].length
			}))
			console.log(JSON.stringify(out))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), [{ len: 2, codepoints: 2 }])
	})

	test('joins variation selector (VS16) with base emoji', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
			// ❤ + VS16 = ❤️ as a single grapheme
			const out = [...seg.segment('\\u2764\\uFE0F')].map(s => s.segment)
			console.log(JSON.stringify({ count: out.length }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 1 })
	})

	test('joins ZWJ-emoji sequence (family)', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
			const family = '👨\\u200D👩\\u200D👧'
			const out = [...seg.segment(family)].map(s => s.segment)
			console.log(JSON.stringify({ count: out.length, raw: out[0] }))
		`)
		const output = $`${bin} ${dir}/test.js`
		const parsed = JSON.parse(output)
		assert.strictEqual(parsed.count, 1)
	})

	test('pairs regional indicators into a flag', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
			// 🇺🇸 = U+1F1FA U+1F1F8 (two regional indicators = one grapheme)
			const out = [...seg.segment('\\u{1F1FA}\\u{1F1F8}')].map(s => s.segment)
			console.log(JSON.stringify({ count: out.length }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 1 })
	})

	test('reports correct index for each segment', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
			const out = [...seg.segment('ab😀c')].map(s => ({ s: s.segment, i: s.index }))
			console.log(JSON.stringify(out))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), [
			{ s: 'a', i: 0 },
			{ s: 'b', i: 1 },
			{ s: '😀', i: 2 },
			{ s: 'c', i: 4 },
		])
	})

	test('containing() returns segment at byte index', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
			const segs = seg.segment('ab👍cd')
			const r = segs.containing(2)
			console.log(JSON.stringify({ segment: r.segment, index: r.index }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { segment: '👍', index: 2 })
	})

	test('handles empty string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
			const out = [...seg.segment('')]
			console.log(JSON.stringify({ count: out.length }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 0 })
	})
})
