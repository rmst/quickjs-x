import { describe, test } from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mktempdir, QN } from './util.js'

/**
 * Regression tests for the qn_vm_free shutdown path. Programs that exit
 * naturally with unref'd libuv handles (timers, fs.watch, signal handlers)
 * used to trigger `uv_loop_close` returning UV_EBUSY → abort().
 */

const runScript = (src) => {
	const dir = mktempdir()
	const file = `${dir}/test.js`
	writeFileSync(file, src)
	const r = spawnSync(QN(), [file], { encoding: 'utf8' })
	return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), status: r.status, signal: r.signal }
}

describe('clean shutdown with leftover unref\'d handles', () => {
	test('unref\'d setInterval does not abort on exit', () => {
		const r = runScript(`
			const t = setInterval(() => {}, 1_000_000)
			t.unref()
			console.log('done')
		`)
		assert.strictEqual(r.signal, null, `process killed by ${r.signal}: ${r.stderr}`)
		assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`)
		assert.strictEqual(r.stdout, 'done')
		assert.strictEqual(r.stderr, '')
	})

	test('unref\'d fs.watch does not abort on exit', () => {
		const r = runScript(`
			import('node:fs').then(fs => {
				const w = fs.watch('/tmp', () => {})
				w.unref()
				console.log('done')
			})
		`)
		assert.strictEqual(r.signal, null, `process killed by ${r.signal}: ${r.stderr}`)
		assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`)
		assert.strictEqual(r.stdout, 'done')
		assert.strictEqual(r.stderr, '')
	})

	test('signal handler does not abort on exit', () => {
		const r = runScript(`
			process.on('SIGUSR1', () => {})
			console.log('done')
		`)
		assert.strictEqual(r.signal, null, `process killed by ${r.signal}: ${r.stderr}`)
		assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`)
		assert.strictEqual(r.stdout, 'done')
		assert.strictEqual(r.stderr, '')
	})

	test('combination of unref\'d handles does not abort', () => {
		const r = runScript(`
			import('node:fs').then(fs => {
				const t = setInterval(() => {}, 1_000_000); t.unref()
				const w = fs.watch('/tmp', () => {}); w.unref()
				process.on('SIGUSR1', () => {})
				for (let i = 0; i < 20; i++) {
					const x = setInterval(() => {}, 1_000_000); x.unref()
				}
				console.log('done')
			})
		`)
		assert.strictEqual(r.signal, null, `process killed by ${r.signal}: ${r.stderr}`)
		assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`)
		assert.strictEqual(r.stdout, 'done')
		assert.strictEqual(r.stderr, '')
	})
})
