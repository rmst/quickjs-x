import { describe, test } from 'node:test'
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { QN, QNC_PATH } from '../util.js'

const makeTempDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'qnc-resolver-parity-')))

const run = (file, args = [], options = {}) => execFileSync(file, args, {
	encoding: 'utf8',
	stdio: ['ignore', 'pipe', 'pipe'],
	timeout: 30000,
	...options,
}).trim()

const qncTestArgs = [
	'--no-default-modules',
	'--cache-dir', join(dirname(QNC_PATH()), 'obj', 'qnc-test'),
]

describe('qn/qnc module-resolution parity', () => {
	test('the interpreter and compiler resolve the same mixed module graph', () => {
		const dir = makeTempDir()
		const project = `${dir}/project`
		const nodePath = `${project}/node-path`
		const env = { ...process.env, NODE_PATH: nodePath }

		try {
			mkdirSync(`${project}/src/dir`, { recursive: true })
			mkdirSync(`${project}/src/real`, { recursive: true })
			mkdirSync(`${project}/aliases`, { recursive: true })
			mkdirSync(`${project}/node_modules/pkg/features`, { recursive: true })
			mkdirSync(`${project}/node_modules/pkg/node_modules/nested`, { recursive: true })
			mkdirSync(`${project}/node_modules/preferred`, { recursive: true })
			mkdirSync(nodePath, { recursive: true })

			writeFileSync(`${project}/tsconfig.json`, JSON.stringify({
				compilerOptions: {
					baseUrl: '.',
					paths: { '@alias/*': ['./aliases/*'] },
				},
			}))
			writeFileSync(`${project}/src/relative.ts`, 'export const relative: string = "relative"')
			writeFileSync(`${project}/src/dir/index.js`, 'export const directory = "directory"')
			writeFileSync(`${project}/src/real/symlinked.js`, 'export const symlinked = "symlink"')
			symlinkSync(`${project}/src/real/symlinked.js`, `${project}/src/symlinked.js`)
			writeFileSync(`${project}/aliases/value.ts`, 'export const alias: string = "alias"')

			writeFileSync(`${project}/node_modules/pkg/package.json`, JSON.stringify({
				name: 'pkg',
				exports: {
					'.': { import: './entry.js', default: './wrong.js' },
					'./features/*': './features/*.js',
				},
			}))
			writeFileSync(`${project}/node_modules/pkg/entry.js`, `
				import { nested } from 'nested'
				export const packageRoot = 'package+' + nested
			`)
			writeFileSync(`${project}/node_modules/pkg/wrong.js`, 'export const packageRoot = "wrong"')
			writeFileSync(`${project}/node_modules/pkg/features/one.js`, 'export const feature = "feature"')
			writeFileSync(`${project}/node_modules/pkg/node_modules/nested/index.ts`,
				'export const nested: string = "nested"')

			writeFileSync(`${project}/node_modules/preferred/index.js`,
				'export const preferred = "node_modules"')
			writeFileSync(`${nodePath}/preferred.js`, 'export const preferred = "node-path"')

			writeFileSync(`${project}/src/main.ts`, `
				import { relative } from './relative'
				import { directory } from './dir'
				import { symlinked } from './symlinked'
				import { alias } from '@alias/value'
				import { packageRoot } from 'pkg'
				import { feature } from 'pkg/features/one'
				import { preferred } from 'preferred'
				console.log(JSON.stringify([
					relative, directory, symlinked, alias,
					packageRoot, feature, preferred,
				]))
			`)

			// Relative entry names below CWD are stored without a leading "./".
			// They must still walk the project's node_modules directories.
			const interpreted = run(QN(), ['src/main.ts'], { cwd: project, env })
			run(QNC_PATH(), [...qncTestArgs, '-o', `${dir}/app`, 'src/main.ts'], {
				cwd: project,
				env,
			})
			rmSync(project, { recursive: true })
			const compiled = run(`${dir}/app`, [], { env })

			assert.strictEqual(compiled, interpreted)
			assert.deepStrictEqual(JSON.parse(compiled), [
				'relative', 'directory', 'symlink', 'alias',
				'package+nested', 'feature', 'node-path',
			])
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('strict Node mode rejects extensionless paths in both', () => {
		const dir = makeTempDir()
		const env = { ...process.env, QN_MODULE_RESOLUTION: 'node' }

		try {
			writeFileSync(`${dir}/dependency.js`, 'export const value = 1')
			writeFileSync(`${dir}/explicit.js`, `
				import { value } from './dependency.js'
				console.log(value)
			`)
			writeFileSync(`${dir}/main.js`, `
				import { value } from './dependency'
				console.log(value)
			`)

			assert.throws(() => run(QN(), [`${dir}/main.js`], { env }))
			// Keep default modules enabled: strict user resolution must not hide
			// qnc's private qn:* support modules.
			run(QNC_PATH(), ['-e', '-o', `${dir}/explicit.c`, `${dir}/explicit.js`], { env })
			assert.throws(() => run(
				QNC_PATH(), ['-e', '-o', `${dir}/app.c`, `${dir}/main.js`], { env }))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})
