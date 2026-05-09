import { describe, test } from "node:test"
import assert from "node:assert"
import { execSync } from "node:child_process"
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const qn = process.argv[0]

const STUB_MODULES = [
	"node:async_hooks",
	"node:cluster",
	"node:diagnostics_channel",
	"node:dns",
	"node:domain",
	"node:http2",
	"node:https",
	"node:inspector",
	"node:punycode",
	"node:querystring",
	"node:repl",
	"node:string_decoder",
	"node:v8",
	"node:vm",
	"node:wasi",
	"node:worker_threads",
]

const tmpDir = mkdtempSync(join(tmpdir(), "qn-stub-test-"))

describe("unimplemented module stubs", () => {
	for (const mod of STUB_MODULES) {
		test(`${mod} throws NodeCompatibilityError`, () => {
			const file = join(tmpDir, mod.replace(":", "_") + ".mjs")
			writeFileSync(file, `import "${mod}"\n`)
			try {
				execSync(`${qn} ${file}`, {
					encoding: "utf8",
					stdio: ["pipe", "pipe", "pipe"],
				})
				assert.fail(`Expected ${mod} to throw`)
			} catch (err) {
				const stderr = err.stderr || ""
				assert.match(stderr, /NodeCompatibilityError/,
					`${mod} should throw NodeCompatibilityError`)
				assert.match(stderr, new RegExp(`"${mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" is not implemented in qn`),
					`${mod} error should mention module name`)
			} finally {
				try { unlinkSync(file) } catch {}
			}
		})
	}
})
