import { describe, test } from 'node:test'
import assert from 'node:assert'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QNC_PATH } from './util.js'

describe('qnc standalone (isolated from build dir)', () => {
	let dir
	let qnc

	test('setup: copy qnc to isolated temp dir', () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), 'qnc-standalone-')))
		qnc = join(dir, 'qnc')
		copyFileSync(QNC_PATH(), qnc)
	})

	test('compiles and runs hello world', () => {
		writeFileSync(join(dir, 'hello.js'), 'console.log("hello from standalone qnc")')
		execSync(`${qnc} -o ${join(dir, 'hello')} ${join(dir, 'hello.js')}`, { timeout: 120000 })
		const output = execSync(join(dir, 'hello'), { encoding: 'utf8' }).trim()
		assert.strictEqual(output, 'hello from standalone qnc')
	})

	test('compiles module with imports', () => {
		writeFileSync(join(dir, 'lib.js'), 'export const greet = (name) => `hi ${name}`')
		writeFileSync(join(dir, 'main.js'), `
			import { greet } from './lib.js'
			console.log(greet('world'))
		`)
		execSync(`${qnc} -o ${join(dir, 'app')} ${join(dir, 'main.js')}`, { timeout: 120000 })
		const output = execSync(join(dir, 'app'), { encoding: 'utf8' }).trim()
		assert.strictEqual(output, 'hi world')
	})

	test('cleanup', () => {
		rmSync(dir, { recursive: true, force: true })
	})
})
