import { describe, it } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { spawn as spawnPty } from 'qn:pty'
import { test, testQnOnly, $, QN } from './util.js'

/* Wait until `pred()` returns truthy, polling every 10ms. */
function waitFor(pred, timeout = 2000) {
	return new Promise((resolve, reject) => {
		let elapsed = 0
		const tick = () => {
			if (pred()) return resolve()
			elapsed += 10
			if (elapsed >= timeout) return reject(new Error('waitFor timed out'))
			setTimeout(tick, 10)
		}
		tick()
	})
}

/**
 * Run a child qn process inside a PTY so the script sees stdin/stdout as TTYs.
 * Returns a promise that resolves to the captured stdout once the process exits.
 */
function runInPty(script, opts = {}) {
	return new Promise((resolve, reject) => {
		const pty = spawnPty(QN(), ['-e', script], {
			cols: opts.cols ?? 80,
			rows: opts.rows ?? 24,
			env: opts.env,
		})
		let out = ''
		pty.onData((d) => { out += d })
		const timer = setTimeout(() => {
			pty.kill()
			reject(new Error(`PTY child timed out\nGot: ${JSON.stringify(out)}`))
		}, opts.timeout ?? 4000)
		pty.onExit(({ exitCode }) => {
			clearTimeout(timer)
			if (exitCode !== 0) reject(new Error(`PTY child exited ${exitCode}\nGot: ${out}`))
			else resolve(out)
		})
		if (opts.input) pty.write(opts.input)
	})
}

describe('node:tty (cross-runtime)', () => {
	test('isatty(fd) reports false for piped stdin', ({ bin, dir }) => {
		writeFileSync(`${dir}/t.js`, `
			import { isatty } from 'node:tty'
			import process from 'node:process'
			console.log(JSON.stringify({
				stdin: isatty(0),
				stdout: isatty(1),
				stderr: isatty(2),
				bogus: isatty(99),
			}))
		`)
		/* When run through execSync, all three fds are pipes */
		const out = $`${bin} ${dir}/t.js`
		assert.deepStrictEqual(JSON.parse(out), {
			stdin: false, stdout: false, stderr: false, bogus: false,
		})
	})

	test('process.stdin reads from a redirected regular file', ({ bin, dir }) => {
		writeFileSync(`${dir}/in.txt`, 'first line\nsecond line\n')
		writeFileSync(`${dir}/t.js`, `
			process.stdin.setEncoding('utf8')
			let acc = ''
			process.stdin.on('data', (d) => acc += d)
			process.stdin.on('end', () => console.log(JSON.stringify(acc)))
		`)
		const out = $`${bin} ${dir}/t.js < ${dir}/in.txt`
		assert.strictEqual(JSON.parse(out), 'first line\nsecond line\n')
	})

	test('process.stdin emits piped data and end', ({ bin, dir }) => {
		writeFileSync(`${dir}/t.js`, `
			let chunks = []
			process.stdin.setEncoding('utf8')
			process.stdin.on('data', (d) => chunks.push(d))
			process.stdin.on('end', () => {
				console.log(JSON.stringify({ joined: chunks.join('') }))
			})
		`)
		const out = $`echo 'hello there' | ${bin} ${dir}/t.js`
		assert.deepStrictEqual(JSON.parse(out), { joined: 'hello there\n' })
	})

	test('process.stdin emits Buffer chunks without setEncoding', ({ bin, dir }) => {
		writeFileSync(`${dir}/t.js`, `
			import { Buffer } from 'node:buffer'
			let bufs = []
			process.stdin.on('data', (d) => {
				bufs.push({ isBuffer: Buffer.isBuffer(d), bytes: Array.from(d) })
			})
			process.stdin.on('end', () => console.log(JSON.stringify(bufs)))
		`)
		const out = $`printf 'hi' | ${bin} ${dir}/t.js`
		const parsed = JSON.parse(out)
		assert.strictEqual(parsed.length, 1)
		assert.strictEqual(parsed[0].isBuffer, true)
		assert.deepStrictEqual(parsed[0].bytes, [104, 105]) // 'h', 'i'
	})

	test('removing the last data listener pauses stdin (no auto-exit hang)', ({ bin, dir }) => {
		/* Without auto-pause when the last listener is removed, the script
		 * would hang because stdin keeps the event loop alive. */
		writeFileSync(`${dir}/t.js`, `
			let saw = false
			let h = (d) => {
				saw = true
				process.stdin.off('data', h)
				console.log('done', d.length)
			}
			process.stdin.on('data', h)
		`)
		const out = $`printf 'abc' | ${bin} ${dir}/t.js`
		assert.strictEqual(out, 'done 3')
	})

	test('process.stdout exposes write and isTTY', ({ bin, dir }) => {
		writeFileSync(`${dir}/t.js`, `
			console.log(JSON.stringify({
				hasWrite: typeof process.stdout.write === 'function',
				/* Node sets isTTY=undefined on non-TTYs (truthy when TTY) */
				isTTYTruthy: !!process.stdout.isTTY,
			}))
		`)
		const out = $`${bin} ${dir}/t.js`
		assert.deepStrictEqual(JSON.parse(out), {
			hasWrite: true,
			isTTYTruthy: false, // execSync uses pipes
		})
	})

	test('process.stdout.write returns true', ({ bin, dir }) => {
		writeFileSync(`${dir}/t.js`, `
			let r = process.stdout.write('hello\\n')
			process.stdout.write('[ret=' + r + ']')
		`)
		const out = $`${bin} ${dir}/t.js`
		assert.strictEqual(out, 'hello\n[ret=true]')
	})

	test('SIGWINCH event fires', ({ bin, dir }) => {
		writeFileSync(`${dir}/t.js`, `
			process.on('SIGWINCH', () => {
				console.log('winch')
				process.exit(0)
			})
			process.kill(process.pid, 'SIGWINCH')
			setTimeout(() => process.exit(1), 1000)
		`)
		const out = $`${bin} ${dir}/t.js`
		assert.strictEqual(out, 'winch')
	})
})

