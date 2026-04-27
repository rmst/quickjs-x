/**
 * Shared utilities for bootstrap files (qn and qx)
 */

import { statSync, S_IFMT, S_IFDIR } from "qn:uv-fs"
import { resolve } from "node:path"
import * as std from "std"

/** Check if a path is a directory */
export function isDirectory(path) {
	try {
		const st = statSync(path)
		return (st.mode & S_IFMT) === S_IFDIR
	} catch {
		return false
	}
}

/**
 * Detect whether a string of code should be evaluated as an ES module.
 *
 * Returns true if the code contains an unambiguous ESM marker. Used both
 * for `-e` evaluation and (via isCjs) for .js files that lack a package.json
 * "type" field — matches Node's --experimental-detect-module behavior.
 *
 * Markers checked, in order:
 *   1. Hard ESM: top-level `import`/`export`, `import.meta`
 *   2. Hard CJS: `module.exports`, `exports.x =`, `require(...)` — short-circuits
 *      so files with these are never classified ESM, even if a stray TLA-like
 *      pattern appears inside an async function.
 *   3. Soft ESM: top-level `await` / `for await`, anchored at column 0 to avoid
 *      matching indented `await` inside a function body.
 *
 * Heuristic only: comments are stripped naively and string contents are not
 * parsed. Acceptable for the use cases — pathological code with the keywords
 * inside template literals could mis-classify.
 */
export function detectModule(code) {
	const stripped = code
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/\/\/[^\n]*/g, '')
	if (/(^|[\n;])\s*import\s+["'a-zA-Z_$*{]/.test(stripped)) return true
	if (/(^|[\n;])\s*export\b/.test(stripped)) return true
	if (/\bimport\.meta\b/.test(stripped)) return true
	if (/\bmodule\.exports\b/.test(stripped)) return false
	if (/(^|[\n;{])\s*exports\.[\w$]+\s*=/.test(stripped)) return false
	if (/(^|[\n;{(=,!&|?:[])\s*require\s*\(/.test(stripped)) return false
	if (/\b(?:__filename|__dirname)\b/.test(stripped)) return false
	if (/(^|\n)[ \t]*(?:(?:const|let|var)\b[^=\n]*=[ \t]*)?await\s/.test(stripped)) return true
	if (/(^|\n)[ \t]*for\s+await\b/.test(stripped)) return true
	return false
}

/**
 * Resolve a directory to its entry point file.
 * Matches Node.js behavior:
 * 1. If directory contains package.json with "main" field, use that
 * 2. Otherwise, fall back to index.js
 */
export function resolveDirectoryEntry(dirPath) {
	const pkgJsonPath = resolve(dirPath, 'package.json')

	try {
		const pkgJson = std.loadFile(pkgJsonPath)
		const pkg = JSON.parse(pkgJson)
		if (pkg.main) {
			return resolve(dirPath, pkg.main)
		}
	} catch {
		// No package.json or invalid JSON - fall through to index.js
	}

	// Try index.js first, then index.ts
	for (const name of ['index.js', 'index.ts']) {
		const path = resolve(dirPath, name)
		try {
			const st = statSync(path)
			if ((st.mode & S_IFMT) !== S_IFDIR) return path
		} catch {}
	}
	// Default to index.js for error message consistency
	return resolve(dirPath, 'index.js')
}
