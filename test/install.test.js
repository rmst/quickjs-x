import { describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mktempdir } from './util.js'
import { install } from '../node/qn/install.js'
import {
	makeRepo, commitAll, findGitHttpBackend, startGitHttpServer,
} from './git-fixture.js'

describe('qn install', () => {
	test('installs file: dependency', async () => {
		let dir = mktempdir()
		try {
			// Create a fake package to install
			let pkgDir = join(dir, "my-lib")
			mkdirSync(pkgDir)
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "my-lib" }))
			writeFileSync(join(pkgDir, "index.js"), "export const x = 42\n")

			// Create the project that depends on it
			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "my-lib": `file:${pkgDir}` }
			}))

			await install(projectDir)

			// Check it was installed
			assert.ok(existsSync(join(projectDir, "node_modules", "my-lib", "index.js")))
			assert.ok(existsSync(join(projectDir, "node_modules", "my-lib", "package.json")))
			let content = readFileSync(join(projectDir, "node_modules", "my-lib", "index.js"), "utf8")
			assert.strictEqual(content, "export const x = 42\n")
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('installs scoped file: dependency', async () => {
		let dir = mktempdir()
		try {
			let pkgDir = join(dir, "core")
			mkdirSync(pkgDir)
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@myorg/core" }))
			writeFileSync(join(pkgDir, "index.js"), "export default 1\n")

			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "@myorg/core": `file:${pkgDir}` }
			}))

			await install(projectDir)

			assert.ok(existsSync(join(projectDir, "node_modules", "@myorg", "core", "index.js")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('skips devDependencies by default', async () => {
		let dir = mktempdir()
		try {
			let libA = join(dir, "lib-a")
			mkdirSync(libA)
			writeFileSync(join(libA, "package.json"), JSON.stringify({ name: "lib-a" }))
			writeFileSync(join(libA, "index.js"), "")

			let libB = join(dir, "lib-b")
			mkdirSync(libB)
			writeFileSync(join(libB, "package.json"), JSON.stringify({ name: "lib-b" }))
			writeFileSync(join(libB, "index.js"), "")

			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "lib-a": `file:${libA}` },
				devDependencies: { "lib-b": `file:${libB}` }
			}))

			await install(projectDir)

			assert.ok(existsSync(join(projectDir, "node_modules", "lib-a")))
			assert.ok(!existsSync(join(projectDir, "node_modules", "lib-b")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('includes devDependencies with dev option', async () => {
		let dir = mktempdir()
		try {
			let libA = join(dir, "lib-a")
			mkdirSync(libA)
			writeFileSync(join(libA, "package.json"), JSON.stringify({ name: "lib-a" }))
			writeFileSync(join(libA, "index.js"), "")

			let libB = join(dir, "lib-b")
			mkdirSync(libB)
			writeFileSync(join(libB, "package.json"), JSON.stringify({ name: "lib-b" }))
			writeFileSync(join(libB, "index.js"), "")

			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "lib-a": `file:${libA}` },
				devDependencies: { "lib-b": `file:${libB}` }
			}))

			await install(projectDir, { dev: true })

			assert.ok(existsSync(join(projectDir, "node_modules", "lib-a")))
			assert.ok(existsSync(join(projectDir, "node_modules", "lib-b")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('replaces existing package on reinstall', async () => {
		let dir = mktempdir()
		try {
			let pkgDir = join(dir, "my-lib")
			mkdirSync(pkgDir)
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "my-lib" }))
			writeFileSync(join(pkgDir, "index.js"), "export const v = 1\n")

			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "my-lib": `file:${pkgDir}` }
			}))

			await install(projectDir)
			assert.strictEqual(readFileSync(join(projectDir, "node_modules", "my-lib", "index.js"), "utf8"), "export const v = 1\n")

			// Update source
			writeFileSync(join(pkgDir, "index.js"), "export const v = 2\n")
			await install(projectDir)
			assert.strictEqual(readFileSync(join(projectDir, "node_modules", "my-lib", "index.js"), "utf8"), "export const v = 2\n")
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('reports npm specifiers as unsupported', async () => {
		let dir = mktempdir()
		try {
			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "lodash": "^4.0.0" }
			}))

			// Should not throw, just skip
			await install(projectDir)

			assert.ok(!existsSync(join(projectDir, "node_modules", "lodash")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('strips .git directory from file: installs', async () => {
		let dir = mktempdir()
		try {
			let pkgDir = join(dir, "my-lib")
			mkdirSync(pkgDir)
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "my-lib" }))
			mkdirSync(join(pkgDir, ".git"))
			writeFileSync(join(pkgDir, ".git", "HEAD"), "ref: refs/heads/main\n")

			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "my-lib": `file:${pkgDir}` }
			}))

			await install(projectDir)

			assert.ok(existsSync(join(projectDir, "node_modules", "my-lib", "package.json")))
			assert.ok(!existsSync(join(projectDir, "node_modules", "my-lib", ".git")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('does not run prepare for file: dependencies', async () => {
		let dir = mktempdir()
		try {
			let pkgDir = join(dir, "my-lib")
			mkdirSync(pkgDir)
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
				name: "my-lib",
				scripts: { prepare: "echo SHOULD_NOT_RUN > prepared.txt" }
			}))

			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "my-lib": `file:${pkgDir}` }
			}))

			await install(projectDir)

			assert.ok(!existsSync(join(projectDir, "node_modules", "my-lib", "prepared.txt")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	const gitHttpBackend = findGitHttpBackend()
	const remoteTest = gitHttpBackend ? test : (test.skip ?? (() => {}))

	remoteTest('installs git+https dependency via local HTTP server', async () => {
		// Set up a git repo serving an installable package.
		const repo = makeRepo()
		writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'remote-pkg', version: '0.0.1' }))
		writeFileSync(join(repo, 'index.js'), 'export const v = "remote"\n')
		const sha = commitAll(repo, 'init')

		const { server, url } = await startGitHttpServer(repo + '/..', gitHttpBackend)
		try {
			const repoBase = url + '/' + repo.split('/').pop() + '/.git'
			const dir = mktempdir()
			try {
				const projectDir = join(dir, 'project')
				mkdirSync(projectDir)
				writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
					name: 'test-project',
					dependencies: { 'remote-pkg': `git+${repoBase}#${sha}` },
				}))
				await install(projectDir)

				assert.ok(existsSync(join(projectDir, 'node_modules', 'remote-pkg', 'index.js')))
				assert.equal(
					readFileSync(join(projectDir, 'node_modules', 'remote-pkg', 'index.js'), 'utf8'),
					'export const v = "remote"\n',
				)
			} finally {
				rmSync(dir, { recursive: true })
			}
		} finally {
			server.close()
			rmSync(repo, { recursive: true, force: true })
		}
	})

	remoteTest('installs github: shorthand via local HTTP server', async () => {
		// Spec is `github:owner/repo[#ref]`, which install.js resolves to
		// https://github.com/owner/repo. We override the URL by serving from
		// our local server and using a `git+http://...` dependency that mirrors
		// the same path-shape.
		const repo = makeRepo()
		writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'gh-pkg' }))
		writeFileSync(join(repo, 'README.md'), 'hello\n')
		commitAll(repo, 'init')

		const { server, url } = await startGitHttpServer(repo + '/..', gitHttpBackend)
		try {
			const repoBase = url + '/' + repo.split('/').pop() + '/.git'
			const dir = mktempdir()
			try {
				const projectDir = join(dir, 'project')
				mkdirSync(projectDir)
				writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
					name: 'test-project',
					dependencies: { 'gh-pkg': `git+${repoBase}` },
				}))
				await install(projectDir)
				assert.equal(
					readFileSync(join(projectDir, 'node_modules', 'gh-pkg', 'README.md'), 'utf8'),
					'hello\n',
				)
				// Materialized via qn:git (no .git directory artifact).
				assert.ok(!existsSync(join(projectDir, 'node_modules', 'gh-pkg', '.git')))
			} finally {
				rmSync(dir, { recursive: true })
			}
		} finally {
			server.close()
			rmSync(repo, { recursive: true, force: true })
		}
	})

	test('handles empty dependencies', async () => {
		let dir = mktempdir()
		try {
			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project"
			}))

			// Should not throw
			await install(projectDir)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qn install — sourceDependencies', () => {
	/**
	 * Build an upstream package fixture (committed to a local git repo).
	 * Returns { repoDir, sha }.
	 */
	function makeUpstream(pkgJson, files = {}) {
		let repoDir = makeRepo()
		writeFileSync(join(repoDir, 'package.json'), JSON.stringify(pkgJson))
		for (let [path, content] of Object.entries(files)) {
			let full = join(repoDir, path)
			mkdirSync(join(full, '..'), { recursive: true })
			writeFileSync(full, content)
		}
		let sha = commitAll(repoDir, 'init')
		return { repoDir, sha }
	}

	test('explicit exports override is written verbatim', async () => {
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			exports: { ".": "./dist/lib.mjs" },  // upstream's published exports
		}, {
			'src/index.js': 'export default 42\n',
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: {
					lib: { git: repoDir, rev: sha, exports: { ".": "./src/index.js" } },
				},
			}))

			await install(projectDir)

			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/lib/package.json'), 'utf8'))
			assert.deepStrictEqual(installed.exports, { ".": "./src/index.js" })
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('default tree-mirror rewrites /dist/X.{js,mjs} to /src/X.ts', async () => {
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			exports: {
				".": "./dist/index.mjs",
				"./util": "./dist/util.js",
			},
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: {
					lib: { git: repoDir, rev: sha },  // no override
				},
			}))

			await install(projectDir)

			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/lib/package.json'), 'utf8'))
			assert.deepStrictEqual(installed.exports, {
				".": "./src/index.ts",
				"./util": "./src/util.ts",
			})
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('default tree-mirror rewrites imports the same way as exports', async () => {
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			imports: {
				"#util": "./dist/util.mjs",
				"#helpers": "./dist/helpers.js",
			},
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { git: repoDir, rev: sha } },
			}))

			await install(projectDir)

			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/lib/package.json'), 'utf8'))
			assert.deepStrictEqual(installed.imports, {
				"#util": "./src/util.ts",
				"#helpers": "./src/helpers.ts",
			})
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('explicit imports override is written verbatim', async () => {
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			imports: { "#x": "./dist/x.mjs" },
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: {
					lib: { git: repoDir, rev: sha, imports: { "#x": "./src/x.js" } },
				},
			}))

			await install(projectDir)

			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/lib/package.json'), 'utf8'))
			assert.deepStrictEqual(installed.imports, { "#x": "./src/x.js" })
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('default tree-mirror collapses bun condition to its source path', async () => {
		// Mirrors the markdown-to-jsx convention: a `bun` condition holds the
		// source-equivalent path, while other conditions point at dist artifacts.
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			imports: {
				"#entities": {
					bun: "./src/entities.generated.ts",
					browser: {
						import: { default: "./dist/entities.browser.js" },
					},
					default: { default: "./dist/entities.generated.js" },
				},
			},
			exports: {
				".": {
					bun: "./src/index.ts",
					default: "./dist/index.js",
				},
			},
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { git: repoDir, rev: sha } },
			}))

			await install(projectDir)

			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/lib/package.json'), 'utf8'))
			assert.deepStrictEqual(installed.imports, {
				"#entities": "./src/entities.generated.ts",
			})
			assert.deepStrictEqual(installed.exports, {
				".": "./src/index.ts",
			})
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('default tree-mirror prefers qn condition over bun', async () => {
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			exports: {
				".": {
					qn: "./src/qn-entry.ts",
					bun: "./src/bun-entry.ts",
					default: "./dist/index.js",
				},
			},
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { git: repoDir, rev: sha } },
			}))

			await install(projectDir)

			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/lib/package.json'), 'utf8'))
			assert.deepStrictEqual(installed.exports, { ".": "./src/qn-entry.ts" })
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('exports without /dist/ paths are left untouched', async () => {
		let original = { ".": "./src/index.js" }
		let { repoDir, sha } = makeUpstream({ name: 'lib', exports: original })
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: {
					lib: { git: repoDir, rev: sha },
				},
			}))

			await install(projectDir)

			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/lib/package.json'), 'utf8'))
			assert.deepStrictEqual(installed.exports, original)
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('build escape hatch runs in cloned dir', async () => {
		let { repoDir, sha } = makeUpstream({ name: 'lib' })
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: {
					lib: { git: repoDir, rev: sha, build: 'echo built > BUILT.txt' },
				},
			}))

			await install(projectDir)

			let marker = join(projectDir, 'node_modules/lib/BUILT.txt')
			assert.ok(existsSync(marker), 'build script should have run in cloned dir')
			assert.strictEqual(readFileSync(marker, 'utf8'), 'built\n')
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('does not run upstream prepare scripts', async () => {
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			scripts: { prepare: 'echo SHOULD_NOT_RUN > prepared.txt' },
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { git: repoDir, rev: sha } },
			}))

			await install(projectDir)

			assert.ok(!existsSync(join(projectDir, 'node_modules/lib/prepared.txt')))
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	async function expectRejection(fn, pattern) {
		let err
		try { await fn() } catch (e) { err = e }
		assert.ok(err, 'expected rejection')
		if (pattern) assert.match(err.message, pattern)
	}

	test('rejects missing git field', async () => {
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { rev: '0'.repeat(40) } },
			}))
			await expectRejection(() => install(projectDir), /'git' field is required/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('rejects missing rev field', async () => {
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { git: 'https://example.com/foo' } },
			}))
			await expectRejection(() => install(projectDir), /'rev' field is required/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('rejects nonexistent rev (qn:git verification)', async () => {
		let { repoDir, sha } = makeUpstream({ name: 'lib' })
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			let badRev = '0'.repeat(40)
			assert.notStrictEqual(badRev, sha)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { git: repoDir, rev: badRev } },
			}))
			await expectRejection(() => install(projectDir))
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('installs scoped sourceDependency', async () => {
		let { repoDir, sha } = makeUpstream({ name: '@org/lib' })
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { '@org/lib': { git: repoDir, rev: sha } },
			}))
			await install(projectDir)
			assert.ok(existsSync(join(projectDir, 'node_modules/@org/lib/package.json')))
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('path source: copies local dir contents (relative path)', async () => {
		let dir = mktempdir()
		try {
			let siblingDir = join(dir, 'sibling')
			mkdirSync(siblingDir)
			writeFileSync(join(siblingDir, 'package.json'), JSON.stringify({ name: 'sibling-pkg' }))
			writeFileSync(join(siblingDir, 'index.js'), 'export const v = 7\n')

			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: {
					'sibling-pkg': { path: '../sibling' },
				},
			}))

			await install(projectDir)

			let installed = readFileSync(join(projectDir, 'node_modules/sibling-pkg/index.js'), 'utf8')
			assert.strictEqual(installed, 'export const v = 7\n')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('path source: picks up uncommitted edits (no git involved)', async () => {
		let dir = mktempdir()
		try {
			let siblingDir = join(dir, 'sibling')
			mkdirSync(siblingDir)
			writeFileSync(join(siblingDir, 'package.json'), JSON.stringify({ name: 'live' }))
			writeFileSync(join(siblingDir, 'a.js'), 'old\n')

			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { live: { path: '../sibling' } },
			}))

			await install(projectDir)
			assert.strictEqual(readFileSync(join(projectDir, 'node_modules/live/a.js'), 'utf8'), 'old\n')

			writeFileSync(join(siblingDir, 'a.js'), 'new\n')
			await install(projectDir)
			assert.strictEqual(readFileSync(join(projectDir, 'node_modules/live/a.js'), 'utf8'), 'new\n')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('path source: applies exports override', async () => {
		let dir = mktempdir()
		try {
			let siblingDir = join(dir, 'sibling')
			mkdirSync(siblingDir)
			writeFileSync(join(siblingDir, 'package.json'), JSON.stringify({
				name: 'sib',
				exports: { '.': './dist/index.mjs' },
			}))

			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: {
					sib: { path: '../sibling', exports: { '.': './src/index.ts' } },
				},
			}))

			await install(projectDir)

			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/sib/package.json'), 'utf8'))
			assert.deepStrictEqual(installed.exports, { '.': './src/index.ts' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('path source: rejects combining path with git/rev', async () => {
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir, { recursive: true })
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: {
					bad: { path: '/whatever', git: 'https://x', rev: '0'.repeat(40) },
				},
			}))
			await expectRejection(() => install(projectDir), /cannot combine 'path' with/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('path source: rejects nonexistent path', async () => {
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir, { recursive: true })
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { miss: { path: './does-not-exist' } },
			}))
			await expectRejection(() => install(projectDir), /path not found/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('rejects entry with neither git+rev nor path', async () => {
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir, { recursive: true })
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { exports: {} } },
			}))
			await expectRejection(() => install(projectDir), /requires either 'git'\+'rev' or 'path'/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	const gitHttpBackend = findGitHttpBackend()
	const remoteTest = gitHttpBackend ? test : (test.skip ?? (() => {}))

	remoteTest('fetches sourceDependency over local HTTP server', async () => {
		let { repoDir, sha } = makeUpstream({
			name: 'remote-lib',
			exports: { ".": "./dist/index.mjs" },
		})
		let { server, url } = await startGitHttpServer(repoDir + '/..', gitHttpBackend)
		try {
			let repoBase = url + '/' + repoDir.split('/').pop() + '/.git'
			let dir = mktempdir()
			try {
				let projectDir = join(dir, 'project')
				mkdirSync(projectDir)
				writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
					name: 'project',
					sourceDependencies: { 'remote-lib': { git: repoBase, rev: sha } },
				}))
				await install(projectDir)

				let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/remote-lib/package.json'), 'utf8'))
				assert.deepStrictEqual(installed.exports, { ".": "./src/index.ts" })
			} finally {
				rmSync(dir, { recursive: true })
			}
		} finally {
			server.close()
			rmSync(repoDir, { recursive: true, force: true })
		}
	})
})