describe('node:tty TTY behavior (qn-only via PTY)', () => {

	it('reports isTTY=true when running in a PTY', async () => {
		const out = await runInPty(`
			console.log(JSON.stringify({
				stdin: process.stdin.isTTY,
				stdout: process.stdout.isTTY,
				stderr: process.stderr.isTTY,
			}))
		`)
		const parsed = JSON.parse(out.trim())
		assert.strictEqual(parsed.stdin, true)
		assert.strictEqual(parsed.stdout, true)
		assert.strictEqual(parsed.stderr, true)
	})

	it('reports correct columns/rows from the PTY size', async () => {
		const out = await runInPty(`
			console.log(JSON.stringify({
				cols: process.stdout.columns,
				rows: process.stdout.rows,
				ws: process.stdout.getWindowSize(),
			}))
		`, { cols: 137, rows: 41 })
		const parsed = JSON.parse(out.trim())
		assert.strictEqual(parsed.cols, 137)
		assert.strictEqual(parsed.rows, 41)
		assert.deepStrictEqual(parsed.ws, [137, 41])
	})

	it('setRawMode(true) toggles isRaw, setRawMode(false) clears it', async () => {
		const out = await runInPty(`
			process.stdin.setRawMode(true)
			console.log('a:', process.stdin.isRaw)
			process.stdin.setRawMode(false)
			console.log('b:', process.stdin.isRaw)
		`)
		assert.match(out, /a: true/)
		assert.match(out, /b: false/)
	})

	it('reads keystrokes from stdin in raw mode', async () => {
		const out = await runInPty(`
			process.stdin.setRawMode(true)
			process.stdin.setEncoding('utf8')
			let acc = ''
			process.stdin.on('data', (d) => {
				acc += d
				if (acc.length >= 3) {
					process.stdin.setRawMode(false)
					console.log('GOT=' + JSON.stringify(acc))
					process.exit(0)
				}
			})
		`, { input: 'abc' })
		assert.match(out, /GOT="abc"/)
	})

	it('getColorDepth respects TERM=xterm-256color', async () => {
		const out = await runInPty(`
			console.log('depth=' + process.stdout.getColorDepth())
		`, { env: { TERM: 'xterm-256color' } })
		assert.match(out, /depth=8/)
	})

	it('getColorDepth returns 1 for TERM=dumb', async () => {
		const out = await runInPty(`
			console.log('depth=' + process.stdout.getColorDepth())
		`, { env: { TERM: 'dumb' } })
		assert.match(out, /depth=1/)
	})

	it('terminal mode is reset after process.exit() while in raw mode', async () => {
		/* Spawn a child that sets raw mode and then process.exit(0)s.
		 * After it exits, run `stty -a` in the same PTY: the line should
		 * include "icanon" (canonical/cooked mode), proving that raw mode
		 * was reset. Without our exit hook the next stty would show -icanon. */
		return new Promise((resolve, reject) => {
			const pty = spawnPty('/bin/sh', ['-c',
				`${QN()} -e 'process.stdin.setRawMode(true); process.stdout.write("RAW\\n"); process.exit(0)' && stty -a; echo END`,
			], { cols: 80, rows: 24 })
			let out = ''
			pty.onData((d) => { out += d })
			const timer = setTimeout(() => {
				pty.kill()
				reject(new Error(`timeout. Got: ${JSON.stringify(out)}`))
			}, 4000)
			pty.onExit(() => {
				clearTimeout(timer)
				try {
					assert.match(out, /RAW/, 'child should have run')
					assert.match(out, /END/, 'stty should have completed')
					/* In cooked mode, stty reports "icanon"; in raw mode "-icanon" */
					assert.match(out, /\bicanon\b/, 'terminal should be in cooked mode after child exit')
					assert.doesNotMatch(out, /-icanon/, 'terminal should NOT be in raw mode')
					resolve()
				} catch (e) {
					reject(e)
				}
			})
		})
	})
})

