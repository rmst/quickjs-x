import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { test } from './util.js'

function $run(bin, dir) {
	const { FORCE_COLOR, NODE_OPTIONS, ...env } = process.env
	return execSync(`${bin} ${dir}/test.js`, {
		encoding: 'utf8',
		env: { ...env, NO_COLOR: '1' },
	}).trim()
}

describe('node:fs URL path arguments', () => {
	test('readFileSync accepts URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/data.txt`, 'url-read')
		writeFileSync(`${dir}/test.js`, `
			import { readFileSync } from 'node:fs'
			const u = new URL('file://${dir}/data.txt')
			console.log(JSON.stringify({ content: readFileSync(u, 'utf8') }))
		`)
		const output = $run(bin, dir)
		assert.deepStrictEqual(JSON.parse(output), { content: 'url-read' })
	})

	test('writeFileSync + readFileSync round-trip via URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			const u = new URL('file://${dir}/out.txt')
			writeFileSync(u, 'url-write')
			console.log(JSON.stringify({ content: readFileSync(u, 'utf8') }))
		`)
		assert.deepStrictEqual(JSON.parse($run(bin, dir)), { content: 'url-write' })
	})

	test('statSync, existsSync, readdirSync accept URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/a.txt`, 'a')
		writeFileSync(`${dir}/test.js`, `
			import { statSync, existsSync, readdirSync } from 'node:fs'
			const fileURL = new URL('file://${dir}/a.txt')
			const dirURL = new URL('file://${dir}/')
			console.log(JSON.stringify({
				size: statSync(fileURL).size,
				exists: existsSync(fileURL),
				missing: existsSync(new URL('file://${dir}/none.txt')),
				entries: readdirSync(dirURL).sort(),
			}))
		`)
		const out = JSON.parse($run(bin, dir))
		assert.strictEqual(out.size, 1)
		assert.strictEqual(out.exists, true)
		assert.strictEqual(out.missing, false)
		assert.ok(out.entries.includes('a.txt'))
		assert.ok(out.entries.includes('test.js'))
	})

	test('promises.readFile accepts URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/data.txt`, 'promise-url')
		writeFileSync(`${dir}/test.js`, `
			import { readFile } from 'node:fs/promises'
			const u = new URL('file://${dir}/data.txt')
			console.log(JSON.stringify({ content: await readFile(u, 'utf8') }))
		`)
		assert.deepStrictEqual(JSON.parse($run(bin, dir)), { content: 'promise-url' })
	})

	test('createReadStream accepts URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/data.txt`, 'stream-url')
		writeFileSync(`${dir}/test.js`, `
			import { createReadStream } from 'node:fs'
			const u = new URL('file://${dir}/data.txt')
			const chunks = []
			await new Promise((resolve, reject) => {
				const s = createReadStream(u)
				s.on('data', c => chunks.push(c))
				s.on('end', resolve)
				s.on('error', reject)
			})
			console.log(JSON.stringify({ content: Buffer.concat(chunks).toString('utf8') }))
		`)
		assert.deepStrictEqual(JSON.parse($run(bin, dir)), { content: 'stream-url' })
	})

	test('readFileSync with import.meta.url-relative URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/payload.bin`, 'payload')
		writeFileSync(`${dir}/test.js`, `
			import { readFileSync } from 'node:fs'
			const u = new URL('./payload.bin', import.meta.url)
			console.log(JSON.stringify({ content: readFileSync(u, 'utf8') }))
		`)
		assert.deepStrictEqual(JSON.parse($run(bin, dir)), { content: 'payload' })
	})

	test('fileURLToPath / pathToFileURL round-trip', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { fileURLToPath, pathToFileURL } from 'node:url'
			const url = pathToFileURL('${dir}/some file.txt')
			console.log(JSON.stringify({
				href: url.href,
				back: fileURLToPath(url),
			}))
		`)
		const out = JSON.parse($run(bin, dir))
		assert.strictEqual(out.back, `${dir}/some file.txt`)
		assert.ok(out.href.startsWith('file://'))
		assert.ok(out.href.includes('some%20file.txt'))
	})

	test('non-file URL throws ERR_INVALID_URL_SCHEME', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { readFileSync } from 'node:fs'
			try {
				readFileSync(new URL('http://example.com/foo'))
				console.log(JSON.stringify({ threw: false }))
			} catch (e) {
				console.log(JSON.stringify({ threw: true, code: e.code }))
			}
		`)
		assert.deepStrictEqual(JSON.parse($run(bin, dir)), {
			threw: true,
			code: 'ERR_INVALID_URL_SCHEME',
		})
	})

	test('encoded slash and Buffer/openSync/createWriteStream paths', ({ bin, dir }) => {
		writeFileSync(`${dir}/data.txt`, 'buf-read')
		writeFileSync(`${dir}/test.js`, `
			import { readFileSync, openSync, closeSync, createWriteStream, readFileSync as rfs } from 'node:fs'
			const out = {}

			// Buffer path
			out.buffer = readFileSync(Buffer.from('${dir}/data.txt'), 'utf8')

			// localhost host normalizes to empty — should accept
			out.localhost = readFileSync(new URL('file://localhost${dir}/data.txt'), 'utf8')

			// %2F in the pathname must be rejected
			try {
				readFileSync(new URL('file://${dir}/has%2Fslash'))
				out.encodedSlashThrew = false
			} catch (e) { out.encodedSlashCode = e.code }

			// openSync via URL
			const fd = openSync(new URL('file://${dir}/data.txt'), 'r')
			closeSync(fd)
			out.openedOk = true

			// createWriteStream via URL
			await new Promise((resolve, reject) => {
				const ws = createWriteStream(new URL('file://${dir}/written.txt'))
				ws.on('error', reject)
				ws.on('finish', resolve)
				ws.end('via-url')
			})
			out.written = rfs('${dir}/written.txt', 'utf8')

			console.log(JSON.stringify(out))
		`)
		assert.deepStrictEqual(JSON.parse($run(bin, dir)), {
			buffer: 'buf-read',
			localhost: 'buf-read',
			encodedSlashCode: 'ERR_INVALID_FILE_URL_PATH',
			openedOk: true,
			written: 'via-url',
		})
	})

	test('pathToFileURL preserves trailing slash and collapses ..', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { pathToFileURL } from 'node:url'
			console.log(JSON.stringify({
				dir: pathToFileURL('${dir}/').href,
				file: pathToFileURL('${dir}/x').href,
				collapsed: pathToFileURL('${dir}/a/../b').href,
			}))
		`)
		const out = JSON.parse($run(bin, dir))
		assert.ok(out.dir.endsWith('/'), `expected trailing slash, got ${out.dir}`)
		assert.ok(!out.file.endsWith('/'))
		assert.ok(out.collapsed.endsWith('/b'))
	})
})
