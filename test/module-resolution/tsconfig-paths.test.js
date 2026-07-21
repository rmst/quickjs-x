import { describe, test as nodetest } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QN, QNC } from '../util.js'

const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), 'tsconfig-paths-test-')))

const $ = (strings, ...values) => {
	const cmd = String.raw({ raw: strings }, ...values)
	return execSync(cmd, { encoding: 'utf8', timeout: 30000 }).trim()
}

const test = (name, fn) => nodetest(name, () => {
	const dir = mktempdir()
	try {
		fn({ dir })
	} finally {
		rmSync(dir, { recursive: true })
	}
})

// --------------------------------------------------------------
// Runtime (qn script.js): tsconfig-paths hook applies on bare
// imports that don't resolve via node_modules / NODE_PATH.
// --------------------------------------------------------------
describe('Runtime tsconfig paths', () => {
	test('explicit paths mapping', ({ dir }) => {
		mkdirSync(`${dir}/lib`)
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: { paths: { "foo": ["./lib/foo.js"] } }
		}))
		writeFileSync(`${dir}/lib/foo.js`, `export const v = "mapped";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'foo'
			console.log(v)
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'mapped')
	})

	test('wildcard paths mapping', ({ dir }) => {
		mkdirSync(`${dir}/lib`)
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: { paths: { "lib/*": ["./lib/*"] } }
		}))
		writeFileSync(`${dir}/lib/a.js`, `export const v = "A";`)
		writeFileSync(`${dir}/lib/b.js`, `export const v = "B";`)
		writeFileSync(`${dir}/main.js`, `
			import { v as a } from 'lib/a'
			import { v as b } from 'lib/b'
			console.log(a + b)
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'AB')
	})

	test('baseUrl-only fallback (bare → baseUrl/name)', ({ dir }) => {
		mkdirSync(`${dir}/src`)
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: { baseUrl: "./src" }
		}))
		writeFileSync(`${dir}/src/thing.js`, `export const v = "base";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'thing'
			console.log(v)
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'base')
	})

	test('paths with baseUrl anchors targets at baseUrl', ({ dir }) => {
		mkdirSync(`${dir}/src/lib`, { recursive: true })
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: {
				baseUrl: "./src",
				paths: { "@util/*": ["./lib/*"] }
			}
		}))
		writeFileSync(`${dir}/src/lib/helper.js`, `export const v = "helper";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from '@util/helper'
			console.log(v)
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'helper')
	})

	test('extends chain inherits paths', ({ dir }) => {
		mkdirSync(`${dir}/lib`)
		writeFileSync(`${dir}/tsconfig.base.json`, JSON.stringify({
			compilerOptions: { paths: { "shared/*": ["./lib/*"] } }
		}))
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			extends: "./tsconfig.base.json"
		}))
		writeFileSync(`${dir}/lib/mod.js`, `export const v = "inherited";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'shared/mod'
			console.log(v)
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'inherited')
	})

	// extends: [a, b] — a defines baseUrl, b defines paths. Both should
	// survive in the merged config; naive wholesale-replace would drop one.
	test('multi-extends inherits fields independently', ({ dir }) => {
		mkdirSync(`${dir}/src/lib`, { recursive: true })
		writeFileSync(`${dir}/base-a.json`, JSON.stringify({
			compilerOptions: { baseUrl: "./src" }
		}))
		writeFileSync(`${dir}/base-b.json`, JSON.stringify({
			compilerOptions: { paths: { "@util/*": ["./lib/*"] } }
		}))
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			extends: ["./base-a.json", "./base-b.json"]
		}))
		writeFileSync(`${dir}/src/lib/helper.js`, `export const v = "multi-extends";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from '@util/helper'
			console.log(v)
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'multi-extends')
	})

	test('longest-prefix wildcard wins over catch-all', ({ dir }) => {
		// Both "utils/*" and "*" match "utils/a". The more specific key should win.
		mkdirSync(`${dir}/generic/utils`, { recursive: true })
		mkdirSync(`${dir}/specific`)
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: {
				paths: {
					"*": ["./generic/*"],
					"utils/*": ["./specific/*"]
				}
			}
		}))
		writeFileSync(`${dir}/specific/a.js`, `export const src = "specific";`)
		writeFileSync(`${dir}/generic/utils/a.js`, `export const src = "generic";`)
		writeFileSync(`${dir}/main.js`, `
			import { src } from 'utils/a'
			console.log(src)
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'specific')
	})

	test('exact key wins over wildcard', ({ dir }) => {
		mkdirSync(`${dir}/wild`)
		mkdirSync(`${dir}/exact`)
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: {
				paths: {
					"foo/bar": ["./exact/bar.js"],
					"foo/*": ["./wild/*.js"]
				}
			}
		}))
		writeFileSync(`${dir}/exact/bar.js`, `export const v = "exact";`)
		writeFileSync(`${dir}/wild/bar.js`, `export const v = "wild";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'foo/bar'
			console.log(v)
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'exact')
	})

	test('catch-all * does NOT shadow node_modules packages', ({ dir }) => {
		// xterm.js-like: catch-all paths plus a real node_modules dep.
		// node_modules resolves first; paths are consulted only on miss.
		mkdirSync(`${dir}/node_modules/real`, { recursive: true })
		mkdirSync(`${dir}/src`)
		writeFileSync(`${dir}/node_modules/real/index.js`, `export const src = "node_modules";`)
		writeFileSync(`${dir}/src/real.js`, `export const src = "tsconfig";`)
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: {
				baseUrl: "./src",
				paths: { "*": ["./*"] }
			}
		}))
		writeFileSync(`${dir}/main.js`, `
			import { src } from 'real'
			console.log(src)
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'node_modules')
	})

	test('.ts extension probed for paths targets', ({ dir }) => {
		mkdirSync(`${dir}/lib`)
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: { paths: { "lib/*": ["./lib/*"] } }
		}))
		writeFileSync(`${dir}/lib/util.ts`, `export const v: string = "ts";`)
		writeFileSync(`${dir}/main.ts`, `
			import { v } from 'lib/util'
			console.log(v)
		`)
		assert.strictEqual($`${QN()} ${dir}/main.ts`, 'ts')
	})

	test('jsconfig.json is honored when no tsconfig is present', ({ dir }) => {
		mkdirSync(`${dir}/lib`)
		writeFileSync(`${dir}/jsconfig.json`, JSON.stringify({
			compilerOptions: { paths: { "@lib/*": ["./lib/*"] } }
		}))
		writeFileSync(`${dir}/lib/m.js`, `export const v = "jsc";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from '@lib/m'
			console.log(v)
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'jsc')
	})

	test('no tsconfig → unresolved import still errors', ({ dir }) => {
		writeFileSync(`${dir}/main.js`, `import 'nonexistent-pkg'; console.log('ok')`)
		let errored = false
		try {
			execSync(`${QN()} ${dir}/main.js`, { encoding: 'utf8', stdio: 'pipe' })
		} catch {
			errored = true
		}
		assert.strictEqual(errored, true)
	})

	// Emulates the xterm.js-style layout described in the original
	// feature request:
	//   src/browser/Foo.ts     imports 'common/Lifecycle'
	//   src/browser/tsconfig.json → paths: { "common/*": ["./../common/*"], "*": ["./../*"] }
	test('xterm.js-like layout (nested browser/common with catch-all)', ({ dir }) => {
		mkdirSync(`${dir}/src/browser`, { recursive: true })
		mkdirSync(`${dir}/src/common`, { recursive: true })
		writeFileSync(`${dir}/src/browser/tsconfig.json`, JSON.stringify({
			compilerOptions: {
				paths: {
					"common/*": ["./../common/*"],
					"*": ["./../*"]
				}
			}
		}))
		writeFileSync(`${dir}/src/common/Lifecycle.ts`, `
			export const kind: string = "lifecycle"
		`)
		writeFileSync(`${dir}/src/browser/Public.ts`, `
			import { kind } from 'common/Lifecycle'
			console.log(kind)
		`)
		assert.strictEqual($`${QN()} ${dir}/src/browser/Public.ts`, 'lifecycle')
	})
})

