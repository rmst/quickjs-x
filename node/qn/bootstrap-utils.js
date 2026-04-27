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
 * Returns true if the code contains a top-level `import` or `export`
 * statement (which would be a syntax error in script mode). Excludes
 * dynamic `import(...)` and `import.meta` since those are valid in scripts.
 *
 * Heuristic only: comments are stripped naively and string contents are
 * not parsed, so a string literal containing a newline followed by
 * `import x from ...` could trigger a false positive. Acceptable for
 * the `-e` use case.
 */
export function detectModule(code) {
	const stripped = code
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/\/\/[^\n]*/g, '')
	return /(^|[\n;])\s*import\s+["'a-zA-Z_$*{]/.test(stripped) ||
		/(^|[\n;])\s*export\b/.test(stripped)
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
