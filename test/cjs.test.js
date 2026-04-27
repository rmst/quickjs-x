import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { testQnOnly, $ } from './util.js'

describe('CommonJS import support', () => {

	describe('.cjs extension', () => {
		testQnOnly('import default from .cjs file', ({ bin, dir }) => {
			writeFileSync(join(dir, 'lib.cjs'), `module.exports = { hello: "world" }`)
			writeFileSync(join(dir, 'main.js'), `
				import lib from "./lib.cjs"
				console.log(lib.hello)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, 'world')
		})

		testQnOnly('module.exports = function', ({ bin, dir }) => {
			writeFileSync(join(dir, 'add.cjs'), `module.exports = function(a, b) { return a + b }`)
			writeFileSync(join(dir, 'main.js'), `
				import add from "./add.cjs"
				console.log(add(3, 4))
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, '7')
		})

		testQnOnly('exports.property assignment', ({ bin, dir }) => {
			writeFileSync(join(dir, 'lib.cjs'), `
				exports.x = 10
				exports.y = 20
			`)
			writeFileSync(join(dir, 'main.js'), `
				import lib from "./lib.cjs"
				console.log(lib.x + lib.y)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, '30')
		})

		testQnOnly('module.exports = class', ({ bin, dir }) => {
			writeFileSync(join(dir, 'MyClass.cjs'), `
				class MyClass {
					constructor(val) { this.val = val }
					get() { return this.val }
				}
				module.exports = MyClass
			`)
			writeFileSync(join(dir, 'main.js'), `
				import MyClass from "./MyClass.cjs"
				const obj = new MyClass(42)
				console.log(obj.get())
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, '42')
		})
	})

	describe('package.json type: commonjs', () => {
		testQnOnly('.js files treated as CJS with type: commonjs', ({ bin, dir }) => {
			mkdirSync(join(dir, 'cjspkg'))
			writeFileSync(join(dir, 'cjspkg', 'package.json'), '{"type": "commonjs"}')
			writeFileSync(join(dir, 'cjspkg', 'index.js'), `exports.value = 42`)
			writeFileSync(join(dir, 'main.js'), `
				import pkg from "./cjspkg/index.js"
				console.log(pkg.value)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, '42')
		})

		testQnOnly('.js files without type field detected as ESM by content', ({ bin, dir }) => {
			writeFileSync(join(dir, 'lib.js'), `export const msg = "esm"`)
			writeFileSync(join(dir, 'main.js'), `
				import { msg } from "./lib.js"
				console.log(msg)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, 'esm')
		})

		testQnOnly('.js files without type field detected as CJS by content', ({ bin, dir }) => {
			// piexifjs-style: CJS .js file with no package.json type field.
			// Should auto-detect as CJS (matches Node 22.7+ behavior).
			writeFileSync(join(dir, 'lib.js'), `module.exports = { hello: "world" }`)
			writeFileSync(join(dir, 'main.js'), `
				import lib from "./lib.js"
				console.log(lib.hello)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, 'world')
		})

		testQnOnly('.js with type: module stays ESM regardless of content', ({ bin, dir }) => {
			mkdirSync(join(dir, 'esmpkg'))
			writeFileSync(join(dir, 'esmpkg', 'package.json'), '{"type": "module"}')
			writeFileSync(join(dir, 'esmpkg', 'lib.js'), `export const n = 7`)
			writeFileSync(join(dir, 'main.js'), `
				import { n } from "./esmpkg/lib.js"
				console.log(n)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, '7')
		})
	})

	describe('require() chains', () => {
		testQnOnly('CJS file requiring another CJS file', ({ bin, dir }) => {
			writeFileSync(join(dir, 'a.cjs'), `
				const b = require("./b.cjs")
				module.exports = { sum: b.x + b.y }
			`)
			writeFileSync(join(dir, 'b.cjs'), `
				exports.x = 10
				exports.y = 20
			`)
			writeFileSync(join(dir, 'main.js'), `
				import a from "./a.cjs"
				console.log(a.sum)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, '30')
		})

		testQnOnly('require resolves .cjs extension automatically', ({ bin, dir }) => {
			writeFileSync(join(dir, 'lib.cjs'), `
				const helper = require("./helper")
				module.exports = helper.msg
			`)
			writeFileSync(join(dir, 'helper.cjs'), `module.exports = { msg: "found" }`)
			writeFileSync(join(dir, 'main.js'), `
				import msg from "./lib.cjs"
				console.log(msg)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, 'found')
		})

		testQnOnly('three-level require chain', ({ bin, dir }) => {
			writeFileSync(join(dir, 'a.cjs'), `
				const b = require("./b.cjs")
				module.exports = b + " -> a"
			`)
			writeFileSync(join(dir, 'b.cjs'), `
				const c = require("./c.cjs")
				module.exports = c + " -> b"
			`)
			writeFileSync(join(dir, 'c.cjs'), `module.exports = "c"`)
			writeFileSync(join(dir, 'main.js'), `
				import result from "./a.cjs"
				console.log(result)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, 'c -> b -> a')
		})
	})

	describe('require JSON', () => {
		testQnOnly('require a JSON file', ({ bin, dir }) => {
			writeFileSync(join(dir, 'data.json'), '{"name": "test", "version": "1.0.0"}')
			writeFileSync(join(dir, 'lib.cjs'), `
				const data = require("./data.json")
				module.exports = data.name + "@" + data.version
			`)
			writeFileSync(join(dir, 'main.js'), `
				import result from "./lib.cjs"
				console.log(result)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, 'test@1.0.0')
		})
	})

	describe('__dirname and __filename', () => {
		testQnOnly('__dirname and __filename are set correctly', ({ bin, dir }) => {
			writeFileSync(join(dir, 'lib.cjs'), `
				module.exports = {
					hasDir: typeof __dirname === "string" && __dirname.length > 0,
					hasFile: typeof __filename === "string" && __filename.endsWith("lib.cjs"),
				}
			`)
			writeFileSync(join(dir, 'main.js'), `
				import info from "./lib.cjs"
				console.log(JSON.stringify(info))
			`)
			const result = JSON.parse($`${bin} ${dir}/main.js`)
			assert.strictEqual(result.hasDir, true)
			assert.strictEqual(result.hasFile, true)
		})
	})

	describe('circular dependencies', () => {
		testQnOnly('circular require returns partial exports', ({ bin, dir }) => {
			writeFileSync(join(dir, 'a.cjs'), `
				exports.fromA = "a"
				const b = require("./b.cjs")
				exports.gotFromB = b.fromB
			`)
			writeFileSync(join(dir, 'b.cjs'), `
				exports.fromB = "b"
				const a = require("./a.cjs")
				exports.gotFromA = a.fromA
			`)
			writeFileSync(join(dir, 'main.js'), `
				import a from "./a.cjs"
				console.log(JSON.stringify({ fromA: a.fromA, gotFromB: a.gotFromB }))
			`)
			const result = JSON.parse($`${bin} ${dir}/main.js`)
			assert.strictEqual(result.fromA, 'a')
			assert.strictEqual(result.gotFromB, 'b')
		})
	})

	describe('node_modules CJS packages', () => {
		testQnOnly('import CJS package from node_modules', ({ bin, dir }) => {
			const pkgDir = join(dir, 'node_modules', 'my-cjs-pkg')
			mkdirSync(pkgDir, { recursive: true })
			writeFileSync(join(pkgDir, 'package.json'), '{"name": "my-cjs-pkg", "type": "commonjs", "main": "index.js"}')
			writeFileSync(join(pkgDir, 'index.js'), `
				const helper = require("./helper")
				module.exports = { value: helper.compute() }
			`)
			writeFileSync(join(pkgDir, 'helper.js'), `
				module.exports = { compute: () => 42 }
			`)
			writeFileSync(join(dir, 'main.js'), `
				import pkg from "my-cjs-pkg"
				console.log(pkg.value)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, '42')
		})

		testQnOnly('CJS package with require condition used by internal require', ({ bin, dir }) => {
			const pkgDir = join(dir, 'node_modules', 'dual-pkg')
			mkdirSync(pkgDir, { recursive: true })
			writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
				name: "dual-pkg",
				type: "commonjs",
				exports: {
					".": {
						require: "./index.js",
						default: "./index.js"
					}
				}
			}))
			writeFileSync(join(pkgDir, 'index.js'), `module.exports = { format: "cjs" }`)
			writeFileSync(join(dir, 'wrapper.cjs'), `
				// CJS code using require() should resolve via "require" condition
				const pkg = require("dual-pkg")
				module.exports = pkg
			`)
			writeFileSync(join(dir, 'main.js'), `
				import pkg from "./wrapper.cjs"
				console.log(pkg.format)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, 'cjs')
		})
	})

	describe('module caching', () => {
		testQnOnly('same module required twice returns cached instance', ({ bin, dir }) => {
			writeFileSync(join(dir, 'counter.cjs'), `
				let count = 0
				module.exports = { inc: () => ++count, get: () => count }
			`)
			writeFileSync(join(dir, 'a.cjs'), `
				const counter = require("./counter.cjs")
				counter.inc()
				module.exports = counter.get()
			`)
			writeFileSync(join(dir, 'b.cjs'), `
				const counter = require("./counter.cjs")
				counter.inc()
				module.exports = counter.get()
			`)
			writeFileSync(join(dir, 'main.js'), `
				import aVal from "./a.cjs"
				import bVal from "./b.cjs"
				console.log(aVal, bVal)
			`)
			// Both a and b import counter.cjs. a increments to 1, b increments to 2.
			// But since a.cjs and b.cjs are loaded as separate ESM modules,
			// each gets its own __cjsLoad call. The require cache inside CJS
			// ensures counter.cjs is shared.
			assert.strictEqual($`${bin} ${dir}/main.js`, '1 2')
		})
	})

	describe('createRequire', () => {
		testQnOnly('createRequire from qn:cjs', ({ bin, dir }) => {
			writeFileSync(join(dir, 'data.cjs'), `module.exports = { value: 99 }`)
			writeFileSync(join(dir, 'main.js'), `
				import { createRequire } from "qn:cjs"
				const require = createRequire(import.meta.filename)
				const data = require("./data.cjs")
				console.log(data.value)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, '99')
		})

		testQnOnly('createRequire with file:// URL', ({ bin, dir }) => {
			writeFileSync(join(dir, 'lib.cjs'), `module.exports = "from-require"`)
			writeFileSync(join(dir, 'main.js'), `
				import { createRequire } from "qn:cjs"
				const require = createRequire("file://" + import.meta.filename)
				console.log(require("./lib.cjs"))
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, 'from-require')
		})

		testQnOnly('createRequire from node:module (Node.js compat)', ({ bin, dir }) => {
			writeFileSync(join(dir, 'data.cjs'), `module.exports = { compat: true }`)
			writeFileSync(join(dir, 'main.js'), `
				import { createRequire } from "node:module"
				const require = createRequire(import.meta.filename)
				const data = require("./data.cjs")
				console.log(data.compat)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, 'true')
		})
	})

	describe('error handling', () => {
		testQnOnly('require of nonexistent module throws', ({ bin, dir }) => {
			writeFileSync(join(dir, 'lib.cjs'), `
				try {
					require("./nonexistent.cjs")
					module.exports = "no error"
				} catch (e) {
					module.exports = e.message.includes("Cannot find module") ? "correct error" : e.message
				}
			`)
			writeFileSync(join(dir, 'main.js'), `
				import result from "./lib.cjs"
				console.log(result)
			`)
			assert.strictEqual($`${bin} ${dir}/main.js`, 'correct error')
		})
	})
})
