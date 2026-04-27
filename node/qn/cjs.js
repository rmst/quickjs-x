/**
 * CommonJS compatibility layer for qn.
 *
 * Provides require() support so that ESM code can import CJS modules.
 * CJS files are detected by the source transform (in bootstrap.js) and
 * wrapped into ESM modules that call __cjsLoad(). CJS-to-CJS require()
 * chains are handled by the synchronous evaluator here.
 *
 * Only ESM-importing-CJS is supported. Top-level CJS is not.
 */

import * as std from "std"
import { dirname, join, extname } from "node:path"
import { detectModule } from "./bootstrap-utils.js"

const EMBEDDED_PREFIX = "embedded://"

/** Strip embedded:// prefix to get a real filesystem path */
function toFsPath(path) {
	return path.startsWith(EMBEDDED_PREFIX) ? path.slice(EMBEDDED_PREFIX.length) : path
}


/** Module cache: absolute path → { exports, loaded } */
const moduleCache = new Map()

/**
 * Check if a file exists (synchronous).
 */
function fileExists(path) {
	try {
		const f = std.open(path, "r")
		if (f) { f.close(); return true }
	} catch {}
	return false
}

/**
 * Read the nearest package.json from a directory, walking up.
 * Returns the parsed object or null.
 */
function readNearestPackageJson(dir) {
	let current = dir
	for (;;) {
		const pkgPath = join(current, "package.json")
		const content = std.loadFile(pkgPath)
		if (content) {
			try { return JSON.parse(content) } catch {}
		}
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	return null
}

/**
 * Check if a file path should be treated as CJS.
 * - .cjs → always CJS
 * - .mjs → never CJS
 * - .js with package.json "type": "commonjs" → CJS
 * - .js with package.json "type": "module" → ESM
 * - .js with no/missing type field → sniff source: top-level import/export
 *   means ESM, otherwise CJS. Matches Node's --experimental-detect-module
 *   (default-on since Node 22.7).
 */
export function isCjs(filename, source) {
	const ext = extname(filename)
	if (ext === ".cjs") return true
	if (ext === ".mjs") return false
	if (ext === ".js") {
		const pkg = readNearestPackageJson(dirname(filename))
		if (pkg?.type === "commonjs") return true
		if (pkg?.type === "module") return false
		if (source === undefined) return false
		return !detectModule(source)
	}
	return false
}

/**
 * Resolve a require() specifier relative to a directory.
 * Handles: relative paths, JSON, node_modules (basic).
 */
function resolveRequire(specifier, fromDir) {
	// Relative or absolute path
	if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
		const base = specifier.startsWith("/") ? specifier : join(fromDir, specifier)
		return resolveFile(base)
	}

	// Bare specifier — walk node_modules
	return resolveNodeModules(specifier, fromDir)
}

/**
 * Try to resolve a file path with CJS extension probing.
 * Order: exact, .js, .json, .cjs, /index.js, /index.json, /index.cjs
 */
function resolveFile(path) {
	const suffixes = ["", ".js", ".json", ".cjs", "/index.js", "/index.json", "/index.cjs"]
	for (const suffix of suffixes) {
		const candidate = path + suffix
		if (fileExists(candidate)) return candidate
	}
	return null
}

/**
 * Resolve a bare specifier by walking up node_modules directories.
 */
