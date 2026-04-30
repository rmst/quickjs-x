import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

describe('dynamic import error handling', () => {
	test('catching dynamic import of sync-throwing module exits cleanly', ({ bin, dir }) => {
		writeFileSync(`${dir}/thrower.mjs`, `throw new Error("boom")\n`)
		writeFileSync(`${dir}/main.mjs`, `
			try {
				await import('./thrower.mjs')
			} catch (e) {
				console.log('caught:' + e.message)
			}
			console.log('after')
		`)
		const out = $`${bin} ${dir}/main.mjs`
		assert.strictEqual(out, 'caught:boom\nafter')
	})
})

describe('node:module shim', () => {
	test('stripTypeScriptTypes strips type annotations preserving positions', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const x: number = 42'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.strictEqual(output, 'const x         = 42')
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes strips interfaces', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'interface Foo { bar: string }'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.ok(!output.includes('interface'))
		assert.strictEqual(output.trim(), '')
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes strips generics preserving positions', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'function identity<T>(x: T): T { return x }'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.strictEqual(output, 'function identity   (x   )    { return x }')
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes preserves line count on multiline input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'interface Foo {\\n  bar: string\\n  baz: number\\n}'
			const output = stripTypeScriptTypes(input)
			const inputLines = input.split('\\n').length
			const outputLines = output.split('\\n').length
			console.log(JSON.stringify({ inputLines, outputLines, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { inputLines, outputLines, lenMatch } = JSON.parse(result)
		assert.strictEqual(inputLines, outputLines)
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes blanks import type', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'import type { Foo } from "bar"'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.strictEqual(output.trim(), '')
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes throws on enum in strip mode', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			try {
				stripTypeScriptTypes('enum Color { Red, Green, Blue }')
				console.log(JSON.stringify({ threw: false }))
			} catch (e) {
				console.log(JSON.stringify({ threw: true, isSyntax: e instanceof SyntaxError }))
			}
		`)

		const result = $`${bin} ${dir}/test.js`
		const { threw, isSyntax } = JSON.parse(result)
		assert.strictEqual(threw, true)
		assert.strictEqual(isSyntax, true)
	})

	testQnOnly('stripTypeScriptTypes transform mode handles enums', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const output = stripTypeScriptTypes('enum Color { Red, Green, Blue }', { mode: 'transform' })
			console.log(JSON.stringify({ output }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output } = JSON.parse(result)
		assert.ok(output.includes('Color'))
		assert.ok(!output.includes('enum'))
	})

	test('stripTypeScriptTypes strips as expression', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const x = y as string'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.strictEqual(output, 'const x = y          ')
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes strips satisfies expression', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const x = y satisfies string'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.strictEqual(output, 'const x = y                 ')
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes handles export type without from clause', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'export type { Foo }\\nexport { Bar } from "baz"'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.ok(output.includes('export { Bar }'))
		assert.ok(!output.includes('Foo'))
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes preserves string contents with type keywords', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const x = "interface Foo { bar: string }"'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output } = JSON.parse(result)
		assert.strictEqual(output, 'const x = "interface Foo { bar: string }"')
	})

	test('stripTypeScriptTypes handles empty input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const output = stripTypeScriptTypes('')
			console.log(JSON.stringify({ output }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output } = JSON.parse(result)
		assert.strictEqual(output, '')
	})

	test('stripTypeScriptTypes handles pure JS unchanged', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const x = 42\\nfunction foo() { return x }'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output } = JSON.parse(result)
		assert.strictEqual(output, 'const x = 42\nfunction foo() { return x }')
	})

	test('stripTypeScriptTypes handles nested generics', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const x: Map<string, Array<number>> = new Map()'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.ok(output.includes('= new Map()'))
		assert.ok(!output.includes('Map<'))
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes handles complex multiline function', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'function f(\\n  x: number,\\n  y: string\\n): boolean {\\n  return true\\n}'
			const output = stripTypeScriptTypes(input)
			const inputLines = input.split('\\n').length
			const outputLines = output.split('\\n').length
			console.log(JSON.stringify({ inputLines, outputLines, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { inputLines, outputLines, lenMatch } = JSON.parse(result)
		assert.strictEqual(inputLines, outputLines)
		assert.strictEqual(lenMatch, true)
	})

	testQnOnly('stripTypeScriptTypes throws on multi-line arrow return type (cannot blank)', ({ bin, dir }) => {
		// Blanking would leave a LineTerminator between `)` and `=>`, which the
		// JS grammar forbids. Strip mode cannot preserve positions here — it
		// must throw so the caller can fall back to transform mode.
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const f = (x: number): Foo<\\n  Bar\\n> => x'
			try {
				stripTypeScriptTypes(input)
				console.log(JSON.stringify({ threw: false }))
			} catch (e) {
				console.log(JSON.stringify({ threw: true, isSyntax: e instanceof SyntaxError }))
			}
		`)

		const result = $`${bin} ${dir}/test.js`
		const { threw, isSyntax } = JSON.parse(result)
		assert.strictEqual(threw, true)
		assert.strictEqual(isSyntax, true)
	})

	testQnOnly('loads .ts file with multi-line arrow return type via transform fallback', ({ bin, dir }) => {
		// Bootstrap catches the strip-mode throw and retries with transform mode.
		writeFileSync(`${dir}/script.ts`, 'type Foo<T> = T\nconst f = (x: number): Foo<\n\tnumber\n> => x * 2\nconsole.log(f(21))\n')
		const out = $`${bin} ${dir}/script.ts`.trim()
		assert.strictEqual(out, '42')
	})

	testQnOnly('stripTypeScriptTypes throws on value namespace in strip mode', ({ bin, dir }) => {
		// `namespace N { export const x = 42 }` has runtime effect; neither strip
		// (blanks it entirely) nor Sucrase's transform (drops it) can emit
		// working code, so we reject up front with a clear message.
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'namespace N { export const x = 42 }\\nconsole.log(N.x)'
			try {
				stripTypeScriptTypes(input)
				console.log(JSON.stringify({ threw: false }))
			} catch (e) {
				console.log(JSON.stringify({ threw: true, isSyntax: e instanceof SyntaxError, msg: e.message }))
			}
		`)

		const result = $`${bin} ${dir}/test.js`
		const { threw, isSyntax, msg } = JSON.parse(result)
		assert.strictEqual(threw, true)
		assert.strictEqual(isSyntax, true)
		assert.ok(/namespace/i.test(msg), `message should mention namespace, got: ${msg}`)
	})

	testQnOnly('stripTypeScriptTypes throws on value namespace in transform mode too', ({ bin, dir }) => {
		// Sucrase silently drops namespaces in transform mode too — detect and
		// throw so the user gets a clear error instead of a runtime ReferenceError.
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'namespace N { export const x = 42 }\\nconsole.log(N.x)'
			try {
				stripTypeScriptTypes(input, { mode: 'transform' })
				console.log(JSON.stringify({ threw: false }))
			} catch (e) {
				console.log(JSON.stringify({ threw: true, isSyntax: e instanceof SyntaxError }))
			}
		`)

		const result = $`${bin} ${dir}/test.js`
		const { threw, isSyntax } = JSON.parse(result)
		assert.strictEqual(threw, true)
		assert.strictEqual(isSyntax, true)
	})

	testQnOnly('stripTypeScriptTypes erases declare namespace (type-only)', ({ bin, dir }) => {
		// `declare namespace` is type-only per TS spec — safely erasable.
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'declare namespace N { const x: number }\\nconst y = 1'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ lenMatch: input.length === output.length, hasY: output.includes('const y = 1') }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { lenMatch, hasY } = JSON.parse(result)
		assert.strictEqual(lenMatch, true)
		assert.strictEqual(hasY, true)
	})

	test('stripTypeScriptTypes strips declare statement', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'declare const x: number'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.strictEqual(output.trim(), '')
		assert.strictEqual(lenMatch, true)
	})
})