// --------------------------------------------------------------
// Build-time (qn build): bundler reads tsconfig paths too.
// --------------------------------------------------------------
describe('Bundler tsconfig paths', () => {
	test('basic paths mapping resolves through bundler', ({ dir }) => {
		mkdirSync(`${dir}/lib`)
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: { paths: { "foo": ["./lib/foo.js"] } }
		}))
		writeFileSync(`${dir}/lib/foo.js`, `export const v = "bundled";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'foo'
			console.log(v)
		`)
		$`${QN()} build ${dir}/main.js --target=node --outdir=${dir}/dist`
		assert.strictEqual($`${QN()} ${dir}/dist/main.js`, 'bundled')
	})

	test('wildcard with baseUrl', ({ dir }) => {
		mkdirSync(`${dir}/src/lib`, { recursive: true })
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: {
				baseUrl: "./src",
				paths: { "@util/*": ["./lib/*"] }
			}
		}))
		writeFileSync(`${dir}/src/lib/helper.ts`, `export const v: string = "bundled-helper";`)
		writeFileSync(`${dir}/src/main.ts`, `
			import { v } from '@util/helper'
			console.log(v)
		`)
		$`${QN()} build ${dir}/src/main.ts --target=node --outdir=${dir}/dist`
		assert.strictEqual($`${QN()} ${dir}/dist/main.js`, 'bundled-helper')
	})

	test('catch-all does not shadow node_modules', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/real`, { recursive: true })
		mkdirSync(`${dir}/src`)
		writeFileSync(`${dir}/node_modules/real/package.json`, JSON.stringify({
			name: "real", exports: "./index.js"
		}))
		writeFileSync(`${dir}/node_modules/real/index.js`, `export const src = "node_modules";`)
		writeFileSync(`${dir}/src/real.js`, `export const src = "tsconfig";`)
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: {
				baseUrl: "./src",
				paths: { "*": ["./*"] }
			}
		}))
		writeFileSync(`${dir}/main.js`, `
			import { src } from 'real'
			console.log(src)
		`)
		$`${QN()} build ${dir}/main.js --target=node --outdir=${dir}/dist`
		assert.strictEqual($`${QN()} ${dir}/dist/main.js`, 'node_modules')
	})

	test('extends chain inherits paths', ({ dir }) => {
		mkdirSync(`${dir}/lib`)
		writeFileSync(`${dir}/tsconfig.base.json`, JSON.stringify({
			compilerOptions: { paths: { "shared/*": ["./lib/*"] } }
		}))
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			extends: "./tsconfig.base.json"
		}))
		writeFileSync(`${dir}/lib/mod.js`, `export const v = "inherited-bundle";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'shared/mod'
			console.log(v)
		`)
		$`${QN()} build ${dir}/main.js --target=node --outdir=${dir}/dist`
		assert.strictEqual($`${QN()} ${dir}/dist/main.js`, 'inherited-bundle')
	})
})

// --------------------------------------------------------------
// qnc (standalone binary compilation): the shared resolver consults the
// tsconfig paths policy fallback so trees with aliased imports compile.
// --------------------------------------------------------------
describe('qnc tsconfig paths', () => {
	test('paths + baseUrl in qnc-compiled binary', ({ dir }) => {
		mkdirSync(`${dir}/src/lib`, { recursive: true })
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: {
				baseUrl: "./src",
				paths: { "@util/*": ["./lib/*"] }
			}
		}))
		writeFileSync(`${dir}/src/lib/helper.ts`, `export const v: string = "qnc-paths"`)
		writeFileSync(`${dir}/main.ts`, `
			import { v } from '@util/helper'
			console.log(v)
		`)
		$`${QNC()} -o ${dir}/app ${dir}/main.ts`
		assert.strictEqual($`${dir}/app`, 'qnc-paths')
	})

	test('extends chain in qnc-compiled binary', ({ dir }) => {
		mkdirSync(`${dir}/lib`)
		writeFileSync(`${dir}/tsconfig.base.json`, JSON.stringify({
			compilerOptions: { paths: { "shared/*": ["./lib/*"] } }
		}))
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			extends: "./tsconfig.base.json"
		}))
		writeFileSync(`${dir}/lib/m.ts`, `export const v: string = "qnc-extended"`)
		writeFileSync(`${dir}/main.ts`, `
			import { v } from 'shared/m'
			console.log(v)
		`)
		$`${QNC()} -o ${dir}/app ${dir}/main.ts`
		assert.strictEqual($`${dir}/app`, 'qnc-extended')
	})

	test('catch-all does not shadow node_modules in qnc binary', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/real`, { recursive: true })
		mkdirSync(`${dir}/src`)
		writeFileSync(`${dir}/node_modules/real/package.json`, JSON.stringify({
			name: "real", exports: "./index.js"
		}))
		writeFileSync(`${dir}/node_modules/real/index.js`, `export const src = "node_modules"`)
		writeFileSync(`${dir}/src/real.js`, `export const src = "tsconfig"`)
		writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
			compilerOptions: {
				baseUrl: "./src",
				paths: { "*": ["./*"] }
			}
		}))
		writeFileSync(`${dir}/main.js`, `
			import { src } from 'real'
			console.log(src)
		`)
		$`${QNC()} -o ${dir}/app ${dir}/main.js`
		assert.strictEqual($`${dir}/app`, 'node_modules')
	})
})