function resolveNodeModules(specifier, fromDir) {
	// Split package name from subpath
	let pkgName, subpath
	if (specifier.startsWith("@")) {
		const parts = specifier.split("/")
		pkgName = parts.slice(0, 2).join("/")
		subpath = parts.slice(2).join("/") || null
	} else {
		const slashIdx = specifier.indexOf("/")
		pkgName = slashIdx === -1 ? specifier : specifier.slice(0, slashIdx)
		subpath = slashIdx === -1 ? null : specifier.slice(slashIdx + 1)
	}

	let current = fromDir
	for (;;) {
		const pkgDir = join(current, "node_modules", pkgName)
		if (fileExists(join(pkgDir, "package.json"))) {
			if (subpath) {
				const resolved = resolveFile(join(pkgDir, subpath))
				if (resolved) return resolved
			} else {
				// Read package.json for "main" or "exports"
				const pkgContent = std.loadFile(join(pkgDir, "package.json"))
				if (pkgContent) {
					try {
						const pkg = JSON.parse(pkgContent)
						// Try exports field with require condition
						const entry = resolvePackageExports(pkg, subpath || ".", pkgDir)
						if (entry) return entry
						// Fallback to main
						if (pkg.main) {
							const resolved = resolveFile(join(pkgDir, pkg.main))
							if (resolved) return resolved
						}
					} catch {}
				}
				// Fallback to index.js
				const resolved = resolveFile(join(pkgDir, "index"))
				if (resolved) return resolved
			}
		}

		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	return null
}

/**
 * Resolve package.json "exports" field with "require" condition.
 */
function resolvePackageExports(pkg, subpath, pkgDir) {
	const exports = pkg.exports
	if (!exports) return null

	const key = subpath === "." ? "." : "./" + subpath

	if (typeof exports === "string" && subpath === ".") {
		return resolveFile(join(pkgDir, exports))
	}

	if (typeof exports === "object" && !Array.isArray(exports)) {
		const entry = exports[key]
		if (entry) {
			const target = resolveExportTarget(entry, pkgDir)
			if (target) return target
		}
		// If root import, try the exports object itself as a conditional
		if (subpath === ".") {
			const target = resolveExportTarget(exports, pkgDir)
			if (target) return target
		}
	}

	return null
}

/**
 * Resolve a single export target, handling conditional objects.
 * Prefers "require" condition, then "default".
 */
function resolveExportTarget(target, pkgDir) {
	if (typeof target === "string") {
		return resolveFile(join(pkgDir, target))
	}
	if (typeof target === "object" && target !== null && !Array.isArray(target)) {
		// Try conditions in order: require, default
		for (const condition of ["require", "default"]) {
			if (condition in target) {
				const result = resolveExportTarget(target[condition], pkgDir)
				if (result) return result
			}
		}
	}
	return null
}


/**
 * Create a require function bound to a specific directory.
 */
function makeRequire(fromDir) {
	function require(specifier) {
		const resolved = resolveRequire(specifier, fromDir)
		if (!resolved) {
			throw new Error(`Cannot find module '${specifier}' from '${fromDir}'`)
		}

		// Check cache
		if (moduleCache.has(resolved)) {
			return moduleCache.get(resolved).exports
		}

		// JSON files
		if (resolved.endsWith(".json")) {
			const content = std.loadFile(resolved)
			if (!content) throw new Error(`Cannot read module '${resolved}'`)
			const exports = JSON.parse(content)
			moduleCache.set(resolved, { exports, loaded: true })
			return exports
		}

		// Create module record and insert into cache BEFORE evaluating
		// (handles circular dependencies — returns partial exports)
		const module = { exports: {}, loaded: false, id: resolved, filename: resolved }
		moduleCache.set(resolved, module)

		// Read source
		const source = std.loadFile(resolved)
		if (source === null) throw new Error(`Cannot read module '${resolved}'`)

		// Wrap and evaluate
		const moduleDir = dirname(resolved)
		const wrappedSource = `(function(exports, require, module, __filename, __dirname) {\n${source}\n})`
		const wrapper = std.evalScript(wrappedSource, { backtrace_barrier: true })
		const childRequire = makeRequire(moduleDir)
		childRequire.resolve = (spec) => {
			const r = resolveRequire(spec, moduleDir)
			if (!r) throw new Error(`Cannot find module '${spec}' from '${moduleDir}'`)
			return r
		}
		childRequire.cache = moduleCache
		wrapper(module.exports, childRequire, module, resolved, moduleDir)
		module.loaded = true

		return module.exports
	}

	require.resolve = (specifier) => {
		const resolved = resolveRequire(specifier, fromDir)
		if (!resolved) throw new Error(`Cannot find module '${specifier}' from '${fromDir}'`)
		return resolved
	}
	require.cache = moduleCache

	return require
}

/**
 * Called by the CJS wrapper generated by the source transform.
 * Evaluates a CJS module body and returns { module, exports, require }.
 *
 * @param {string} filename - Absolute path of the CJS file
 * @param {string} dir - Directory of the CJS file
 * @param {function} body - The wrapped CJS module function
 * @returns {{ module: { exports: any }, exports: object, require: function }}
 */
export function __cjsLoad(filename, dir, body) {
	// Strip embedded:// prefix for filesystem access in standalone binaries
	const fsDir = toFsPath(dir)
	const fsFilename = toFsPath(filename)

	// Check cache (in case this module was already require()'d)
	if (moduleCache.has(fsFilename)) {
		const cached = moduleCache.get(fsFilename)
		return { module: cached, exports: cached.exports, require: makeRequire(fsDir) }
	}

	const module = { exports: {}, loaded: false, id: fsFilename, filename: fsFilename }
	moduleCache.set(fsFilename, module)

	const require = makeRequire(fsDir)
	require.resolve = (specifier) => {
		const resolved = resolveRequire(specifier, fsDir)
		if (!resolved) throw new Error(`Cannot find module '${specifier}' from '${fsDir}'`)
		return resolved
	}
	require.cache = moduleCache

	body(module.exports, require, module, fsFilename, fsDir)
	module.loaded = true

	return { module, exports: module.exports, require }
}

/**
 * createRequire - Node.js compatible createRequire function.
 * Creates a require function relative to the given filename/URL.
 */
export function createRequire(filenameOrUrl) {
	let filepath
	if (typeof filenameOrUrl === "string") {
		if (filenameOrUrl.startsWith("file://")) {
			filepath = filenameOrUrl.slice(7)
		} else {
			filepath = filenameOrUrl
		}
	} else if (filenameOrUrl instanceof URL) {
		filepath = filenameOrUrl.pathname
	} else {
		throw new TypeError("createRequire argument must be a string or URL")
	}
	return makeRequire(dirname(filepath))
}

// Register on global so node:module can delegate to us without a static import
// (avoids eagerly loading qn:cjs when node:module is imported in qnc's TS context)
globalThis.__qn_createRequire = createRequire
