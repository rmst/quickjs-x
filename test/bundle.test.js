import { describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mktempdir, QN } from './util.js'
import { build, traceModuleGraph } from '../node/qn/bundle.js'

// Run the bundle through qn and collect stdout.
function runBundle(path, extraEnv = {}) {
	return execFileSync(QN(), [path], { encoding: 'utf8', env: { ...process.env, ...extraEnv } }).trim()
}

describe('qn bundle', () => {
	test('bundles a single entry with a relative import', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'import { greet } from "./greet.js"\nconsole.log(greet("world"))\n')
			writeFileSync(join(dir, 'greet.js'), 'export const greet = (n) => `hi ${n}`\n')
			const out = await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(out.success, true)
			assert.strictEqual(out.outputs.length, 1)
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'hi world')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('strips TypeScript types', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.ts'), 'const n: number = 7\nconsole.log(n)\n')
			await build({ entrypoints: [join(dir, 'main.ts')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '7')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('walks node_modules with package.json exports', async () => {
		const dir = mktempdir()
		try {
			const pkgDir = join(dir, 'node_modules', 'tinylib')
			mkdirSync(join(pkgDir, 'src'), { recursive: true })
			writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
				name: 'tinylib',
				exports: { '.': './src/index.js', './util': './src/util.js' },
			}))
			writeFileSync(join(pkgDir, 'src/index.js'), 'import { upper } from "./util.js"\nexport const hello = (s) => upper(`hi ${s}`)\n')
			writeFileSync(join(pkgDir, 'src/util.js'), 'export const upper = (s) => s.toUpperCase()\n')
			writeFileSync(join(dir, 'main.js'), 'import { hello } from "tinylib"\nconsole.log(hello("qn"))\n')

			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'HI QN')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('handles package.json exports subpath via conditions', async () => {
		const dir = mktempdir()
		try {
			const pkgDir = join(dir, 'node_modules', 'condlib')
			mkdirSync(pkgDir, { recursive: true })
			writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
				name: 'condlib',
				exports: {
					'.': {
						'browser': './browser.js',
						'default': './node.js',
					},
				},
			}))
			writeFileSync(join(pkgDir, 'browser.js'), 'export const kind = "browser"\n')
			writeFileSync(join(pkgDir, 'node.js'), 'export const kind = "node"\n')
			writeFileSync(join(dir, 'main.js'), 'import { kind } from "condlib"\nconsole.log(kind)\n')

			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), target: 'browser' })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'browser')

			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), target: 'node' })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'node')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('default, named, and namespace imports together', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const bar = "BAR"\nexport default "FOO"\n')
			writeFileSync(join(dir, 'main.js'),
				'import foo, { bar } from "./mod.js"\n' +
				'import * as ns from "./mod.js"\n' +
				'console.log(foo, bar, ns.bar, ns.default)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'FOO BAR BAR FOO')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('re-exports from another module', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const bar = "BAR"\n')
			writeFileSync(join(dir, 'rex.js'), 'export { bar as reA } from "./mod.js"\nexport const reB = "B"\n')
			writeFileSync(join(dir, 'main.js'), 'import { reA, reB } from "./rex.js"\nconsole.log(reA, reB)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'BAR B')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('handles circular imports with call-time access', async () => {
		const dir = mktempdir()
		try {
			// Modules must access each other's bindings at call time, not at
			// module-init time. This matches how Node.js/CJS handles cycles.
			writeFileSync(join(dir, 'a.js'), 'import { b } from "./b.js"\nexport const a = () => "A-" + b()\n')
			writeFileSync(join(dir, 'b.js'), 'import { a } from "./a.js"\nexport const b = () => a.name\n')
			writeFileSync(join(dir, 'main.js'), 'import { a } from "./a.js"\nconsole.log(a())\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'A-a')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('bundles JSX with automatic runtime and custom import source', async () => {
		const dir = mktempdir()
		try {
			const rt = join(dir, 'node_modules', 'myjsx', 'jsx-runtime')
			mkdirSync(rt, { recursive: true })
			writeFileSync(join(dir, 'node_modules/myjsx/package.json'),
				JSON.stringify({ name: 'myjsx', exports: { './jsx-runtime': './jsx-runtime/index.js' } }))
			writeFileSync(join(rt, 'index.js'),
				'export const jsx = (t, p) => ({ t, p })\n' +
				'export const jsxs = jsx\n' +
				'export const Fragment = "F"\n')
			writeFileSync(join(dir, 'main.tsx'),
				'const el = <div className="x">hi</div>\nconsole.log(JSON.stringify(el))\n')
			await build({
				entrypoints: [join(dir, 'main.tsx')],
				outdir: join(dir, 'dist'),
				jsxImportSource: 'myjsx',
			})
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '{"t":"div","p":{"className":"x","children":"hi"}}')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('@jsxImportSource pragma overrides the bundle default', async () => {
		const dir = mktempdir()
		try {
			const rt = join(dir, 'node_modules', 'myjsx', 'jsx-runtime')
			mkdirSync(rt, { recursive: true })
			writeFileSync(join(dir, 'node_modules/myjsx/package.json'),
				JSON.stringify({ name: 'myjsx', exports: { './jsx-runtime': './jsx-runtime/index.js' } }))
			writeFileSync(join(rt, 'index.js'),
				'export const jsx = (t, p) => ({ t, p })\n' +
				'export const jsxs = jsx\n' +
				'export const Fragment = "F"\n')
			// No --jsx-import-source; the pragma alone must steer resolution.
			writeFileSync(join(dir, 'main.tsx'),
				'/** @jsxImportSource myjsx */\n' +
				'const el = <div className="x">hi</div>\nconsole.log(JSON.stringify(el))\n')
			await build({ entrypoints: [join(dir, 'main.tsx')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '{"t":"div","p":{"className":"x","children":"hi"}}')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('leaves external specifiers in place', async () => {
		const dir = mktempdir()
		try {
			// "left-in-place" external: we can't resolve it, so the require()
			// call remains. Our test shim runs the bundle in an environment
			// that defines the global `require` to fake the external.
			writeFileSync(join(dir, 'main.js'), 'import { v } from "some-external"\nconsole.log(v)\n')
			await build({
				entrypoints: [join(dir, 'main.js')],
				outdir: join(dir, 'dist'),
				external: ['some-external'],
			})
			// Verify the specifier is preserved in the output.
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			assert.match(bundle, /require\(['"]some-external['"]\)/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('bundles dynamic import() of a literal specifier', async () => {
		const dir = mktempdir()
		try {
			// The bundler does not support top-level await (modules are wrapped
			// in a sync function), so the test uses .then() instead.
			writeFileSync(join(dir, 'mod.js'), 'export const x = 42\n')
			writeFileSync(join(dir, 'main.js'),
				'import("./mod.js").then(m => console.log(m.x))\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '42')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('produces iife format when requested', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'console.log("iife")\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), format: 'iife' })
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			assert.ok(bundle.trimStart().startsWith('(function(){'))
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'iife')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('CLI: qn build produces an output file', () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'console.log("via cli")\n')
			execFileSync(QN(), ['build', 'main.js', '--outdir=dist'], { cwd: dir, encoding: 'utf8' })
			const result = execFileSync(QN(), [join(dir, 'dist/main.js')], { encoding: 'utf8' }).trim()
			assert.strictEqual(result, 'via cli')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('errors on node: imports in browser target', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'import { readFileSync } from "node:fs"\nconsole.log(readFileSync)\n')
			let err
			try {
				await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), target: 'browser' })
			} catch (e) { err = e }
			assert.ok(err, 'expected build to throw')
			assert.match(err.message, /node:fs/)
			assert.match(err.message, /browser/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('auto-externalises node: imports in node target', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'import { readFileSync } from "node:fs"\nconsole.log(typeof readFileSync)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), target: 'node' })
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			assert.match(bundle, /require\(["']node:fs["']\)/)
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'function')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('errors with source filename on top-level await', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const x = 1\n')
			writeFileSync(join(dir, 'main.js'), 'import("./mod.js")\nawait Promise.resolve()\nconsole.log("done")\n')
			let err
			try {
				await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			} catch (e) { err = e }
			assert.ok(err, 'expected build to throw')
			assert.match(err.message, /top-level await is not supported/)
			assert.match(err.message, /main\.js/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('ignores require-like text in template literals and regex literals', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const v = 1\n')
			writeFileSync(join(dir, 'main.js'),
				'import { v } from "./mod.js"\n' +
				'const a = `template with require(\'./ghost.js\') inside`\n' +
				'const b = /import\\([\'"]?\\.\\/also-ghost\\.js[\'"]?\\)/\n' +
				'console.log(a.length, b.source.length, v)\n')
			const result = await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.deepStrictEqual(result.logs, [])
			const parts = runBundle(join(dir, 'dist/main.js')).split(' ')
			assert.strictEqual(parts[2], '1')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('handles multi-line import statements', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const a = 1\nexport const b = 2\nexport const c = 3\n')
			writeFileSync(join(dir, 'main.js'),
				'import {\n' +
				'  a,\n' +
				'  b,\n' +
				'  c,\n' +
				'} from\n' +
				'  "./mod.js"\n' +
				'console.log(a, b, c)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '1 2 3')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('leaves bare `require` identifier references alone', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const x = 99\n')
			// Bare `require` references (no call with literal arg) must not be
			// rewritten — only literal `require("./path")` calls are.
			writeFileSync(join(dir, 'main.js'),
				'import { x } from "./mod.js"\n' +
				'const fake = typeof require === "function"\n' +
				'console.log(x, fake)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			assert.match(bundle, /require\(["']m\d+["']\)/)
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '99 true')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('rewrites literal require("./...") in hand-written CJS files', async () => {
		const dir = mktempdir()
		try {
			// dep.js is plain CJS, mixed-case extension to verify .js → .js probe.
			writeFileSync(join(dir, 'dep.js'), 'module.exports = { value: 42 }\n')
			// main.cjs uses CJS require with no extension — resolver must probe.
			writeFileSync(join(dir, 'main.cjs'),
				'const dep = require("./dep")\n' +
				'console.log(dep.value)\n')
			await build({ entrypoints: [join(dir, 'main.cjs')], outdir: join(dir, 'dist') })
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			// The relative spec must be rewritten to a bundle-internal id.
			assert.doesNotMatch(bundle, /require\(["']\.\/dep["']\)/)
			assert.match(bundle, /require\(["']m\d+["']\)/)
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '42')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('rewrites require() across .js files mixed with TS/ESM importers', async () => {
		// Reproduces the katex case: a TS entry imports a CJS .js helper that
		// itself uses `require("./...")` to pull a sibling .js. Without CJS-
		// require rewriting, the sibling load fails at runtime.
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'leaf.js'), 'module.exports = "leaf-value"\n')
			writeFileSync(join(dir, 'cjs-helper.js'),
				'const leaf = require("./leaf")\n' +
				'module.exports = { wrapped: leaf }\n')
			writeFileSync(join(dir, 'main.ts'),
				'import helper from "./cjs-helper.js"\n' +
				'console.log((helper as any).wrapped)\n')
			await build({ entrypoints: [join(dir, 'main.ts')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'leaf-value')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('does not rewrite require() in ESM files', async () => {
		// In a file with any ESM import/export syntax, `require()` is left
		// alone (esbuild-style format split). This preserves the
		// createRequire(import.meta.url) pattern: at runtime that `require` is
		// a user-defined helper, not a bundle-time spec to resolve. Here we
		// confirm the literal "./not-bundled" never reaches the resolver
		// (no "unresolved" warning) and isn't materialised in the bundle.
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const x = 1\n')
			writeFileSync(join(dir, 'main.js'),
				'import { x } from "./mod.js"\n' +
				// Dead-code path so the bundle runs cleanly even though the
				// runtime require would fail; we're only asserting bundler
				// behaviour, not call semantics.
				'const tryIt = () => require("./not-bundled")\n' +
				'console.log(x, typeof tryIt)\n')
			const result = await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.deepStrictEqual(result.logs, [])
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			// The literal must survive as the original spec — the resolver
			// did not rewrite it to a bundle-internal m\d+ id.
			assert.match(bundle, /require\(["']\.\/not-bundled["']\)/)
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '1 function')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('ignores require() inside comments and strings', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const v = 1\n')
			const fakeString = "see require('./nonexistent.js') in string"
			writeFileSync(join(dir, 'main.js'),
				'// fake: require("./ghost.js")\n' +
				'/* also fake: require("./phantom.js") */\n' +
				`const msg = "${fakeString}"\n` +
				'import { v } from "./mod.js"\n' +
				'console.log(msg.length, v)\n')
			// If we mis-parsed the comments/strings we would try to resolve the
			// ghost paths and produce "unresolved" warnings.
			const result = await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.deepStrictEqual(result.logs, [])
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), `${fakeString.length} 1`)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('substitutes import.meta.url / dirname / filename', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'),
				'console.log(import.meta.url)\n' +
				'console.log(import.meta.filename)\n' +
				'console.log(import.meta.dirname)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			const out = runBundle(join(dir, 'dist/main.js'))
			const [url, filename, dirn] = out.split('\n')
			assert.strictEqual(url, 'file://' + join(dir, 'main.js'))
			assert.strictEqual(filename, join(dir, 'main.js'))
			assert.strictEqual(dirn, dir)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('picks production vs development conditions', async () => {
		const dir = mktempdir()
		try {
			const pkgDir = join(dir, 'node_modules', 'envlib')
			mkdirSync(pkgDir, { recursive: true })
			writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
				name: 'envlib',
				exports: {
					'.': {
						'development': './dev.js',
						'production': './prod.js',
						'default': './prod.js',
					},
				},
			}))
			writeFileSync(join(pkgDir, 'dev.js'), 'export const kind = "dev"\n')
			writeFileSync(join(pkgDir, 'prod.js'), 'export const kind = "prod"\n')
			writeFileSync(join(dir, 'main.js'), 'import { kind } from "envlib"\nconsole.log(kind)\n')

			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'prod')

			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), production: false })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'dev')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('detects output collision on duplicate basenames', async () => {
		const dir = mktempdir()
		try {
			mkdirSync(join(dir, 'a'))
			mkdirSync(join(dir, 'b'))
			writeFileSync(join(dir, 'a/main.js'), 'console.log("a")\n')
			writeFileSync(join(dir, 'b/main.js'), 'console.log("b")\n')
			let err
			try {
				await build({
					entrypoints: [join(dir, 'a/main.js'), join(dir, 'b/main.js')],
					outdir: join(dir, 'dist'),
				})
			} catch (e) { err = e }
			assert.ok(err, 'expected build to throw')
			assert.match(err.message, /same output/)
			assert.match(err.message, /main\.js/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('alias rewrites a bare specifier before resolution', async () => {
		const dir = mktempdir()
		try {
			const realPkg = join(dir, 'node_modules', 'realpkg')
			mkdirSync(realPkg, { recursive: true })
			writeFileSync(join(realPkg, 'package.json'), JSON.stringify({ name: 'realpkg', main: 'index.js' }))
			writeFileSync(join(realPkg, 'index.js'), 'export const v = "REAL"\n')
			writeFileSync(join(dir, 'main.js'), 'import { v } from "fakepkg"\nconsole.log(v)\n')
			await build({
				entrypoints: [join(dir, 'main.js')],
				outdir: join(dir, 'dist'),
				alias: { fakepkg: 'realpkg' },
			})
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'REAL')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('alias maps onto an external', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'import { v } from "react"\nconsole.log(v)\n')
			await build({
				entrypoints: [join(dir, 'main.js')],
				outdir: join(dir, 'dist'),
				alias: { react: 'preact-compat' },
				external: ['preact-compat'],
			})
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			assert.match(bundle, /require\(['"]preact-compat['"]\)/)
			assert.doesNotMatch(bundle, /require\(['"]react['"]\)/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('--define replaces a dotted identifier path', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'),
				'const mode = process.env.NODE_ENV\nconsole.log(mode)\n')
			await build({
				entrypoints: [join(dir, 'main.js')],
				outdir: join(dir, 'dist'),
				define: { 'process.env.NODE_ENV': '"production"' },
			})
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'production')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('--define replaces a single identifier reference', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'),
				'console.log(__DEV__ ? "dev" : "prod")\n')
			await build({
				entrypoints: [join(dir, 'main.js')],
				outdir: join(dir, 'dist'),
				define: { '__DEV__': 'false' },
			})
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'prod')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('--define does not match property accesses or declarations', async () => {
		const dir = mktempdir()
		try {
			// `obj.process` is a property access (different `process`).
			// `function process() {}` is a declaration.
			// `"process.env.NODE_ENV"` inside a string must not be replaced.
			writeFileSync(join(dir, 'main.js'),
				'const obj = { process: { env: { NODE_ENV: "kept" } } }\n' +
				'function process() { return "fn" }\n' +
				'const s = "process.env.NODE_ENV"\n' +
				'console.log(obj.process.env.NODE_ENV, process(), s)\n')
			await build({
				entrypoints: [join(dir, 'main.js')],
				outdir: join(dir, 'dist'),
				define: { 'process.env.NODE_ENV': '"REPLACED"' },
			})
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'kept fn process.env.NODE_ENV')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('--define longer paths win over shorter overlapping keys', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'),
				'console.log(typeof process, process.env.NODE_ENV)\n')
			await build({
				entrypoints: [join(dir, 'main.js')],
				outdir: join(dir, 'dist'),
				define: {
					'process': '({env: {NODE_ENV: "fallback"}})',
					'process.env.NODE_ENV': '"production"',
				},
			})
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'object production')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('format=esm exposes the entry exports as real top-level exports', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const greet = (n) => `hi ${n}`\n')
			writeFileSync(join(dir, 'main.js'),
				'import { greet } from "./mod.js"\n' +
				'export const hello = (n) => greet(n).toUpperCase()\n' +
				'export default 42\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			assert.match(bundle, /^export var hello\b/m)
			assert.match(bundle, /^export default\b/m)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('format=esm output is re-bundleable: another build can ingest its exports', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const greet = (n) => `hi ${n}`\n')
			writeFileSync(join(dir, 'lib.js'),
				'import { greet } from "./mod.js"\n' +
				'export const hello = (n) => greet(n).toUpperCase()\n')
			await build({ entrypoints: [join(dir, 'lib.js')], outdir: join(dir, 'dist1') })
			writeFileSync(join(dir, 'app.js'),
				'import { hello } from "./dist1/lib.js"\nconsole.log(hello("qn"))\n')
			await build({ entrypoints: [join(dir, 'app.js')], outdir: join(dir, 'dist2') })
			assert.strictEqual(runBundle(join(dir, 'dist2/app.js')), 'HI QN')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('format=esm preserves named re-exports (export { x } from)', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const a = 1\nexport const b = 2\n')
			writeFileSync(join(dir, 'main.js'),
				'export { a, b as B } from "./mod.js"\n' +
				'export const c = 3\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			writeFileSync(join(dir, 'app.js'),
				'import { a, B, c } from "./dist/main.js"\nconsole.log(a, B, c)\n')
			await build({ entrypoints: [join(dir, 'app.js')], outdir: join(dir, 'dist2') })
			assert.strictEqual(runBundle(join(dir, 'dist2/app.js')), '1 2 3')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('format=esm preserves namespace re-exports (export * as ns from)', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const a = 1\nexport const b = 2\n')
			writeFileSync(join(dir, 'main.js'), 'export * as M from "./mod.js"\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			writeFileSync(join(dir, 'app.js'),
				'import { M } from "./dist/main.js"\nconsole.log(M.a, M.b)\n')
			await build({ entrypoints: [join(dir, 'app.js')], outdir: join(dir, 'dist2') })
			assert.strictEqual(runBundle(join(dir, 'dist2/app.js')), '1 2')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('format=esm errors on `export *` (without `as`)', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const a = 1\n')
			writeFileSync(join(dir, 'main.js'), 'export * from "./mod.js"\n')
			let err
			try {
				await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			} catch (e) { err = e }
			assert.ok(err, 'expected build to throw')
			assert.match(err.message, /export \*/)
			assert.match(err.message, /not supported/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('format=iife keeps closure-wrapped output (no top-level exports)', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'export const x = 1\nconsole.log(x)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), format: 'iife' })
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			assert.match(bundle, /^\(function\(\)\{/)
			assert.doesNotMatch(bundle, /^export /m)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('--define rejects invalid keys', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'console.log(1)\n')
			let err
			try {
				await build({
					entrypoints: [join(dir, 'main.js')],
					outdir: join(dir, 'dist'),
					define: { '1bad': '2' },
				})
			} catch (e) { err = e }
			assert.ok(err, 'expected build to throw')
			assert.match(err.message, /invalid --define key/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('traceModuleGraph', () => {
	const withTemp = (fn) => async () => {
		const dir = mktempdir()
		try { return await fn(dir) } finally { rmSync(dir, { recursive: true }) }
	}

	test('returns just the entry for a leaf file', withTemp(async (dir) => {
		writeFileSync(join(dir, 'main.js'), 'console.log(1)\n')
		const g = traceModuleGraph(join(dir, 'main.js'))
		assert.deepStrictEqual([...g], [join(dir, 'main.js')])
	}))

	test('follows static imports and re-exports', withTemp(async (dir) => {
		writeFileSync(join(dir, 'main.js'), 'import { a } from "./a.js"\nexport * from "./b.js"\nconsole.log(a)\n')
		writeFileSync(join(dir, 'a.js'), 'export const a = 1\n')
		writeFileSync(join(dir, 'b.js'), 'export const b = 2\n')
		const g = traceModuleGraph(join(dir, 'main.js'))
		assert.strictEqual(g.size, 3)
		assert.ok(g.has(join(dir, 'main.js')))
		assert.ok(g.has(join(dir, 'a.js')))
		assert.ok(g.has(join(dir, 'b.js')))
	}))

	test('follows transitive imports', withTemp(async (dir) => {
		writeFileSync(join(dir, 'main.js'), 'import "./a.js"\n')
		writeFileSync(join(dir, 'a.js'), 'import "./b.js"\n')
		writeFileSync(join(dir, 'b.js'), 'export const x = 1\n')
		const g = traceModuleGraph(join(dir, 'main.js'))
		assert.strictEqual(g.size, 3)
	}))

	test('tracks literal dynamic import', withTemp(async (dir) => {
		writeFileSync(join(dir, 'main.js'), 'const m = await import("./lazy.js")\n')
		writeFileSync(join(dir, 'lazy.js'), 'export const hi = 1\n')
		const g = traceModuleGraph(join(dir, 'main.js'))
		assert.ok(g.has(join(dir, 'lazy.js')))
	}))

	test('does not track variable dynamic import', withTemp(async (dir) => {
		writeFileSync(join(dir, 'main.js'), 'const name = "./lazy.js"\nimport(name)\n')
		writeFileSync(join(dir, 'lazy.js'), 'export const hi = 1\n')
		const g = traceModuleGraph(join(dir, 'main.js'))
		assert.ok(!g.has(join(dir, 'lazy.js')), 'variable dynamic import must not be tracked')
		assert.strictEqual(g.size, 1)
	}))

	test('skips node: specifiers', withTemp(async (dir) => {
		writeFileSync(join(dir, 'main.js'), 'import { readFileSync } from "node:fs"\nconsole.log(readFileSync)\n')
		const g = traceModuleGraph(join(dir, 'main.js'))
		assert.strictEqual(g.size, 1)
	}))

	test('tracks .json imports', withTemp(async (dir) => {
		writeFileSync(join(dir, 'main.js'), 'import cfg from "./data.json" with { type: "json" }\nconsole.log(cfg)\n')
		writeFileSync(join(dir, 'data.json'), '{"v":1}')
		const g = traceModuleGraph(join(dir, 'main.js'))
		assert.ok(g.has(join(dir, 'data.json')))
	}))

	test('tracks .ts imports', withTemp(async (dir) => {
		writeFileSync(join(dir, 'main.js'), 'import { v } from "./data.ts"\nconsole.log(v)\n')
		writeFileSync(join(dir, 'data.ts'), 'export const v: number = 1\n')
		const g = traceModuleGraph(join(dir, 'main.js'))
		assert.ok(g.has(join(dir, 'data.ts')))
	}))

	test('silently skips unresolvable bare specifiers', withTemp(async (dir) => {
		writeFileSync(join(dir, 'main.js'), 'import "nonexistent-pkg"\nconsole.log(1)\n')
		const g = traceModuleGraph(join(dir, 'main.js'))
		/* Should not throw; just doesn't add the unresolved dep */
		assert.strictEqual(g.size, 1)
	}))

	test('throws on files with parse errors', withTemp(async (dir) => {
		writeFileSync(join(dir, 'main.js'), 'import "./broken.js"\nimport "./ok.js"\n')
		writeFileSync(join(dir, 'broken.js'), 'this is { not ) valid javascript\n')
		writeFileSync(join(dir, 'ok.js'), 'export const x = 1\n')
		assert.throws(
			() => traceModuleGraph(join(dir, 'main.js')),
			/failed to analyse module graph node .*broken\.js/,
		)
	}))

	test('throws on missing entry', () => {
		assert.throws(() => traceModuleGraph('/nonexistent/path/entry.js'), /entry point not found/)
	})

	test('terminates on circular imports', withTemp(async (dir) => {
		writeFileSync(join(dir, 'a.js'), 'import "./b.js"\nexport const a = 1\n')
		writeFileSync(join(dir, 'b.js'), 'import "./a.js"\nexport const b = 2\n')
		const g = traceModuleGraph(join(dir, 'a.js'))
		assert.strictEqual(g.size, 2)
	}))

	test('walks node_modules', withTemp(async (dir) => {
		const pkgDir = join(dir, 'node_modules', 'tinylib')
		mkdirSync(pkgDir, { recursive: true })
		writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'tinylib', main: 'index.js' }))
		writeFileSync(join(pkgDir, 'index.js'), 'export const v = 1\n')
		writeFileSync(join(dir, 'main.js'), 'import { v } from "tinylib"\nconsole.log(v)\n')
		const g = traceModuleGraph(join(dir, 'main.js'))
		assert.ok(g.has(join(pkgDir, 'index.js')))
	}))
})
