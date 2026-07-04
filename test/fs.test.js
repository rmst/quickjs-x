import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

describe('node:fs shim', () => {
	test('writeFileSync and readFileSync', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/out.txt', 'hello world')
			console.log(JSON.stringify({ content: readFileSync('${dir}/out.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'hello world' })
	})

	test('readFileSync with utf-8 encoding variant', ({ bin, dir }) => {
		writeFileSync(`${dir}/data.txt`, 'utf-8 test content')
		writeFileSync(`${dir}/test.js`, `
			import { readFileSync } from 'node:fs'
			console.log(JSON.stringify({ content: readFileSync('${dir}/data.txt', 'utf-8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'utf-8 test content' })
	})

	test('readFileSync with options object', ({ bin, dir }) => {
		writeFileSync(`${dir}/data.txt`, 'options object test')
		writeFileSync(`${dir}/test.js`, `
			import { readFileSync } from 'node:fs'
			console.log(JSON.stringify({ content: readFileSync('${dir}/data.txt', { encoding: 'utf8' }) }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'options object test' })
	})

	test('writeFileSync with empty string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/empty.txt', '')
			console.log(JSON.stringify({ content: readFileSync('${dir}/empty.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: '' })
	})

	test('writeFileSync with unicode content', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/unicode.txt', '日本語 émojis 🎉 中文')
			console.log(JSON.stringify({ content: readFileSync('${dir}/unicode.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: '日本語 émojis 🎉 中文' })
	})

	test('writeFileSync with multiline content', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/multi.txt', 'line1\\nline2\\nline3')
			console.log(JSON.stringify({ content: readFileSync('${dir}/multi.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'line1\nline2\nline3' })
	})

	test('existsSync matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/exists.txt`, 'test')
		writeFileSync(`${dir}/test.js`, `
			import { existsSync } from 'node:fs'
			console.log(JSON.stringify({
				exists: existsSync('${dir}/exists.txt'),
				missing: existsSync('${dir}/missing.txt')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { exists: true, missing: false })
	})

	test('existsSync with directories', ({ bin, dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { existsSync } from 'node:fs'
			console.log(JSON.stringify({
				dirExists: existsSync('${dir}/subdir'),
				missingDir: existsSync('${dir}/nonexistent')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { dirExists: true, missingDir: false })
	})

	test('statSync.isFile matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'test')
		writeFileSync(`${dir}/test.js`, `
			import { statSync } from 'node:fs'
			const stats = statSync('${dir}/file.txt')
			console.log(JSON.stringify({
				isFile: stats.isFile(),
				isDirectory: stats.isDirectory()
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isFile: true, isDirectory: false })
	})

	test('statSync.isDirectory matches Node.js', ({ bin, dir }) => {
		mkdirSync(`${dir}/mydir`)
		writeFileSync(`${dir}/test.js`, `
			import { statSync } from 'node:fs'
			const stats = statSync('${dir}/mydir')
			console.log(JSON.stringify({
				isFile: stats.isFile(),
				isDirectory: stats.isDirectory()
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isFile: false, isDirectory: true })
	})

	test('statSync size property matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/sized.txt`, 'exactly 20 chars!!!!')
		writeFileSync(`${dir}/test.js`, `
			import { statSync } from 'node:fs'
			const stats = statSync('${dir}/sized.txt')
			console.log(JSON.stringify({ size: stats.size }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { size: 20 })
	})

	test('lstatSync on regular file matches statSync', ({ bin, dir }) => {
		writeFileSync(`${dir}/regular.txt`, 'regular file')
		writeFileSync(`${dir}/test.js`, `
			import { statSync, lstatSync } from 'node:fs'
			const stat = statSync('${dir}/regular.txt')
			const lstat = lstatSync('${dir}/regular.txt')
			console.log(JSON.stringify({
				statIsFile: stat.isFile(),
				lstatIsFile: lstat.isFile(),
				statIsSymlink: stat.isSymbolicLink(),
				lstatIsSymlink: lstat.isSymbolicLink()
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			statIsFile: true,
			lstatIsFile: true,
			statIsSymlink: false,
			lstatIsSymlink: false
		})
	})

	test('readdirSync returns files without . and ..', ({ bin, dir }) => {
		writeFileSync(`${dir}/a.txt`, 'a')
		writeFileSync(`${dir}/b.txt`, 'b')
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { readdirSync } from 'node:fs'
			const files = readdirSync('${dir}')
			console.log(JSON.stringify({
				hasDot: files.includes('.'),
				hasDotDot: files.includes('..'),
				hasA: files.includes('a.txt'),
				hasB: files.includes('b.txt'),
				hasSubdir: files.includes('subdir')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hasDot: false,
			hasDotDot: false,
			hasA: true,
			hasB: true,
			hasSubdir: true
		})
	})

	test('readdirSync empty directory', ({ bin, dir }) => {
		mkdirSync(`${dir}/empty`)
		writeFileSync(`${dir}/test.js`, `
			import { readdirSync } from 'node:fs'
			const files = readdirSync('${dir}/empty')
			console.log(JSON.stringify({ count: files.length, files }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 0, files: [] })
	})

	test('mkdirSync creates directory', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { mkdirSync, existsSync, statSync } from 'node:fs'
			mkdirSync('${dir}/newdir')
			const exists = existsSync('${dir}/newdir')
			const isDir = statSync('${dir}/newdir').isDirectory()
			console.log(JSON.stringify({ exists, isDir }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { exists: true, isDir: true })
	})

	test('mkdirSync recursive creates nested directories', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { mkdirSync, existsSync } from 'node:fs'
			mkdirSync('${dir}/a/b/c', { recursive: true })
			console.log(JSON.stringify({
				aExists: existsSync('${dir}/a'),
				bExists: existsSync('${dir}/a/b'),
				cExists: existsSync('${dir}/a/b/c')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { aExists: true, bExists: true, cExists: true })
	})

	test('mkdirSync recursive with relative path', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { mkdirSync, existsSync } from 'node:fs'
			import { chdir } from 'node:process'
			chdir('${dir}')
			mkdirSync('rel/a/b', { recursive: true })
			console.log(JSON.stringify({
				relExists: existsSync('${dir}/rel'),
				aExists: existsSync('${dir}/rel/a'),
				bExists: existsSync('${dir}/rel/a/b'),
				notAbsolute: !existsSync('/rel')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { relExists: true, aExists: true, bExists: true, notAbsolute: true })
	})

	test('mkdirSync recursive with existing parent', ({ bin, dir }) => {
		mkdirSync(`${dir}/parent`)
		writeFileSync(`${dir}/test.js`, `
			import { mkdirSync, existsSync } from 'node:fs'
			mkdirSync('${dir}/parent/child/grandchild', { recursive: true })
			console.log(JSON.stringify({
				parentExists: existsSync('${dir}/parent'),
				childExists: existsSync('${dir}/parent/child'),
				grandchildExists: existsSync('${dir}/parent/child/grandchild')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { parentExists: true, childExists: true, grandchildExists: true })
	})

	test('unlinkSync removes file', ({ bin, dir }) => {
		writeFileSync(`${dir}/toremove.txt`, 'remove me')
		writeFileSync(`${dir}/test.js`, `
			import { unlinkSync, existsSync } from 'node:fs'
			const beforeExists = existsSync('${dir}/toremove.txt')
			unlinkSync('${dir}/toremove.txt')
			const afterExists = existsSync('${dir}/toremove.txt')
			console.log(JSON.stringify({ beforeExists, afterExists }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { beforeExists: true, afterExists: false })
	})

	test('symlinkSync creates symlink', ({ bin, dir }) => {
		writeFileSync(`${dir}/original.txt`, 'original content')
		writeFileSync(`${dir}/test.js`, `
			import { symlinkSync, readFileSync, lstatSync } from 'node:fs'
			symlinkSync('${dir}/original.txt', '${dir}/link.txt')
			const content = readFileSync('${dir}/link.txt', 'utf8')
			const isSymlink = lstatSync('${dir}/link.txt').isSymbolicLink()
			console.log(JSON.stringify({ content, isSymlink }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'original content', isSymlink: true })
	})

	test('rmSync removes file', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'delete me')
		writeFileSync(`${dir}/test.js`, `
			import { rmSync, existsSync } from 'node:fs'
			rmSync('${dir}/file.txt')
			console.log(JSON.stringify({ exists: existsSync('${dir}/file.txt') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { exists: false })
	})

	test('rmSync recursive removes directory tree', ({ bin, dir }) => {
		mkdirSync(`${dir}/tree/nested`, { recursive: true })
		writeFileSync(`${dir}/tree/file1.txt`, 'file1')
		writeFileSync(`${dir}/tree/nested/file2.txt`, 'file2')
		writeFileSync(`${dir}/test.js`, `
			import { rmSync, existsSync } from 'node:fs'
			rmSync('${dir}/tree', { recursive: true })
			console.log(JSON.stringify({ exists: existsSync('${dir}/tree') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { exists: false })
	})

	test('rmSync with force on non-existent file', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { rmSync, existsSync } from 'node:fs'
			let threw = false
			try {
				rmSync('${dir}/nonexistent.txt', { force: true })
			} catch {
				threw = true
			}
			console.log(JSON.stringify({ threw }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: false })
	})

	test('rmSync with force: true should throw on permission error', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { rmSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
			import { execSync } from 'node:child_process'
			import process from 'node:process'

			const parentDir = '${dir}/protected'
			const filePath = parentDir + '/file.txt'
			const probePath = parentDir + '/probe.txt'

			// Create directory structure
			mkdirSync(parentDir)
			writeFileSync(filePath, 'content')
			writeFileSync(probePath, 'probe')

			// Make parent directory read-only (prevents file deletion)
			execSync('chmod 555 ' + parentDir)

			// Check if we're running as root (permissions don't apply)
			const isRoot = process.getuid?.() === 0

			let permissionFixtureWorks = false
			try {
				unlinkSync(probePath)
			} catch {
				permissionFixtureWorks = true
			}

			let threw = false
			if (permissionFixtureWorks) {
				try {
					rmSync(filePath, { force: true })
				} catch (e) {
					threw = true
				}
			}

			// Restore permissions for cleanup
			execSync('chmod 755 ' + parentDir)

			// Check if file still exists
			const fileStillExists = existsSync(filePath)

			console.log(JSON.stringify({ threw, fileStillExists, isRoot, permissionFixtureWorks }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)

		// Skip assertion if this environment allows deletion despite the mode.
		if (result.isRoot || !result.permissionFixtureWorks) {
			return
		}

		// force: true should only suppress ENOENT, not permission errors
		assert.strictEqual(result.threw, true, 'rmSync with force: true should throw on permission error')
		assert.strictEqual(result.fileStillExists, true, 'File should still exist when deletion fails due to permission')
	})

	test('renameSync moves file', ({ bin, dir }) => {
		writeFileSync(`${dir}/original.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { renameSync, existsSync, readFileSync } from 'node:fs'
			renameSync('${dir}/original.txt', '${dir}/renamed.txt')
			console.log(JSON.stringify({
				oldExists: existsSync('${dir}/original.txt'),
				newExists: existsSync('${dir}/renamed.txt'),
				content: readFileSync('${dir}/renamed.txt', 'utf8')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			oldExists: false,
			newExists: true,
			content: 'content'
		})
	})

	test('realpathSync resolves path', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { realpathSync } from 'node:fs'
			const resolved = realpathSync('${dir}/./file.txt')
			console.log(JSON.stringify({ resolved }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.resolved, `${dir}/file.txt`)
	})

	test('readlinkSync reads symlink target', ({ bin, dir }) => {
		writeFileSync(`${dir}/target.txt`, 'target content')
		writeFileSync(`${dir}/test.js`, `
			import { symlinkSync, readlinkSync } from 'node:fs'
			symlinkSync('${dir}/target.txt', '${dir}/link.txt')
			const target = readlinkSync('${dir}/link.txt')
			console.log(JSON.stringify({ target }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { target: `${dir}/target.txt` })
	})

	testQnOnly('readFileSync without encoding returns Buffer', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/binary.bin', new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]))
			const data = readFileSync('${dir}/binary.bin')
			console.log(JSON.stringify({
				type: data.constructor.name,
				length: data.length,
				bytes: Array.from(data)
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			type: 'Buffer',
			length: 6,
			bytes: [0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]
		})
	})

	testQnOnly('writeFileSync accepts ArrayBuffer', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			const buffer = new ArrayBuffer(4)
			new Uint8Array(buffer).set([0x10, 0x20, 0x30, 0x40])
			writeFileSync('${dir}/arraybuffer.bin', buffer)
			const data = readFileSync('${dir}/arraybuffer.bin')
			console.log(JSON.stringify({ bytes: Array.from(data) }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { bytes: [0x10, 0x20, 0x30, 0x40] })
	})

	testQnOnly('binary roundtrip preserves data', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			const original = new Uint8Array(256)
			for (let i = 0; i < 256; i++) original[i] = i
			writeFileSync('${dir}/allbytes.bin', original)
			const read = readFileSync('${dir}/allbytes.bin')
			const match = read.every((b, i) => b === original[i])
			console.log(JSON.stringify({ length: read.length, match }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { length: 256, match: true })
	})

	testQnOnly('openSync and closeSync', ({ bin, dir }) => {
		writeFileSync(`${dir}/input.txt`, 'file descriptor test')
		writeFileSync(`${dir}/test.js`, `
			import { openSync, closeSync } from 'node:fs'
			const fh = openSync('${dir}/input.txt', 'r')
			const isObject = typeof fh === 'object' && fh !== null
			const hasFd = typeof fh.fd === 'number' && fh.fd >= 0
			closeSync(fh)
			const fdAfterClose = fh.fd
			console.log(JSON.stringify({ isObject, hasFd, fdAfterClose }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isObject: true, hasFd: true, fdAfterClose: -1 })
	})

	testQnOnly('globSync matches files in current directory', ({ bin, dir }) => {
		writeFileSync(`${dir}/a.js`, 'a')
		writeFileSync(`${dir}/b.js`, 'b')
		writeFileSync(`${dir}/c.txt`, 'c')
		writeFileSync(`${dir}/test.js`, `
			import { globSync } from 'node:fs'
			const files = globSync('*.js', { cwd: '${dir}' })
			console.log(JSON.stringify({ files: files.sort() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { files: ['a.js', 'b.js', 'test.js'] })
	})

	testQnOnly('globSync matches files recursively with **', ({ bin, dir }) => {
		mkdirSync(`${dir}/sub`, { recursive: true })
		writeFileSync(`${dir}/root.js`, 'root')
		writeFileSync(`${dir}/sub/nested.js`, 'nested')
		writeFileSync(`${dir}/sub/other.txt`, 'other')
		writeFileSync(`${dir}/test.js`, `
			import { globSync } from 'node:fs'
			const files = globSync('**/*.js', { cwd: '${dir}' })
			console.log(JSON.stringify({ files: files.sort() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.files.includes('root.js'))
		assert.ok(result.files.includes('sub/nested.js'))
		assert.ok(!result.files.includes('sub/other.txt'))
	})

	testQnOnly('globSync with specific subdirectory pattern', ({ bin, dir }) => {
		mkdirSync(`${dir}/src`, { recursive: true })
		mkdirSync(`${dir}/lib`, { recursive: true })
		writeFileSync(`${dir}/src/main.js`, 'main')
		writeFileSync(`${dir}/src/util.js`, 'util')
		writeFileSync(`${dir}/lib/helper.js`, 'helper')
		writeFileSync(`${dir}/test.js`, `
			import { globSync } from 'node:fs'
			const files = globSync('src/*.js', { cwd: '${dir}' })
			console.log(JSON.stringify({ files: files.sort() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { files: ['src/main.js', 'src/util.js'] })
	})

	testQnOnly('globSync with exclude function', ({ bin, dir }) => {
		mkdirSync(`${dir}/node_modules/pkg`, { recursive: true })
		writeFileSync(`${dir}/app.js`, 'app')
		writeFileSync(`${dir}/node_modules/pkg/index.js`, 'pkg')
		writeFileSync(`${dir}/test.js`, `
			import { globSync } from 'node:fs'
			const files = globSync('**/*.js', {
				cwd: '${dir}',
				exclude: (dirent) => dirent.name === 'node_modules'
			})
			console.log(JSON.stringify({ files: files.sort() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.files.includes('app.js'))
		assert.ok(!result.files.some(f => f.includes('node_modules')))
	})

	testQnOnly('globSync with negation pattern', ({ bin, dir }) => {
		writeFileSync(`${dir}/a.js`, 'a')
		writeFileSync(`${dir}/b.test.js`, 'b')
		writeFileSync(`${dir}/c.js`, 'c')
		writeFileSync(`${dir}/test.js`, `
			import { globSync } from 'node:fs'
			const files = globSync(['*.js', '!*.test.js'], { cwd: '${dir}' })
			console.log(JSON.stringify({ files: files.sort() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.files.includes('a.js'))
		assert.ok(result.files.includes('c.js'))
		assert.ok(!result.files.includes('b.test.js'))
	})

	testQnOnly('globSync with withFileTypes option', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.js`, 'content')
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { globSync } from 'node:fs'
			const entries = globSync('*', { cwd: '${dir}', withFileTypes: true })
			const fileEntry = entries.find(e => e.name === 'file.js')
			const dirEntry = entries.find(e => e.name === 'subdir')
			console.log(JSON.stringify({
				fileIsFile: fileEntry?.isFile(),
				fileIsDir: fileEntry?.isDirectory(),
				dirIsFile: dirEntry?.isFile(),
				dirIsDir: dirEntry?.isDirectory()
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			fileIsFile: true,
			fileIsDir: false,
			dirIsFile: false,
			dirIsDir: true
		})
	})

	testQnOnly('globSync with brace expansion pattern', ({ bin, dir }) => {
		writeFileSync(`${dir}/app.js`, 'js')
		writeFileSync(`${dir}/app.ts`, 'ts')
		writeFileSync(`${dir}/app.css`, 'css')
		writeFileSync(`${dir}/test.js`, `
			import { globSync } from 'node:fs'
			const files = globSync('*.{js,ts}', { cwd: '${dir}' })
			console.log(JSON.stringify({ files: files.sort() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.files.includes('app.js'))
		assert.ok(result.files.includes('app.ts'))
		assert.ok(!result.files.includes('app.css'))
	})

	testQnOnly('glob async iterator', ({ bin, dir }) => {
		writeFileSync(`${dir}/a.js`, 'a')
		writeFileSync(`${dir}/b.js`, 'b')
		writeFileSync(`${dir}/test.js`, `
			import { glob } from 'node:fs'
			const files = []
			for await (const file of glob('*.js', { cwd: '${dir}' })) {
				files.push(file)
			}
			console.log(JSON.stringify({ files: files.sort() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { files: ['a.js', 'b.js', 'test.js'] })
	})

	testQnOnly('globSync with question mark wildcard', ({ bin, dir }) => {
		writeFileSync(`${dir}/a1.js`, 'a1')
		writeFileSync(`${dir}/a2.js`, 'a2')
		writeFileSync(`${dir}/ab.js`, 'ab')
		writeFileSync(`${dir}/test.js`, `
			import { globSync } from 'node:fs'
			const files = globSync('a?.js', { cwd: '${dir}' })
			console.log(JSON.stringify({ files: files.sort() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.files.includes('a1.js'))
		assert.ok(result.files.includes('a2.js'))
		assert.ok(result.files.includes('ab.js'))
	})

	testQnOnly('globSync with character class', ({ bin, dir }) => {
		writeFileSync(`${dir}/file1.txt`, '1')
		writeFileSync(`${dir}/file2.txt`, '2')
		writeFileSync(`${dir}/filea.txt`, 'a')
		writeFileSync(`${dir}/test.js`, `
			import { globSync } from 'node:fs'
			const files = globSync('file[0-9].txt', { cwd: '${dir}' })
			console.log(JSON.stringify({ files: files.sort() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.files.includes('file1.txt'))
		assert.ok(result.files.includes('file2.txt'))
		assert.ok(!result.files.includes('filea.txt'))
	})

	testQnOnly('globSync empty result for non-matching pattern', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { globSync } from 'node:fs'
			const files = globSync('*.nonexistent', { cwd: '${dir}' })
			console.log(JSON.stringify({ files, length: files.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { files: [], length: 0 })
	})

	test('chmodSync changes file mode', ({ bin, dir }) => {
		writeFileSync(`${dir}/target.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { chmodSync, statSync } from 'node:fs'
			const before = statSync('${dir}/target.txt').mode & 0o777
			chmodSync('${dir}/target.txt', 0o755)
			const after = statSync('${dir}/target.txt').mode & 0o777
			console.log(JSON.stringify({ before: before.toString(8), after: after.toString(8) }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.after, '755')
	})

	test('cpSync copies a single file', ({ bin, dir }) => {
		writeFileSync(`${dir}/source.txt`, 'file content')
		writeFileSync(`${dir}/test.js`, `
			import { cpSync, readFileSync } from 'node:fs'
			cpSync('${dir}/source.txt', '${dir}/dest.txt')
			console.log(JSON.stringify({ content: readFileSync('${dir}/dest.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'file content' })
	})

	test('cpSync copies directory recursively', ({ bin, dir }) => {
		mkdirSync(`${dir}/srcdir`)
		mkdirSync(`${dir}/srcdir/subdir`)
		writeFileSync(`${dir}/srcdir/file1.txt`, 'content1')
		writeFileSync(`${dir}/srcdir/subdir/file2.txt`, 'content2')
		writeFileSync(`${dir}/test.js`, `
			import { cpSync, readdirSync, readFileSync } from 'node:fs'
			cpSync('${dir}/srcdir', '${dir}/destdir', { recursive: true })
			const files = readdirSync('${dir}/destdir').sort()
			const subfiles = readdirSync('${dir}/destdir/subdir').sort()
			const content1 = readFileSync('${dir}/destdir/file1.txt', 'utf8')
			const content2 = readFileSync('${dir}/destdir/subdir/file2.txt', 'utf8')
			console.log(JSON.stringify({ files, subfiles, content1, content2 }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			files: ['file1.txt', 'subdir'],
			subfiles: ['file2.txt'],
			content1: 'content1',
			content2: 'content2'
		})
	})

	test('cpSync preserves file mode', ({ bin, dir }) => {
		writeFileSync(`${dir}/exec.sh`, '#!/bin/sh')
		writeFileSync(`${dir}/test.js`, `
			import { cpSync, chmodSync, statSync } from 'node:fs'
			chmodSync('${dir}/exec.sh', 0o755)
			cpSync('${dir}/exec.sh', '${dir}/exec-copy.sh')
			const mode = statSync('${dir}/exec-copy.sh').mode & 0o777
			console.log(JSON.stringify({ mode: mode.toString(8) }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { mode: '755' })
	})

	test('copyFileSync copies a file', ({ bin, dir }) => {
		writeFileSync(`${dir}/original.txt`, 'original content')
		writeFileSync(`${dir}/test.js`, `
			import { copyFileSync, readFileSync } from 'node:fs'
			copyFileSync('${dir}/original.txt', '${dir}/copy.txt')
			console.log(JSON.stringify({ content: readFileSync('${dir}/copy.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'original content' })
	})

	test('appendFileSync appends to existing file', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, appendFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/append.txt', 'hello')
			appendFileSync('${dir}/append.txt', ' world')
			console.log(JSON.stringify({ content: readFileSync('${dir}/append.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'hello world' })
	})

	test('appendFileSync creates file if not exists', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { appendFileSync, readFileSync } from 'node:fs'
			appendFileSync('${dir}/new.txt', 'created')
			console.log(JSON.stringify({ content: readFileSync('${dir}/new.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'created' })
	})

	test('appendFileSync multiple appends', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { appendFileSync, readFileSync } from 'node:fs'
			appendFileSync('${dir}/multi.txt', 'line1\\n')
			appendFileSync('${dir}/multi.txt', 'line2\\n')
			appendFileSync('${dir}/multi.txt', 'line3')
			console.log(JSON.stringify({ content: readFileSync('${dir}/multi.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'line1\nline2\nline3' })
	})

	test('readdirSync with withFileTypes returns Dirent objects', ({ bin, dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/file.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { readdirSync } from 'node:fs'
			const entries = readdirSync('${dir}', { withFileTypes: true })
			const file = entries.find(e => e.name === 'file.txt')
			const subdir = entries.find(e => e.name === 'subdir')
			console.log(JSON.stringify({
				fileIsFile: file.isFile(),
				fileIsDir: file.isDirectory(),
				subdirIsFile: subdir.isFile(),
				subdirIsDir: subdir.isDirectory(),
				hasParentPath: typeof file.parentPath === 'string'
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			fileIsFile: true,
			fileIsDir: false,
			subdirIsFile: false,
			subdirIsDir: true,
			hasParentPath: true
		})
	})

	test('readdirSync withFileTypes detects symlinks', ({ bin, dir }) => {
		writeFileSync(`${dir}/target.txt`, 'target')
		writeFileSync(`${dir}/test.js`, `
			import { readdirSync, symlinkSync } from 'node:fs'
			symlinkSync('${dir}/target.txt', '${dir}/link.txt')
			const entries = readdirSync('${dir}', { withFileTypes: true })
			const link = entries.find(e => e.name === 'link.txt')
			console.log(JSON.stringify({
				isSymlink: link.isSymbolicLink(),
				isFile: link.isFile()
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			isSymlink: true,
			isFile: false
		})
	})

	test('readdirSync without withFileTypes returns strings', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { readdirSync } from 'node:fs'
			const entries = readdirSync('${dir}')
			const types = entries.map(e => typeof e)
			console.log(JSON.stringify({ allStrings: types.every(t => t === 'string') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { allStrings: true })
	})

	// Regression: readdirSync({withFileTypes:true}) used to do a separate
	// lstat per entry, racing against concurrent deletes and throwing ENOENT
	// for entries that disappeared between the readdir and their lstat.
	// The fix makes Dirent.type come from d_type in the readdir syscall itself,
	// matching Node's behavior. This test races readdirSync against a shell
	// subprocess that deletes files, and asserts no ENOENT is raised.
	test('readdirSync({withFileTypes}) survives concurrent delete', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
			import { spawn } from 'node:child_process'
			const d = '${dir}/race'
			mkdirSync(d)
			const N = 200
			for (let i = 0; i < N; i++) writeFileSync(d + '/f' + i, '')
			// POSIX shell subprocess deletes entries in a tight loop.
			const deleter = spawn('sh', ['-c',
				'i=0; while [ $i -lt ' + N + ' ]; do rm -f "' + d + '/f$i"; i=$((i+1)); done'])
			let ok = true, err = null
			try {
				// Hammer readdirSync while files are being deleted.
				for (let i = 0; i < 1000; i++) {
					readdirSync(d, { withFileTypes: true })
				}
			} catch (e) { ok = false; err = String(e) }
			deleter.kill()
			console.log(JSON.stringify({ ok, err }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const { ok, err } = JSON.parse(output)
		assert.strictEqual(ok, true, `readdirSync threw during concurrent delete: ${err}`)
	})
})
