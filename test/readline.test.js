import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { test, testQnOnly } from './util.js'

const stdinScript = (body) =>
	`import { createInterface } from 'node:readline'\n` + body

describe('node:readline (line mode)', () => {
	test('emits line events for each \\n-terminated line on stdin', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, stdinScript(`
			const rl = createInterface({ input: process.stdin })
			rl.on('line', (l) => console.log('LINE ' + l))
			rl.on('close', () => console.log('CLOSE'))
		`))
		const out = execSync(`printf 'one\\ntwo\\nthree\\n' | ${bin} ${dir}/test.js`,
			{ encoding: 'utf8', shell: '/bin/sh' })
		assert.strictEqual(out, 'LINE one\nLINE two\nLINE three\nCLOSE\n')
	})

	test('handles trailing line without final newline', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, stdinScript(`
			const rl = createInterface({ input: process.stdin })
			const lines = []
			rl.on('line', (l) => lines.push(l))
			rl.on('close', () => console.log(JSON.stringify(lines)))
		`))
		const out = execSync(`printf 'a\\nb\\nc' | ${bin} ${dir}/test.js`,
			{ encoding: 'utf8', shell: '/bin/sh' })
		assert.deepStrictEqual(JSON.parse(out.trim()), ['a', 'b', 'c'])
	})

	test('strips trailing \\r from CRLF lines', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, stdinScript(`
			const rl = createInterface({ input: process.stdin })
			const lines = []
			rl.on('line', (l) => lines.push(l))
			rl.on('close', () => console.log(JSON.stringify(lines)))
		`))
		const out = execSync(`printf 'one\\r\\ntwo\\r\\n' | ${bin} ${dir}/test.js`,
			{ encoding: 'utf8', shell: '/bin/sh' })
		assert.deepStrictEqual(JSON.parse(out.trim()), ['one', 'two'])
	})

	test('question reads one line and writes prompt to output', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, stdinScript(`
			const rl = createInterface({ input: process.stdin, output: process.stdout })
			rl.question('Name? ', (answer) => {
				console.log('GOT:' + answer)
				rl.close()
			})
		`))
		const out = execSync(`printf 'Bob\\n' | ${bin} ${dir}/test.js`,
			{ encoding: 'utf8', shell: '/bin/sh' })
		assert.strictEqual(out, 'Name? GOT:Bob\n')
	})

	test('async iteration yields lines in order', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, stdinScript(`
			const rl = createInterface({ input: process.stdin })
			for await (const line of rl) console.log('Y:' + line)
			console.log('END')
		`))
		const out = execSync(`printf 'a\\nb\\nc\\n' | ${bin} ${dir}/test.js`,
			{ encoding: 'utf8', shell: '/bin/sh' })
		assert.strictEqual(out, 'Y:a\nY:b\nY:c\nEND\n')
	})

	test('readline/promises question returns a Promise', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createInterface } from 'node:readline/promises'
			const rl = createInterface({ input: process.stdin, output: process.stdout })
			const x = await rl.question('? ')
			console.log('answer=' + x)
			rl.close()
		`)
		const out = execSync(`printf 'foo\\n' | ${bin} ${dir}/test.js`,
			{ encoding: 'utf8', shell: '/bin/sh' })
		assert.strictEqual(out, '? answer=foo\n')
	})

	test('accepts a Readable stream as input (not just process.stdin)', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createInterface } from 'node:readline'
			import { execFile } from 'node:child_process'
			const child = execFile('printf', ['x\\ny\\nz\\n'])
			const rl = createInterface({ input: child.stdout })
			const lines = []
			rl.on('line', (l) => lines.push(l))
			rl.on('close', () => console.log(JSON.stringify(lines)))
		`)
		const out = execSync(`${bin} ${dir}/test.js`, { encoding: 'utf8' })
		assert.deepStrictEqual(JSON.parse(out.trim()), ['x', 'y', 'z'])
	})

	test('pause/resume return self for chaining', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, stdinScript(`
			const rl = createInterface({ input: process.stdin })
			const a = rl.pause()
			const b = rl.resume()
			console.log(JSON.stringify({ pauseSelf: a === rl, resumeSelf: b === rl }))
			rl.close()
		`))
		const out = execSync(`echo "" | ${bin} ${dir}/test.js`,
			{ encoding: 'utf8', shell: '/bin/sh' })
		assert.deepStrictEqual(JSON.parse(out.trim()), { pauseSelf: true, resumeSelf: true })
	})

	test('reads from a regular file redirected onto stdin', ({ bin, dir }) => {
		writeFileSync(`${dir}/input.txt`, 'one\ntwo\nthree\n')
		writeFileSync(`${dir}/test.js`, stdinScript(`
			const rl = createInterface({ input: process.stdin })
			const lines = []
			rl.on('line', (l) => lines.push(l))
			rl.on('close', () => console.log(JSON.stringify(lines)))
		`))
		const out = execSync(`${bin} ${dir}/test.js < ${dir}/input.txt`,
			{ encoding: 'utf8', shell: '/bin/sh' })
		assert.deepStrictEqual(JSON.parse(out.trim()), ['one', 'two', 'three'])
	})

	test('handles multi-byte UTF-8 (é) read from stdin', ({ bin, dir }) => {
		// Use octal escapes — POSIX printf supports them on both GNU/BSD.
		// 0303 0251 = 0xC3 0xA9 = "é" in UTF-8.
		writeFileSync(`${dir}/test.js`, `
			import { createInterface } from 'node:readline'
			const rl = createInterface({ input: process.stdin })
			rl.on('line', (l) => console.log('L:' + l + ' len=' + l.length))
		`)
		const out = execSync(`printf 'h\\303\\251llo\\n' | ${bin} ${dir}/test.js`,
			{ encoding: 'utf8', shell: '/bin/sh' }).trim()
		assert.strictEqual(out, 'L:héllo len=5')
	})

	testQnOnly('terminal:true is rejected (raw-mode editing not implemented)', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createInterface } from 'node:readline'
			try {
				createInterface({ input: process.stdin, output: process.stdout, terminal: true })
				console.log('NO_THROW')
			} catch (e) {
				console.log('THREW: ' + e.message)
			}
		`)
		const out = execSync(`${bin} ${dir}/test.js < /dev/null`,
			{ encoding: 'utf8', shell: '/bin/sh' }).trim()
		assert.match(out, /^THREW:.*not implemented/)
	})
})