describe('node:tty exposes the documented surface (qn-specific)', () => {
	testQnOnly('exports isatty, ReadStream, WriteStream', async ({ bin, dir }) => {
		writeFileSync(`${dir}/t.js`, `
			import * as tty from 'node:tty'
			console.log(JSON.stringify({
				isatty: typeof tty.isatty,
				ReadStream: typeof tty.ReadStream,
				WriteStream: typeof tty.WriteStream,
				stdinIsReadStream: process.stdin instanceof tty.ReadStream,
				stdoutIsWriteStream: process.stdout instanceof tty.WriteStream,
			}))
		`)
		const out = $`${bin} ${dir}/t.js`
		assert.deepStrictEqual(JSON.parse(out), {
			isatty: 'function',
			ReadStream: 'function',
			WriteStream: 'function',
			stdinIsReadStream: true,
			stdoutIsWriteStream: true,
		})
	})

	testQnOnly('setRawMode on a non-TTY stdin returns this without throwing', ({ bin, dir }) => {
		writeFileSync(`${dir}/t.js`, `
			console.log('isTTY:', process.stdin.isTTY)
			let result = process.stdin.setRawMode(true)
			console.log('returned self:', result === process.stdin)
			console.log('isRaw:', process.stdin.isRaw)
		`)
		const out = $`${bin} ${dir}/t.js`
		assert.match(out, /isTTY: undefined/)
		assert.match(out, /returned self: true/)
		assert.match(out, /isRaw: false/)
	})

	testQnOnly('process.stdout.getWindowSize returns null on a pipe', ({ bin, dir }) => {
		writeFileSync(`${dir}/t.js`, `
			console.log(JSON.stringify(process.stdout.getWindowSize()))
		`)
		const out = $`${bin} ${dir}/t.js`
		assert.strictEqual(out, 'null')
	})
})
