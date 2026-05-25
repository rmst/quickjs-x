import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test, testQnOnly, $ } from './util.js'

describe('node:process shim', () => {
	test('process.argv structure matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({
				length: process.argv.length,
				argv0Type: typeof process.argv[0],
				argv1: process.argv[1],
				argv2: process.argv[2],
				argv3: process.argv[3]
			}))
		`)

		const output = $`${bin} ${dir}/test.js arg1 arg2`
		const result = JSON.parse(output)

		// argv[0] = interpreter path, argv[1] = script path, argv[2+] = user args
		assert.strictEqual(result.length, 4)
		assert.strictEqual(result.argv0Type, 'string')
		assert.strictEqual(result.argv1, `${dir}/test.js`)
		assert.strictEqual(result.argv2, 'arg1')
		assert.strictEqual(result.argv3, 'arg2')
	})

	test('process.cwd matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ cwd: process.cwd() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		// cwd should be a non-empty string
		const result = JSON.parse(output)
		assert.strictEqual(typeof result.cwd, 'string')
		assert.ok(result.cwd.length > 0)
	})

	test('process.env reads environment variable', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ home: typeof process.env.HOME }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { home: 'string' })
	})

	test('process.env returns undefined for missing var', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			const val = process.env.DEFINITELY_NOT_SET_12345
			console.log(JSON.stringify({ isUndefined: val === undefined }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isUndefined: true })
	})

	test('process.pid is a number', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ pidType: typeof process.pid, isPositive: process.pid > 0 }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { pidType: 'number', isPositive: true })
	})

	test('process.execPath is an absolute path to the interpreter', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({
				execPath: process.execPath,
				isAbsolute: process.execPath.startsWith('/'),
				endsWithBin: /\\/[^/]+$/.test(process.execPath)
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(typeof result.execPath, 'string')
		assert.strictEqual(result.isAbsolute, true)
		assert.strictEqual(result.endsWithBin, true)
	})

	test('process.platform is a string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ platformType: typeof process.platform }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { platformType: 'string' })
	})

	test('process.version is a string starting with v', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ startsWithV: process.version.startsWith('v') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { startsWithV: true })
	})

	test('process.stdout.write works', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			process.stdout.write('direct output')
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'direct output')
	})

	test('named imports from process work', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { cwd, pid, platform, env } from 'node:process'
			console.log(JSON.stringify({
				cwdType: typeof cwd,
				pidType: typeof pid,
				platformType: typeof platform,
				envType: typeof env
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			cwdType: 'function',
			pidType: 'number',
			platformType: 'string',
			envType: 'object'
		})
	})

	test('process.umask gets, sets, and exports named function', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process, { umask } from 'node:process'

			const old = process.umask()
			try {
				const setFromNumberPrevious = process.umask(0o077)
				const afterNumber = process.umask()
				const setFromStringPrevious = umask('022')
				const afterString = umask()
				let invalidStringCode
				let invalidNumberCode

				try { process.umask('888') } catch (e) { invalidStringCode = e.code }
				try { process.umask(-1) } catch (e) { invalidNumberCode = e.code }

				console.log(JSON.stringify({
					functionType: typeof process.umask,
					namedFunctionType: typeof umask,
					setFromNumberPreviousType: typeof setFromNumberPrevious,
					afterNumber: afterNumber.toString(8),
					setFromStringPrevious: setFromStringPrevious.toString(8),
					afterString: afterString.toString(8),
					invalidStringCode,
					invalidNumberCode,
				}))
			} finally {
				process.umask(old)
			}
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			functionType: 'function',
			namedFunctionType: 'function',
			setFromNumberPreviousType: 'number',
			afterNumber: '77',
			setFromStringPrevious: '77',
			afterString: '22',
			invalidStringCode: 'ERR_INVALID_ARG_VALUE',
			invalidNumberCode: 'ERR_OUT_OF_RANGE',
		})
	})

	test('process.exitCode sets exit code', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			process.exitCode = 42
		`)

		const result = spawnSync(bin, [`${dir}/test.js`], { encoding: 'utf8' })
		assert.strictEqual(result.status, 42)
	})

	test('process.on exit handler is called', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			process.on('exit', (code) => {
				console.log('exit handler called with code ' + code)
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'exit handler called with code 0')
	})

	test('process.on exit handler receives exitCode', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			process.on('exit', (code) => {
				console.log('exit code: ' + code)
			})
			process.exitCode = 7
		`)

		const result = spawnSync(bin, [`${dir}/test.js`], { encoding: 'utf8' })
		assert.strictEqual(result.status, 7)
		assert.strictEqual(result.stdout.trim(), 'exit code: 7')
	})

	test('process.kill sends signal to process', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			import { spawn } from 'node:child_process'

			const child = spawn('sleep', ['10'])
			const pid = child.pid

			// Give it a moment to start
			await new Promise(r => setTimeout(r, 50))

			// Kill should return true
			const result = process.kill(pid, 'SIGTERM')
			console.log(JSON.stringify({ result }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { result: true })
	})

	test('process.kill throws ESRCH for non-existent process', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'

			try {
				process.kill(999999, 'SIGTERM')
				console.log(JSON.stringify({ threw: false }))
			} catch (e) {
				console.log(JSON.stringify({ threw: true, code: e.code }))
			}
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true, code: 'ESRCH' })
	})

	test('process.kill defaults to SIGTERM', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			import { spawn } from 'node:child_process'

			const child = spawn('sleep', ['10'])
			const pid = child.pid

			await new Promise(r => setTimeout(r, 50))

			// Kill without signal argument
			const result = process.kill(pid)
			console.log(JSON.stringify({ result }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { result: true })
	})

	test('process.kill with signal 0 tests process existence', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'

			// Signal 0 on our own pid should succeed
			const exists = process.kill(process.pid, 0)

			// Signal 0 on non-existent pid should throw ESRCH
			let threw = false
			let code = null
			try {
				process.kill(999999, 0)
			} catch (e) {
				threw = true
				code = e.code
			}

			console.log(JSON.stringify({ exists, threw, code }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { exists: true, threw: true, code: 'ESRCH' })
	})

	test('process.once fires handler only once', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			let count = 0
			process.once('exit', () => { count++ })
			// exit handlers fire once on exit — count should be 1
			process.on('exit', () => {
				console.log(JSON.stringify({ count }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 1 })
	})

	test('process.off removes event handler', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			let called = false
			const handler = () => { called = true }
			process.on('exit', handler)
			process.off('exit', handler)
			process.on('exit', () => {
				console.log(JSON.stringify({ called }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { called: false })
	})

	test('os.arch returns valid architecture string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { arch } from 'node:os'
			const a = arch()
			const valid = ['x64', 'arm64', 'arm', 'ia32', 's390x', 'ppc64', 'riscv64'].includes(a)
			console.log(JSON.stringify({ arch: a, valid }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.valid, true, `os.arch() returned unexpected value: ${result.arch}`)
	})

	test('os.arch matches process output', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { arch } from 'node:os'
			import { execSync } from 'node:child_process'
			const osArch = arch()
			const uname = execSync('uname -m', { encoding: 'utf8' }).trim()
			// Map uname to Node.js arch names
			const expected = {
				'x86_64': 'x64', 'amd64': 'x64',
				'aarch64': 'arm64', 'arm64': 'arm64',
				'armv7l': 'arm',
				'i686': 'ia32', 'i386': 'ia32',
			}[uname] || uname
			console.log(JSON.stringify({ osArch, expected, match: osArch === expected }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.match, true, `os.arch()=${result.osArch} doesn't match uname=${result.expected}`)
	})
})
