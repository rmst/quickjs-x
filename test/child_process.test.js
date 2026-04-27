import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

describe('node:child_process shim', () => {
	test('execFileSync returns stdout', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', ['hello', 'world'], { encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'hello world' })
	})

	test('execFileSync with empty args', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', [], { encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: '' })
	})

	test('execFileSync with input option', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('cat', [], { input: 'piped input', encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'piped input' })
	})

	test('execFileSync with Buffer input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from('buffer input')
			const output = execFileSync('cat', [], { input: buf, encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'buffer input' })
	})

	test('execFileSync with binary input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			// Binary data with null bytes and non-ASCII values
			const input = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x80])
			const output = execFileSync('cat', [], { input })
			// Verify we get the exact same bytes back
			const match = output.length === input.length && input.every((b, i) => output[i] === b)
			console.log(JSON.stringify({ match, inLen: input.length, outLen: output.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { match: true, inLen: 7, outLen: 7 })
	})

	test('execFileSync with Buffer subarray input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			import { Buffer } from 'node:buffer'
			// Create a Buffer subarray with non-zero byteOffset
			const big = Buffer.from('XXXhello worldYYY')
			const sub = big.subarray(3, 14)
			const output = execFileSync('cat', [], { input: sub, encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'hello world' })
	})

	test('execFileSync with special characters in args', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', ['hello world', 'foo\\\\nbar'], { encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		// echo outputs: hello world foo\nbar (literal backslash-n)
		assert.deepStrictEqual(JSON.parse(output), { output: 'hello world foo\\nbar' })
	})

	test('execFileSync throws on non-zero exit', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			let threw = false
			let status = null
			try {
				execFileSync('false', [], { encoding: 'utf8' })
			} catch (e) {
				threw = true
				status = e.status
			}
			console.log(JSON.stringify({ threw, status }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.threw, true)
		assert.strictEqual(result.status, 1)
	})

	test('execFileSync with cwd option', ({ bin, dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('pwd', [], { cwd: '${dir}/subdir', encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.output.endsWith('/subdir'))
	})

	test('execFileSync with env option', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('/bin/sh', ['-c', 'echo $MY_VAR'], { env: { MY_VAR: 'test_value' }, encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'test_value' })
	})

	test('execFileSync with timeout that expires', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const start = Date.now()
			let threw = false
			let signal = null
			try {
				execFileSync('sleep', ['10'], { timeout: 100 })
			} catch (e) {
				threw = true
				signal = e.signal
			}
			const elapsed = Date.now() - start
			console.log(JSON.stringify({ threw, signal, elapsedOk: elapsed < 500 }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.threw, true)
		assert.strictEqual(result.signal, 'SIGTERM')
		assert.strictEqual(result.elapsedOk, true, 'should timeout quickly, not wait for sleep to complete')
	})

	test('execFileSync with timeout that does not expire', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', ['fast'], { timeout: 5000, encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'fast' })
	})

	test('execFileSync with custom killSignal', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			let signal = null
			try {
				execFileSync('sleep', ['10'], { timeout: 100, killSignal: 'SIGKILL' })
			} catch (e) {
				signal = e.signal
			}
			console.log(JSON.stringify({ signal }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { signal: 'SIGKILL' })
	})

	// Async execFile tests
	test('execFile with callback', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			execFile('echo', ['hello', 'async'], { encoding: 'utf8' }, (error, stdout, stderr) => {
				console.log(JSON.stringify({
					error: error ? error.message : null,
					stdout: stdout.trim(),
					stderr: stderr.trim()
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			error: null,
			stdout: 'hello async',
			stderr: ''
		})
	})

	test('execFile returns ChildProcess with pid', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			console.log(JSON.stringify({ hasPid: typeof child.pid === 'number' && child.pid > 0 }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { hasPid: true })
	})

	test('execFile emits spawn event', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			child.on('spawn', () => {
				console.log(JSON.stringify({ spawned: true }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { spawned: true })
	})

	test('execFile emits close event with exit code', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			child.stdout.setEncoding('utf8')
			let stdout = ''
			child.stdout.on('data', (chunk) => { stdout += chunk })
			child.on('close', (code) => {
				console.log(JSON.stringify({ code, stdout: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { code: 0, stdout: 'test' })
	})

	test('execFile captures stderr', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('sh', ['-c', 'echo error >&2'])
			child.stderr.setEncoding('utf8')
			let stderr = ''
			child.stderr.on('data', (chunk) => { stderr += chunk })
			child.on('close', (code) => {
				console.log(JSON.stringify({ stderr: stderr.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { stderr: 'error' })
	})

	// Note: execFile with input option is a qn extension, not supported in Node.js
	// Use stdin.write() instead for cross-platform compatibility (see streaming tests below)

	test('execFile callback receives error on non-zero exit', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			execFile('false', [], (error, stdout, stderr) => {
				console.log(JSON.stringify({
					hasError: error !== null,
					code: error ? error.code : null
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.hasError, true)
		assert.strictEqual(result.code, 1)
	})

	test('execFile with cwd option', ({ bin, dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			execFile('pwd', [], { cwd: '${dir}/subdir', encoding: 'utf8' }, (error, stdout) => {
				console.log(JSON.stringify({ output: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.output.endsWith('/subdir'))
	})

	test('execFile with timeout that expires', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const start = Date.now()
			execFile('sleep', ['10'], { timeout: 100 }, (error, stdout, stderr) => {
				const elapsed = Date.now() - start
				console.log(JSON.stringify({
					hasError: error !== null,
					killed: error ? error.killed : null,
					signal: error ? error.signal : null,
					elapsedOk: elapsed < 500
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.hasError, true)
		assert.strictEqual(result.killed, true)
		assert.strictEqual(result.signal, 'SIGTERM')
		assert.strictEqual(result.elapsedOk, true, 'should timeout quickly')
	})

	test('execFile with timeout that does not expire', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			execFile('echo', ['fast'], { timeout: 5000, encoding: 'utf8' }, (error, stdout, stderr) => {
				console.log(JSON.stringify({
					error: error ? error.message : null,
					stdout: stdout.trim()
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { error: null, stdout: 'fast' })
	})

	test('execFile with custom killSignal', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			execFile('sleep', ['10'], { timeout: 100, killSignal: 'SIGKILL' }, (error) => {
				console.log(JSON.stringify({ signal: error ? error.signal : null }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { signal: 'SIGKILL' })
	})

	test('execFile handles large output without blocking', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			// Generate output larger than typical pipe buffer (64KB) using POSIX awk
			execFile('awk', ['BEGIN { for(i=1;i<=5000;i++) print "line " i ": some text to fill buffer" }'], { encoding: 'utf8' }, (error, stdout) => {
				const lines = stdout.trim().split('\\n')
				console.log(JSON.stringify({
					lineCount: lines.length,
					firstLine: lines[0],
					lastLine: lines[lines.length - 1]
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.lineCount, 5000)
		assert.strictEqual(result.firstLine, 'line 1: some text to fill buffer')
		assert.strictEqual(result.lastLine, 'line 5000: some text to fill buffer')
	})

	test('execFileSync handles large output without blocking', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('awk', ['BEGIN { for(i=1;i<=5000;i++) print "line " i ": some text to fill buffer" }'], { encoding: 'utf8' })
			const lines = output.trim().split('\\n')
			console.log(JSON.stringify({
				lineCount: lines.length,
				firstLine: lines[0],
				lastLine: lines[lines.length - 1]
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.lineCount, 5000)
		assert.strictEqual(result.firstLine, 'line 1: some text to fill buffer')
		assert.strictEqual(result.lastLine, 'line 5000: some text to fill buffer')
	})

	// Streaming tests
	test('streaming: write to stdin and read from stdout', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('cat')
			child.stdout.setEncoding('utf8')
			let output = ''
			child.stdout.on('data', (chunk) => { output += chunk })
			child.on('close', () => {
				console.log(JSON.stringify({ output: output.trim() }))
			})
			// Write to stdin
			child.stdin.write('line 1\\n')
			child.stdin.write('line 2\\n')
			child.stdin.end()
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'line 1\nline 2' })
	})

	test('streaming: receive data before process exits', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			// Process that outputs, sleeps, then outputs more
			const child = execFile('sh', ['-c', 'echo first; sleep 0.2; echo second'])
			let dataBeforeClose = false
			let gotData = false
			child.stdout.on('data', (chunk) => {
				gotData = true
				// At this point, process should still be running (sleeping)
				if (child.exitCode === null) {
					dataBeforeClose = true
				}
			})
			child.on('close', () => {
				console.log(JSON.stringify({ dataBeforeClose, gotData }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.gotData, true)
		assert.strictEqual(result.dataBeforeClose, true, 'data event should fire before process exits')
	})

	test('streaming: stdin.end() with data', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('cat')
			child.stdout.setEncoding('utf8')
			let output = ''
			child.stdout.on('data', (chunk) => { output += chunk })
			child.on('close', () => {
				console.log(JSON.stringify({ output: output.trim() }))
			})
			child.stdin.end('final chunk')
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'final chunk' })
	})

	test('streaming: stdout emits end event', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			let endEmitted = false
			child.stdout.on('end', () => { endEmitted = true })
			child.on('close', () => {
				console.log(JSON.stringify({ endEmitted }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { endEmitted: true })
	})

	test('streaming: stdin write returns true for small writes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('cat')
			let writeResult = child.stdin.write('small data')
			child.stdin.end()
			child.on('close', () => {
				console.log(JSON.stringify({ writeResult }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		// write() should return boolean
		assert.strictEqual(typeof result.writeResult, 'boolean')
	})

	test('streaming: child.stdout and child.stderr are Readable streams', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			const hasStdoutOn = typeof child.stdout.on === 'function'
			const hasStderrOn = typeof child.stderr.on === 'function'
			const hasStdinWrite = typeof child.stdin.write === 'function'
			const hasStdinEnd = typeof child.stdin.end === 'function'
			console.log(JSON.stringify({ hasStdoutOn, hasStderrOn, hasStdinWrite, hasStdinEnd }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hasStdoutOn: true,
			hasStderrOn: true,
			hasStdinWrite: true,
			hasStdinEnd: true
		})
	})

	test('streaming: bidirectional - write stdin, read stdout', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			// sed transforms input and outputs result
			const child = execFile('sed', ['s/hello/goodbye/'])
			child.stdout.setEncoding('utf8')
			const responses = []

			child.stdout.on('data', (chunk) => {
				responses.push(chunk.trim())
			})

			child.on('close', () => {
				console.log(JSON.stringify({
					responses,
					transformedCorrectly: responses.includes('goodbye world')
				}))
			})

			// Write input and close stdin
			child.stdin.write('hello world\\n')
			child.stdin.end()
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.transformedCorrectly, true, 'sed should transform hello to goodbye')
	})

	// execSync tests
	test('execSync runs command through shell', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execSync } from 'node:child_process'
			const output = execSync('echo $((1 + 2))', { encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: '3' })
	})

	test('execSync with custom shell', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execSync } from 'node:child_process'
			const output = execSync('echo hello', { shell: '/bin/sh', encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'hello' })
	})

	test('execSync with input option', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execSync } from 'node:child_process'
			const output = execSync('cat', { input: 'piped via shell', encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'piped via shell' })
	})

	test('execSync with timeout that expires', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execSync } from 'node:child_process'
			try {
				execSync('sleep 10', { timeout: 100 })
				console.log(JSON.stringify({ timedOut: false }))
			} catch (e) {
				console.log(JSON.stringify({ timedOut: true, signal: e.signal }))
			}
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.timedOut, true)
		assert.strictEqual(result.signal, 'SIGTERM')
	})

	test('execSync with timeout that does not expire', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execSync } from 'node:child_process'
			const output = execSync('echo fast', { timeout: 5000, encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'fast' })
	})

	// exec tests (async)
	test('exec runs command through shell', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { exec } from 'node:child_process'
			exec('echo $((2 * 3))', { encoding: 'utf8' }, (error, stdout, stderr) => {
				console.log(JSON.stringify({
					error: error ? error.message : null,
					stdout: stdout.trim()
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { error: null, stdout: '6' })
	})

	test('exec with cwd option', ({ bin, dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { exec } from 'node:child_process'
			exec('pwd', { cwd: '${dir}/subdir', encoding: 'utf8' }, (error, stdout) => {
				console.log(JSON.stringify({ output: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.output.endsWith('/subdir'))
	})

	test('exec returns ChildProcess', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { exec } from 'node:child_process'
			const child = exec('echo test')
			console.log(JSON.stringify({
				hasPid: typeof child.pid === 'number',
				hasStdout: child.stdout !== null
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { hasPid: true, hasStdout: true })
	})

	// spawn tests
	test('spawn returns ChildProcess with streams', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			const child = spawn('echo', ['hello', 'spawn'])
			child.stdout.setEncoding('utf8')
			let stdout = ''
			child.stdout.on('data', (chunk) => { stdout += chunk })
			child.on('close', (code) => {
				console.log(JSON.stringify({ code, stdout: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { code: 0, stdout: 'hello spawn' })
	})

	test('spawn with shell option', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			const child = spawn('echo $((3 + 4))', { shell: true })
			child.stdout.setEncoding('utf8')
			let stdout = ''
			child.stdout.on('data', (chunk) => { stdout += chunk })
			child.on('close', (code) => {
				console.log(JSON.stringify({ code, stdout: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { code: 0, stdout: '7' })
	})

	test('spawn with cwd option', ({ bin, dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			const child = spawn('pwd', [], { cwd: '${dir}/subdir' })
			child.stdout.setEncoding('utf8')
			let stdout = ''
			child.stdout.on('data', (chunk) => { stdout += chunk })
			child.on('close', () => {
				console.log(JSON.stringify({ output: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.output.endsWith('/subdir'))
	})

	test('spawn bidirectional streaming', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			const child = spawn('cat')
			child.stdout.setEncoding('utf8')
			let stdout = ''
			child.stdout.on('data', (chunk) => { stdout += chunk })
			child.on('close', () => {
				console.log(JSON.stringify({ stdout: stdout.trim() }))
			})
			child.stdin.write('hello from spawn\\n')
			child.stdin.end()
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { stdout: 'hello from spawn' })
	})

	// Raw bytes vs UTF-8 encoding tests
	// execFileSync defaults to bytes (matches Node's 'buffer' default).
	// execFile (async) defaults to string (matches Node's 'utf8' default).
	testQnOnly('execFileSync returns Uint8Array by default', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', ['hello'])
			const isUint8Array = output instanceof Uint8Array
			// Check first few bytes are ASCII for 'hello'
			const firstByte = output[0]
			console.log(JSON.stringify({ isUint8Array, firstByte }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.isUint8Array, true)
		assert.strictEqual(result.firstByte, 104) // 'h' = 104
	})

	testQnOnly('execFileSync returns string with encoding utf8', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', ['hello'], { encoding: 'utf8' })
			const isString = typeof output === 'string'
			console.log(JSON.stringify({ isString, output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isString: true, output: 'hello' })
	})

	test('execFile callback receives string by default', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			execFile('echo', ['hello'], (error, stdout, stderr) => {
				console.log(JSON.stringify({
					stdoutIsString: typeof stdout === 'string',
					stderrIsString: typeof stderr === 'string',
					stdout: stdout.trim(),
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			stdoutIsString: true,
			stderrIsString: true,
			stdout: 'hello',
		})
	})

	testQnOnly('execFile callback receives Uint8Array with encoding buffer', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			execFile('echo', ['hello'], { encoding: 'buffer' }, (error, stdout, stderr) => {
				const stdoutIsUint8 = stdout instanceof Uint8Array
				const stderrIsUint8 = stderr instanceof Uint8Array
				const firstByte = stdout[0]
				console.log(JSON.stringify({ stdoutIsUint8, stderrIsUint8, firstByte }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.stdoutIsUint8, true)
		assert.strictEqual(result.stderrIsUint8, true)
		assert.strictEqual(result.firstByte, 104) // 'h' = 104
	})

	testQnOnly('execFile callback receives string with encoding utf8', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			execFile('echo', ['hello'], { encoding: 'utf8' }, (error, stdout, stderr) => {
				const stdoutIsString = typeof stdout === 'string'
				const stderrIsString = typeof stderr === 'string'
				console.log(JSON.stringify({ stdoutIsString, stderrIsString, output: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { stdoutIsString: true, stderrIsString: true, output: 'hello' })
	})

	testQnOnly('stream emits Uint8Array by default', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			const child = spawn('echo', ['test'])
			let chunkType = null
			let firstByte = null
			child.stdout.on('data', (chunk) => {
				if (chunkType === null) {
					chunkType = chunk instanceof Uint8Array ? 'Uint8Array' : typeof chunk
					firstByte = chunk[0]
				}
			})
			child.on('close', () => {
				console.log(JSON.stringify({ chunkType, firstByte }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.chunkType, 'Uint8Array')
		assert.strictEqual(result.firstByte, 116) // 't' = 116
	})

	testQnOnly('stream emits string after setEncoding', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			const child = spawn('echo', ['test'])
			child.stdout.setEncoding('utf8')
			let chunkType = null
			let content = ''
			child.stdout.on('data', (chunk) => {
				if (chunkType === null) {
					chunkType = typeof chunk
				}
				content += chunk
			})
			child.on('close', () => {
				console.log(JSON.stringify({ chunkType, content: content.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { chunkType: 'string', content: 'test' })
	})

	testQnOnly('stdin accepts both string and Uint8Array', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			const child = spawn('cat')
			child.stdout.setEncoding('utf8')
			let output = ''
			child.stdout.on('data', (chunk) => { output += chunk })
			child.on('close', () => {
				console.log(JSON.stringify({ output: output.trim() }))
			})
			// Write string
			child.stdin.write('hello ')
			// Write Uint8Array
			child.stdin.write(new Uint8Array([119, 111, 114, 108, 100])) // 'world'
			child.stdin.end()
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'hello world' })
	})

	test('execFileSync with stdio inherit', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			// When stdio is 'inherit', output goes directly to parent
			// The return value should be null or empty
			const result = execFileSync('echo', ['inherited output'], { stdio: 'inherit', encoding: 'utf8' })
			// Result should be null (Node) or empty string (qn) since stdout was inherited
			console.log(JSON.stringify({ resultEmpty: result === null || result === '' }))
		`)

		const output = $`${bin} ${dir}/test.js`
		// The output includes both the inherited "inherited output" and our JSON
		assert.ok(output.includes('inherited output'))
		assert.ok(output.includes('"resultEmpty":true'))
	})

	test('execFileSync with stdio array for partial inherit', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			// Pipe stdin, inherit stdout/stderr
			const result = execFileSync('sh', ['-c', 'echo hello; echo error >&2'], {
				stdio: ['pipe', 'inherit', 'inherit'],
				encoding: 'utf8'
			})
			// Result should be null (Node) or empty string (qn) since stdout was inherited
			console.log(JSON.stringify({ resultEmpty: result === null || result === '' }))
		`)

		const output = $({ stdio: 'pipe' })`${bin} ${dir}/test.js 2>&1`
		assert.ok(output.includes('hello'))
		assert.ok(output.includes('error'))
		assert.ok(output.includes('"resultEmpty":true'))
	})

	test('spawn with AbortController signal', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			const controller = new AbortController()
			const start = Date.now()
			const child = spawn('sleep', ['10'], { signal: controller.signal })
			let errorName = null
			child.on('error', (err) => {
				errorName = err.name
			})
			child.on('close', (code, signal) => {
				const elapsed = Date.now() - start
				console.log(JSON.stringify({
					signal,
					errorName,
					elapsedOk: elapsed < 500
				}))
			})
			setTimeout(() => controller.abort(), 50)
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		// Node.js uses signal name 'SIGTERM', qn uses signal number 15
		assert.ok(result.signal === 15 || result.signal === 'SIGTERM')
		assert.strictEqual(result.elapsedOk, true)
	})

	test('execFile with AbortController signal', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const controller = new AbortController()
			const start = Date.now()
			const child = execFile('sleep', ['10'], { signal: controller.signal }, (error) => {
				const elapsed = Date.now() - start
				console.log(JSON.stringify({
					hasError: error !== null,
					elapsedOk: elapsed < 500
				}))
			})
			child.on('error', () => {}) // Suppress unhandled error in Node.js
			setTimeout(() => controller.abort(), 50)
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.hasError, true)
		assert.strictEqual(result.elapsedOk, true)
	})

	testQnOnly('execFileSync with numeric fd for stdin', ({ bin, dir }) => {
		writeFileSync(`${dir}/input.txt`, 'content from file')
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			import { openSync, closeSync } from 'node:fs'
			const fd = openSync('${dir}/input.txt', 'r')
			const output = execFileSync('cat', [], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8' })
			closeSync(fd)
			console.log(JSON.stringify({ output }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'content from file' })
	})

	test('execFile maxBuffer kills child when stdout exceeds limit', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			execFile('awk', ['BEGIN { for(i=1;i<=10000;i++) print "line " i }'], { encoding: 'utf8', maxBuffer: 1024 }, (error, stdout, stderr) => {
				console.log(JSON.stringify({
					hasError: error !== null,
					code: error ? error.code : null,
					isRangeError: error instanceof RangeError,
					gotPartialOutput: stdout.length > 0 && stdout.length <= 1024 + 200,
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.hasError, true)
		assert.strictEqual(result.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
		assert.strictEqual(result.isRangeError, true)
	})

	test('execFile maxBuffer default allows reasonable output', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			// ~50KB output, well under 1MB default
			execFile('awk', ['BEGIN { for(i=1;i<=1000;i++) print "line " i ": padding text here" }'], { encoding: 'utf8' }, (error, stdout) => {
				const lines = stdout.trim().split('\\n')
				console.log(JSON.stringify({
					error: error ? error.message : null,
					lineCount: lines.length,
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { error: null, lineCount: 1000 })
	})

	test('execFileSync does not trim output', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', ['hello'], { encoding: 'utf8' })
			// Node.js returns 'hello\\n' (with trailing newline), not 'hello'
			console.log(JSON.stringify({ endsWithNewline: output.endsWith('\\n'), raw: output }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.endsWithNewline, true, 'execFileSync should NOT trim trailing newline')
		assert.strictEqual(result.raw, 'hello\n')
	})

	test('execSync does not trim output', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execSync } from 'node:child_process'
			const output = execSync('echo hello', { encoding: 'utf8' })
			// Node.js returns 'hello\\n' (with trailing newline)
			console.log(JSON.stringify({ endsWithNewline: output.endsWith('\\n'), raw: output }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.endsWithNewline, true, 'execSync should NOT trim trailing newline')
		assert.strictEqual(result.raw, 'hello\n')
	})

	testQnOnly('spawn with detached creates new session and kills process group', ({ bin, dir }) => {
		const marker = `${dir}/marker.txt`
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			import { readFileSync, writeFileSync } from 'node:fs'
			import { getpgid } from 'qn_uv_fs'

			const marker = '${marker}'
			writeFileSync(marker, 'initial')

			// Spawn a detached child that spawns a grandchild
			const script = '(while true; do echo alive >> ' + marker + '; sleep 0.1; done) & wait'
			const child = spawn('sh', ['-c', script], { detached: true })

			// Wait for child to call setsid() before checking PGID
			await new Promise(r => setTimeout(r, 50))

			// Child should be session leader (PGID == PID)
			const isSessionLeader = getpgid(child.pid) === child.pid

			// Wait for grandchild to start writing
			await new Promise(r => setTimeout(r, 300))
			const linesBefore = readFileSync(marker, 'utf8').trim().split('\\n').length

			// Kill the process group
			child.kill('SIGTERM')

			// Wait to confirm grandchild stopped
			await new Promise(r => setTimeout(r, 300))
			const linesAfter = readFileSync(marker, 'utf8').trim().split('\\n').length

			// If grandchild was killed with the group, no new lines were added
			const grandchildKilled = linesAfter === linesBefore

			console.log(JSON.stringify({ isSessionLeader, grandchildKilled }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isSessionLeader: true, grandchildKilled: true })
	})
})