describe('qn install --compile-deps', () => {
	function makeUpstream(pkgJson, files = {}) {
		let repoDir = makeRepo()
		writeFileSync(join(repoDir, 'package.json'), JSON.stringify(pkgJson))
		for (let [path, content] of Object.entries(files)) {
			let full = join(repoDir, path)
			mkdirSync(join(full, '..'), { recursive: true })
			writeFileSync(full, content)
		}
		let sha = commitAll(repoDir, 'init')
		return { repoDir, sha }
	}

	test('bundles a TS sourceDep to ./dist/*.js and rewrites exports', async () => {
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			exports: { ".": "./dist/index.mjs" },
		}, {
			'src/index.ts': 'export const greet = (name: string): string => `hi ${name}`\n',
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { git: repoDir, rev: sha } },
			}))

			await install(projectDir, { compileDeps: true })

			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/lib/package.json'), 'utf8'))
			assert.deepStrictEqual(installed.exports, { ".": "./dist/index.js" })
			assert.ok(existsSync(join(projectDir, 'node_modules/lib/dist/index.js')))
			let bundled = readFileSync(join(projectDir, 'node_modules/lib/dist/index.js'), 'utf8')
			// TS annotation must be stripped, runtime code preserved.
			assert.ok(!/: string/.test(bundled), 'TS annotation should be stripped')
			assert.ok(/hi \$\{name\}/.test(bundled), 'runtime code should be preserved')
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('compiles imports the same way as exports', async () => {
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			imports: { "#util": "./dist/util.mjs" },
		}, {
			'src/util.ts': 'export const id = <T>(x: T): T => x\n',
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { git: repoDir, rev: sha } },
			}))

			await install(projectDir, { compileDeps: true })

			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/lib/package.json'), 'utf8'))
			assert.deepStrictEqual(installed.imports, { "#util": "./dist/util.js" })
			assert.ok(existsSync(join(projectDir, 'node_modules/lib/dist/util.js')))
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('walks conditional exports objects', async () => {
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			exports: {
				".": {
					import: "./dist/index.mjs",
					require: "./dist/index.cjs",
				},
			},
		}, {
			'src/index.ts': 'export default 1\n',
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { git: repoDir, rev: sha } },
			}))

			await install(projectDir, { compileDeps: true })

			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/lib/package.json'), 'utf8'))
			// Only ./dist/X.{js,mjs} leaves with a matching source get rewritten;
			// require → ./dist/index.cjs has no source-conventional match (no .cjs
			// rewrite), so installSourceDeps already left it as ./dist/index.cjs and
			// compile-deps leaves it alone too. The .mjs leaf bundles successfully.
			assert.strictEqual(installed.exports['.'].import, './dist/index.js')
			assert.ok(existsSync(join(projectDir, 'node_modules/lib/dist/index.js')))
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('explicit ./src/ override is bundled directly', async () => {
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			exports: { ".": "./dist/index.mjs" },
		}, {
			'src/index.ts': 'export const v = 7\n',
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: {
					lib: { git: repoDir, rev: sha, exports: { ".": "./src/index.ts" } },
				},
			}))

			await install(projectDir, { compileDeps: true })

			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/lib/package.json'), 'utf8'))
			assert.deepStrictEqual(installed.exports, { ".": "./dist/index.js" })
			assert.ok(existsSync(join(projectDir, 'node_modules/lib/dist/index.js')))
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('passes through leaves with no resolvable source', async () => {
		// upstream ships a real, prebuilt ./dist/index.mjs (no /src/ at all).
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			exports: { ".": "./dist/index.mjs" },
		}, {
			'dist/index.mjs': 'export const v = 1\n',
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { git: repoDir, rev: sha } },
			}))

			await install(projectDir, { compileDeps: true })

			// installSourceDeps tree-mirror rewrote the leaf to ./src/index.ts, but
			// no such source exists, so compile-deps leaves the (broken-looking)
			// leaf untouched. This matches jix's compile-deps behavior — the user
			// gets a clear runtime error if they actually import the broken entry.
			let installed = JSON.parse(readFileSync(join(projectDir, 'node_modules/lib/package.json'), 'utf8'))
			assert.deepStrictEqual(installed.exports, { ".": "./src/index.ts" })
			assert.ok(!existsSync(join(projectDir, 'node_modules/lib/dist/index.js')))
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})

	test('no-op when there are no sourceDependencies', async () => {
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
			}))
			// Should not throw.
			await install(projectDir, { compileDeps: true })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('node can import the compiled sourceDep via its package name', { skip: process.env.NO_NODEJS_TESTS ? 'NO_NODEJS_TESTS set' : false }, async () => {
		let { repoDir, sha } = makeUpstream({
			name: 'lib',
			exports: { ".": "./dist/index.mjs" },
		}, {
			'src/index.ts': 'export const greet = (name: string): string => `hi ${name}`\n',
		})
		let dir = mktempdir()
		try {
			let projectDir = join(dir, 'project')
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
				name: 'project',
				sourceDependencies: { lib: { git: repoDir, rev: sha } },
			}))
			await install(projectDir, { compileDeps: true })

			// Spawn `node` to import the bundled output.
			let { execFileSync } = await import('node:child_process')
			let out = execFileSync('node', [
				'--input-type=module',
				'-e', 'import { greet } from "lib"; console.log(greet("world"))',
			], { cwd: projectDir, encoding: 'utf8' })
			assert.strictEqual(out.trim(), 'hi world')
		} finally {
			rmSync(dir, { recursive: true })
			rmSync(repoDir, { recursive: true, force: true })
		}
	})
})
