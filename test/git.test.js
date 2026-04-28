/**
 * Tests for qn:git, the in-process git client.
 *
 * Strategy: use the system `git` binary to build fixture repos in tmp,
 * then read them back with our module and verify file contents and hashes.
 * The system git is only used to *create* fixtures — the module under
 * test does its own object reading and verification.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, chmodSync, symlinkSync, lstatSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import {
	openLocal, resolve, readObject, readCommit, readTree,
	checkout, fetchTree, peel,
	parseTreeBody, parseCommitBody, parseTagBody,
} from '../node/qn/git.js'
import {
	gitCmd as git, makeRepo, commitAll,
	findGitHttpBackend, startGitHttpServer,
} from './git-fixture.js'

function withTmp(prefix, fn) {
	const d = mkdtempSync(join(tmpdir(), prefix))
	try { return fn(d) } finally { rmSync(d, { recursive: true, force: true }) }
}

/* ---- tests ---- */

describe('qn:git — local repo, loose objects', () => {
	const setup = () => {
		const dir = makeRepo()
		writeFileSync(join(dir, 'a.txt'), 'hello\n')
		writeFileSync(join(dir, 'b.md'), '# title\nbody\n')
		mkdirSync(join(dir, 'sub'))
		writeFileSync(join(dir, 'sub', 'c.txt'), 'nested\n')
		const sha = commitAll(dir, 'init')
		return { dir, sha }
	}

	test('opens a local repo and reads HEAD', () => {
		const { dir, sha } = setup()
		try {
			const repo = openLocal(dir)
			assert.equal(repo.kind, 'local')
			assert.equal(resolve(repo, 'HEAD'), sha)
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})

	test('reads commit and tree', () => {
		const { dir, sha } = setup()
		try {
			const repo = openLocal(dir)
			const c = readCommit(repo, sha)
			assert.match(c.tree, /^[0-9a-f]{40}$/)
			const t = readTree(repo, c.tree)
			const names = t.map((e) => e.name).sort()
			assert.deepEqual(names, ['a.txt', 'b.md', 'sub'])
			const sub = t.find((e) => e.name === 'sub')
			assert.equal(sub.mode, '40000')
			const subEntries = readTree(repo, sub.sha)
			assert.equal(subEntries.length, 1)
			assert.equal(subEntries[0].name, 'c.txt')
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})

	test('checkout writes tree to dest dir', () => {
		const { dir, sha } = setup()
		try {
			const repo = openLocal(dir)
			const c = readCommit(repo, sha)
			withTmp('qn-git-co-', (dest) => {
				const files = checkout(repo, c.tree, dest)
				assert.equal(files, 3)
				assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'hello\n')
				assert.equal(readFileSync(join(dest, 'b.md'), 'utf8'), '# title\nbody\n')
				assert.equal(readFileSync(join(dest, 'sub', 'c.txt'), 'utf8'), 'nested\n')
			})
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})

	test('detects loose object corruption', () => {
		const { dir, sha } = setup()
		try {
			const repo = openLocal(dir)
			const c = readCommit(repo, sha)
			const t = readTree(repo, c.tree)
			const blobSha = t.find((e) => e.name === 'a.txt').sha
			const path = join(dir, '.git', 'objects', blobSha.slice(0, 2), blobSha.slice(2))
			chmodSync(path, 0o644)
			writeFileSync(path, Buffer.from([0x78, 0x9c, 0x00, 0x00, 0x00]))
			// Reopen — packs/refs are cached at openLocal time, but loose reads are live.
			assert.throws(() => readObject(repo, blobSha), /inflate|hash|size|mismatch/i)
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})

	test('rejects unknown ref', () => {
		const { dir } = setup()
		try {
			const repo = openLocal(dir)
			assert.throws(() => resolve(repo, 'no-such-thing'))
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})
})

describe('qn:git — local repo, packed objects', () => {
	const setup = () => {
		const dir = makeRepo()
		writeFileSync(join(dir, 'one.txt'), 'first\n')
		commitAll(dir, 'first')
		writeFileSync(join(dir, 'one.txt'), 'first\nsecond\n')
		writeFileSync(join(dir, 'two.txt'), 'two\n')
		const sha = commitAll(dir, 'second')
		git(dir, 'gc', '--quiet')
		return { dir, sha }
	}

	test('reads packed commit/tree/blob', () => {
		const { dir, sha } = setup()
		try {
			const repo = openLocal(dir)
			assert.ok(repo.packs.length > 0, 'expected at least one pack')
			assert.equal(resolve(repo, 'HEAD'), sha)
			const c = readCommit(repo, sha)
			const t = readTree(repo, c.tree)
			assert.equal(t.length, 2)
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})

	test('checkout from packed objects matches working tree', () => {
		const { dir, sha } = setup()
		try {
			const repo = openLocal(dir)
			const c = readCommit(repo, sha)
			withTmp('qn-git-co-', (dest) => {
				checkout(repo, c.tree, dest)
				assert.equal(readFileSync(join(dest, 'one.txt'), 'utf8'), 'first\nsecond\n')
				assert.equal(readFileSync(join(dest, 'two.txt'), 'utf8'), 'two\n')
			})
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})

	test('every object in the pack hashes correctly', () => {
		const { dir } = setup()
		try {
			const repo = openLocal(dir)
			for (const p of repo.packs) {
				for (const { sha } of p.idx.entries()) {
					const obj = readObject(repo, sha)
					assert.ok(obj.type)
					assert.ok(obj.content)
				}
			}
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})
})

describe('qn:git — pack deltas across many commits', () => {
	test('resolves deltas correctly', () => {
		const dir = makeRepo()
		try {
			const baseLines = []
			for (let i = 0; i < 200; i++) baseLines.push(`line ${i}`)
			let sha
			for (let v = 1; v <= 6; v++) {
				// Each version mutates a different subset of lines so deltas are non-trivial
				// and every commit changes the blob.
				const out = baseLines.map((l, i) => (i % v === 0 ? `${l} (v${v})` : l))
				writeFileSync(join(dir, 'big.txt'), out.join('\n') + '\n')
				sha = commitAll(dir, `v${v}`)
			}
			git(dir, 'gc', '--quiet')

			const repo = openLocal(dir)
			const c = readCommit(repo, sha)
			const t = readTree(repo, c.tree)
			const blob = readObject(repo, t[0].sha)
			const lines = blob.content.toString('utf8').split('\n').filter(Boolean)
			assert.equal(lines.length, 200)
			// Line 0 should carry the v6 marker (every v divides 0)
			assert.match(lines[0], /\(v6\)/)
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})
})

describe('qn:git — checkout preserves modes', () => {
	test('symlinks are recreated as symlinks', () => {
		const dir = makeRepo()
		try {
			writeFileSync(join(dir, 'target.txt'), 'pointed-at\n')
			symlinkSync('target.txt', join(dir, 'link'))
			const sha = commitAll(dir, 'with-link')
			const repo = openLocal(dir)
			const c = readCommit(repo, sha)
			const dest = mkdtempSync(join(tmpdir(), 'qn-git-sym-'))
			try {
				checkout(repo, c.tree, dest)
				const st = lstatSync(join(dest, 'link'))
				assert.ok(st.isSymbolicLink(), 'expected a symlink')
				assert.equal(readlinkSync(join(dest, 'link')), 'target.txt')
			} finally { rmSync(dest, { recursive: true, force: true }) }
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})

	test('executable bit (100755) is restored on checkout', () => {
		const dir = makeRepo()
		try {
			const scriptPath = join(dir, 'run.sh')
			writeFileSync(scriptPath, '#!/bin/sh\necho hi\n')
			chmodSync(scriptPath, 0o755)
			writeFileSync(join(dir, 'plain.txt'), 'no-x\n')
			const sha = commitAll(dir, 'with-exec')
			const repo = openLocal(dir)
			const c = readCommit(repo, sha)
			const t = readTree(repo, c.tree)
			const runEntry = t.find((e) => e.name === 'run.sh')
			assert.equal(runEntry.mode, '100755')
			const plainEntry = t.find((e) => e.name === 'plain.txt')
			assert.equal(plainEntry.mode, '100644')

			const dest = mkdtempSync(join(tmpdir(), 'qn-git-exec-'))
			try {
				checkout(repo, c.tree, dest)
				const sx = statSync(join(dest, 'run.sh'))
				const sp = statSync(join(dest, 'plain.txt'))
				assert.ok((sx.mode & 0o100) !== 0, 'run.sh should be user-executable')
				assert.ok((sp.mode & 0o100) === 0, 'plain.txt should NOT be executable')
			} finally { rmSync(dest, { recursive: true, force: true }) }
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})
})

describe('qn:git — fetchTree convenience', () => {
	test('checks out via fetchTree from a local path', async () => {
		const dir = makeRepo()
		try {
			writeFileSync(join(dir, 'README.md'), 'hi\n')
			const sha = commitAll(dir, 'init')
			const dest = mkdtempSync(join(tmpdir(), 'qn-git-ft-'))
			try {
				const r = await fetchTree({ source: dir, ref: 'HEAD', dest })
				assert.equal(r.commit, sha)
				assert.equal(r.files, 1)
				assert.equal(readFileSync(join(dest, 'README.md'), 'utf8'), 'hi\n')
			} finally { rmSync(dest, { recursive: true, force: true }) }
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})

	test('fetchTree accepts a sha as ref', async () => {
		const dir = makeRepo()
		try {
			writeFileSync(join(dir, 'README.md'), 'hi\n')
			const sha = commitAll(dir, 'init')
			const dest = mkdtempSync(join(tmpdir(), 'qn-git-ft-'))
			try {
				const r = await fetchTree({ source: dir, ref: sha, dest })
				assert.equal(r.commit, sha)
			} finally { rmSync(dest, { recursive: true, force: true }) }
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})
})

describe('qn:git — annotated tags', () => {
	test('readCommit and fetchTree peel an annotated tag (passed by sha)', async () => {
		const dir = makeRepo()
		try {
			writeFileSync(join(dir, 'a.txt'), 'tagged\n')
			const commitSha = commitAll(dir, 'init')
			git(dir, 'tag', '-a', 'v1', '-m', 'release one')
			const tagSha = git(dir, 'rev-parse', 'v1').trim()
			assert.notEqual(tagSha, commitSha, 'annotated tag should be its own object')

			const repo = openLocal(dir)
			// resolve returns the literal pointee (tag object, not commit).
			assert.equal(resolve(repo, 'v1'), tagSha)
			// readCommit transparently peels the tag.
			const c = readCommit(repo, tagSha)
			assert.match(c.tree, /^[0-9a-f]{40}$/)
			// peel returns commit sha + raw content.
			const p = peel(repo, tagSha)
			assert.equal(p.type, 'commit')
			assert.equal(p.sha, commitSha)

			// fetchTree by tag-object sha should return the peeled commit sha.
			const dest = mkdtempSync(join(tmpdir(), 'qn-git-tag-'))
			try {
				const r = await fetchTree({ source: dir, ref: tagSha, dest })
				assert.equal(r.commit, commitSha)
				assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'tagged\n')
			} finally { rmSync(dest, { recursive: true, force: true }) }
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})

	test('peel walks a tag-of-tag chain', () => {
		const dir = makeRepo()
		try {
			writeFileSync(join(dir, 'a.txt'), 'chained\n')
			const commitSha = commitAll(dir, 'init')
			git(dir, 'tag', '-a', 'v1', '-m', 'one')
			const tag1 = git(dir, 'rev-parse', 'v1').trim()
			// Build a tag-of-tag via plumbing: mktag writes a tag object, update-ref names it.
			const body = `object ${tag1}\ntype tag\ntag v2\ntagger A <a@b> 0 +0000\n\nv2 wraps v1\n`
			const tag2 = execFileSync('git', ['-C', dir, 'mktag'], { input: body }).toString().trim()
			git(dir, 'update-ref', 'refs/tags/v2', tag2)

			const repo = openLocal(dir)
			const p = peel(repo, tag2)
			assert.equal(p.sha, commitSha, 'should follow tag→tag→commit')
			assert.equal(p.type, 'commit')
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})
})

const GIT_HTTP_BACKEND = findGitHttpBackend()
const remoteDescribe = GIT_HTTP_BACKEND ? describe : (describe.skip ?? (() => {}))

remoteDescribe('qn:git — remote via local git-http-backend', () => {
	test('fetchTree by annotated-tag sha peels to commit over HTTP', async () => {
		const repoDir = makeRepo()
		try {
			writeFileSync(join(repoDir, 'a.txt'), 'tagged-remote\n')
			const commitSha = commitAll(repoDir, 'init')
			git(repoDir, 'tag', '-a', 'v1', '-m', 'release')
			const tagSha = git(repoDir, 'rev-parse', 'v1').trim()
			git(repoDir, 'gc', '--quiet')
			git(repoDir, 'update-server-info')

			const { server, url } = await startGitHttpServer(repoDir + '/..', GIT_HTTP_BACKEND)
			try {
				const repoBase = url + '/' + repoDir.split('/').pop() + '/.git'
				const dest = mkdtempSync(join(tmpdir(), 'qn-git-rtag-'))
				try {
					const r = await fetchTree({ source: repoBase, ref: tagSha, dest })
					assert.equal(r.commit, commitSha, 'fetchTree should peel to commit sha')
					assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'tagged-remote\n')
				} finally { rmSync(dest, { recursive: true, force: true }) }
			} finally { server.close() }
		} finally { rmSync(repoDir, { recursive: true, force: true }) }
	})

	test('fetchTree against a local HTTP git server', async () => {
		const repoDir = makeRepo()
		try {
			writeFileSync(join(repoDir, 'a.txt'), 'remote-hello\n')
			mkdirSync(join(repoDir, 'sub'))
			writeFileSync(join(repoDir, 'sub', 'b.txt'), 'nested\n')
			const sha = commitAll(repoDir, 'init')
			// Pack everything so the response uses a real packfile (loose objects
			// would still work but we want to exercise the pack path).
			git(repoDir, 'gc', '--quiet')
			// Update server-info so dumb HTTP also has refs (smart HTTP doesn't
			// strictly need it, but it's a no-op cost).
			git(repoDir, 'update-server-info')

			const { server, url } = await startGitHttpServer(repoDir + '/..', GIT_HTTP_BACKEND)
			try {
				const repoBase = url + '/' + repoDir.split('/').pop() + '/.git'
				const dest = mkdtempSync(join(tmpdir(), 'qn-git-rt-'))
				try {
					const r = await fetchTree({ source: repoBase, ref: 'main', dest })
					assert.equal(r.commit, sha)
					assert.equal(r.files, 2)
					assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'remote-hello\n')
					assert.equal(readFileSync(join(dest, 'sub', 'b.txt'), 'utf8'), 'nested\n')
				} finally {
					rmSync(dest, { recursive: true, force: true })
				}
			} finally {
				server.close()
			}
		} finally {
			rmSync(repoDir, { recursive: true, force: true })
		}
	})
})

describe('qn:git — parsers', () => {
	test('parseTreeBody handles multiple entries', () => {
		const sha = Buffer.alloc(20, 0xab)
		const part = (mode, name) => Buffer.concat([
			Buffer.from(`${mode} ${name}\0`), sha,
		])
		const buf = Buffer.concat([part('100644', 'a'), part('40000', 'sub')])
		const entries = parseTreeBody(buf)
		assert.equal(entries.length, 2)
		assert.equal(entries[0].name, 'a')
		assert.equal(entries[0].mode, '100644')
		assert.equal(entries[1].name, 'sub')
		assert.equal(entries[1].mode, '40000')
	})

	test('parseCommitBody extracts tree and parents', () => {
		const buf = Buffer.from([
			'tree 1234567890123456789012345678901234567890',
			'parent abcdefabcdefabcdefabcdefabcdefabcdefabcd',
			'author A <a@x> 0 +0000',
			'committer C <c@x> 0 +0000',
			'',
			'msg',
		].join('\n'))
		const c = parseCommitBody(buf)
		assert.equal(c.tree, '1234567890123456789012345678901234567890')
		assert.deepEqual(c.parents, ['abcdefabcdefabcdefabcdefabcdefabcdefabcd'])
		assert.equal(c.message, 'msg')
	})
})
