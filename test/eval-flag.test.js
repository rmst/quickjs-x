import { describe, test } from 'node:test'
import assert from 'node:assert'
import { QN, QX, $ } from './util.js'

describe('-e flag', () => {
	test('qn -e evaluates code', () => {
		const output = $`${QN()} -e "console.log(1+2)"`
		assert.strictEqual(output, '3')
	})

	test('qn -e has access to globals', () => {
		const output = $`${QN()} -e "console.log(typeof console.log)"`
		assert.strictEqual(output, 'function')
	})

	test('qn -e with empty string exits cleanly', () => {
		const output = $`${QN()} -e ""`
		assert.strictEqual(output, '')
	})

	test('qx -e evaluates code', () => {
		const output = $`${QX()} -e "console.log(1+2)"`
		assert.strictEqual(output, '3')
	})

	test('qx -e has access to $ global', () => {
		const output = $`${QX()} -e "console.log(typeof $)"`
		assert.strictEqual(output, 'function')
	})

	test('qx -e with empty string exits cleanly', () => {
		const output = $`${QX()} -e ""`
		assert.strictEqual(output, '')
	})

	test('qn -e supports top-level import', () => {
		const output = $`${QN()} -e 'import { readFileSync } from "node:fs"; console.log(typeof readFileSync)'`
		assert.strictEqual(output, 'function')
	})

	test('qn -e supports top-level await in module mode', () => {
		const output = $`${QN()} -e 'import "node:fs"; await new Promise(r => setTimeout(r, 1)); console.log("done")'`
		assert.strictEqual(output, 'done')
	})

	test('qn -e supports top-level export', () => {
		const output = $`${QN()} -e 'export const x = 1; console.log("ok")'`
		assert.strictEqual(output, 'ok')
	})

	test('qn -e dynamic import stays in script mode', () => {
		// Confirms detection excludes import(...) — non-strict-mode this would
		// behave differently if we erroneously switched to module.
		const output = $`${QN()} -e 'import("node:os").then(o => console.log(typeof o.cpus))'`
		assert.strictEqual(output, 'function')
	})

	test('qx -e supports top-level import', () => {
		const output = $`${QX()} -e 'import { readFileSync } from "node:fs"; console.log(typeof readFileSync)'`
		assert.strictEqual(output, 'function')
	})
})
