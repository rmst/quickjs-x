/**
 * Verify every functional node:* shim exposes a default export carrying the
 * named exports (matches Node's CJS-default-interop behaviour). Without this,
 * the very common `import fs from 'node:fs'` pattern silently fails.
 */
import { test } from 'node:test'
import assert from 'node:assert'

const cases = [
	['node:abort', 'AbortSignal', 'object'],
	['node:assert', null, 'function'],
	['node:buffer', 'Buffer', 'object'],
	['node:child_process', 'spawn', 'object'],
	['node:crypto', 'createHash', 'object'],
	['node:dgram', 'createSocket', 'object'],
	['node:events', null, 'function'],
	['node:fetch', 'fetch', 'object'],
	['node:fs', 'readFileSync', 'object'],
	['node:http', 'createServer', 'object'],
	['node:module', 'createRequire', 'object'],
	['node:net', 'createServer', 'object'],
	['node:os', 'platform', 'object'],
	['node:path', 'join', 'object'],
	['node:process', 'cwd', 'object'],
	['node:sqlite', 'DatabaseSync', 'object'],
	['node:stream', 'Readable', 'object'],
	['node:test', 'test', 'object'],
	['node:timers', 'setTimeout', 'object'],
	['node:url', 'URL', 'object'],
	['node:util', 'promisify', 'object'],
	['node:zlib', 'gzipSync', 'object'],
]

for (const [name, key, kind] of cases) {
	test(`${name} exposes a usable default export`, async () => {
		const m = await import(name)
		assert.strictEqual(typeof m.default, kind, `${name} default should be ${kind}`)
		if (key) {
			const ns = await import(name)
			assert.strictEqual(m.default[key], ns[key],
				`${name}.default.${key} should match named export`)
		}
	})
}
