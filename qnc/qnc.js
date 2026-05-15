/**
 * qnc — QuickJS Compiler (JS orchestration)
 *
 * Replaces the C-based qnc orchestration with JavaScript.
 * Runs on vanilla QuickJS (qjs) with the qnc-engine.so native module.
 *
 * Usage: qjs qnc/qnc.js [options] [files]
 */
import * as std from "std"
import * as os from "os"

// Resolve engine.so relative to this script
const scriptDir = (() => {
	// import.meta.url is not available in vanilla qjs, use scriptArgs
	const arg0 = scriptArgs[0]
	const slash = arg0.lastIndexOf("/")
	return slash >= 0 ? arg0.slice(0, slash) : "."
})()

const { Compiler, JS_STRIP_SOURCE, JS_STRIP_DEBUG } = await import(scriptDir + "/qnc-engine.so")

// Detect operating mode:
// - Dev mode: scriptDir is <repo>/qnc, support files in <repo>/bin/<platform>/
// - Extracted mode: scriptDir is the extracted cache dir with qjs, qnc.js,
//   support files (headers, C sources, JS sources) all in the same tree
const extractedMode = (() => {
	// If quickjs.h exists next to qnc.js, we're in extracted mode
	const [, err] = os.stat(scriptDir + "/quickjs.h")
	return err === 0
})()

const repoRoot = (() => {
	if (extractedMode) return scriptDir
	const root = scriptDir.endsWith("/qnc")
		? scriptDir.slice(0, -4) : scriptDir + "/.."
	const [resolved] = os.realpath(root)
	return resolved || root
})()

// Auto-configure NODE_PATH for module resolution during compilation
;(() => {
	let basePaths
	if (extractedMode) {
		// Extracted mode: JS sources are under js/ prefix
		const jsDir = scriptDir + "/js"
		basePaths = [jsDir, jsDir + "/node",
			jsDir + "/vendor", jsDir + "/vendor/sucrase-js"]
	} else {
		// Dev mode: sources are in the repo tree
		const [, e1] = os.stat(repoRoot + "/node")
		const [, e2] = os.stat(repoRoot + "/vendor")
		if (e1 !== 0 || e2 !== 0) return
		basePaths = [repoRoot, repoRoot + "/node",
			repoRoot + "/vendor", repoRoot + "/vendor/sucrase-js"]
	}
	const existing = std.getenv("NODE_PATH") || ""
	const newPath = existing
		? existing + ":" + basePaths.join(":")
		: basePaths.join(":")
	std.setenv("NODE_PATH", newPath)
})()

/* ---- Constants ---- */
const EMBEDDED_PREFIX = "embedded://"
const EXTENSION_SUFFIXES = [".js", ".ts", "/index.js", "/index.ts"]
const CJS_PREFIX = 'import { __cjsLoad } from "qn:cjs"\n' +
	'const { module: __cjs_module } = __cjsLoad(' +
	'import.meta.filename, import.meta.dirname, ' +
	'function(exports, require, module, __filename, __dirname) {\n'
const CJS_SUFFIX = '\n});\nexport default __cjs_module.exports;\n'

/* Default modules included in every qnc build unless --no-default-modules */
const DEFAULT_MODULES = [
	"qn:init", "qn:repl",
	"node:fs", "node:fs/promises", "node:process", "node:child_process",
	"node:crypto", "node:path", "node:events",
	"node:readline", "node:readline/promises",
	"node:stream", "node:stream/promises",
	"node:buffer", "node:url", "node:abort",
	"node:fetch", "node:fetch/Headers", "node:fetch/Response",
	"node:dgram", "node:net", "node:http", "node:http/parse",
	"node:sqlite", "node:util", "node:assert", "node:assert/strict", "node:test",
	"node:os", "node:module", "node:timers", "node:zlib",
	// Stubs for unimplemented node:* modules (throw NodeCompatibilityError on import)
	"node:async_hooks", "node:cluster", "node:diagnostics_channel", "node:dns",
	"node:domain", "node:http2", "node:https", "node:inspector",
	"node:perf_hooks", "node:punycode", "node:querystring",
	"node:repl", "node:string_decoder", "node:tty",
	"node:v8", "node:vm", "node:wasi", "node:worker_threads",
	"qn:crypto", "qn:tls", "qn:fetch", "qn:introspect", "qn:http", "qn:pty",
	"qn:version-info", "qn:sucrase", "qn:worker", "qn:cjs", "qn:process", "qn:proxy", "qn:proxy/cli",
	"qn:install", "qn:run", "qn:bundle", "qn:watch",
	"qx", "ws",
]

/* ---- File system helpers (using std/os) ---- */

function fileExists(path) {
	const [st, err] = os.stat(path)
	return err === 0 && (st.mode & os.S_IFMT) !== os.S_IFDIR
}

function dirExists(path) {
	const [st, err] = os.stat(path)
	return err === 0 && (st.mode & os.S_IFMT) === os.S_IFDIR
}

function readFile(path) {
	return std.loadFile(path)
}

function realpath(path) {
	const [resolved, err] = os.realpath(path)
	return err === 0 ? resolved : null
}

function getCwd() {
	return os.getcwd()[0]
}

function getMtime(path) {
	const [st, err] = os.stat(path)
	return err === 0 ? st.mtime : 0
}

function ensureDir(path) {
	const [, err] = os.stat(path)
	if (err === 0) return
	// Recursively create parents
	const slash = path.lastIndexOf("/")
	if (slash > 0) ensureDir(path.slice(0, slash))
	os.mkdir(path)
}

function basename(path) {
	const slash = path.lastIndexOf("/")
	return slash >= 0 ? path.slice(slash + 1) : path
}

function dirname(path) {
	const slash = path.lastIndexOf("/")
	return slash >= 0 ? path.slice(0, slash) : "."
}

function execCmd(argv, verbose, label) {
	if (verbose) print(argv.join(" "))
	else if (label) std.err.puts(`qnc: ${label}\n`)
	const pid = os.exec(argv, { usePath: true })
	return pid
}

/* ---- Module resolution ---- */

function translateColons(name) {
	// node:fs → node/fs, qn:http → qn/http
	const i = name.indexOf(":")
	if (i < 0) return null
	return name.slice(0, i) + "/" + name.slice(i + 1)
}

function isFilesystemPath(name) {
	return name.startsWith("/") || name.startsWith("./") || name.startsWith("../") ||
		name === "." || name === ".."
}

function normalizeModuleName(baseName, name) {
	if (!name.startsWith(".")) return name
	// Find base directory
	const slash = baseName.lastIndexOf("/")
	let dir = slash >= 0 ? baseName.slice(0, slash) : ""
	let rest = name
	while (rest.startsWith("./") || rest.startsWith("../")) {
		if (rest.startsWith("./")) {
			rest = rest.slice(2)
		} else if (rest.startsWith("../")) {
			rest = rest.slice(3)
			const ds = dir.lastIndexOf("/")
			if (ds >= 0) dir = dir.slice(0, ds)
			else dir = ""
		}
	}
	return dir ? dir + "/" + rest : rest
}

function resolveWithIndex(name) {
	if (fileExists(name)) return name
	for (const suffix of EXTENSION_SUFFIXES) {
		const p = name + suffix
		if (fileExists(p)) return p
	}
	return null
}

function resolveNodePath(name) {
	const nodePath = std.getenv("NODE_PATH")
	if (!nodePath) return null
	for (let dir of nodePath.split(":")) {
		if (!dir) continue
		while (dir.endsWith("/")) dir = dir.slice(0, -1)
		const full = dir + "/" + name
		if (fileExists(full)) return full
		for (const suffix of EXTENSION_SUFFIXES) {
			const p = full + suffix
			if (fileExists(p)) return p
		}
	}
	return null
}

function resolvePackageJson(pkgDir, subpath) {
	const pkgPath = pkgDir + "/package.json"
	const content = readFile(pkgPath)
	if (!content) return null
	let pkg
	try { pkg = JSON.parse(content) } catch { return null }

	// Try "exports" field
	if (pkg.exports !== undefined) {
		const key = subpath === "." ? "." : "./" + subpath
		const m = typeof pkg.exports === "string"
			? (subpath === "." ? { target: pkg.exports, capture: null } : null)
			: (typeof pkg.exports === "object" && !Array.isArray(pkg.exports))
				? matchExportKey(pkg.exports, key)
				: null
		if (m) {
			const resolved = resolveExportTarget(m.target, m.capture, pkgDir)
			if (resolved) return resolved
		}
		// For root imports, try treating exports object as conditional
		if (subpath === "." && typeof pkg.exports === "object" && !Array.isArray(pkg.exports)) {
			const resolved = resolveExportTarget(pkg.exports, null, pkgDir)
			if (resolved) return resolved
		}
	}

	// Fallback to "main" field
	if (subpath === "." && typeof pkg.main === "string") {
		return resolveExportTarget(pkg.main, null, pkgDir)
	}
	return null
}

function matchExportKey(obj, key) {
	if (key in obj && !key.includes("*")) return { target: obj[key], capture: null }
	let best = null
	for (const k of Object.keys(obj)) {
		const star = k.indexOf("*")
		if (star < 0) continue
		const prefix = k.slice(0, star)
		const suffix = k.slice(star + 1)
		if (!key.startsWith(prefix)) continue
		if (suffix && !key.endsWith(suffix)) continue
		if (key.length < prefix.length + suffix.length) continue
		if (!best
			|| prefix.length > best.prefix.length
			|| (prefix.length === best.prefix.length && suffix.length > best.suffix.length)) {
			best = {
				target: obj[k],
				capture: key.slice(prefix.length, key.length - suffix.length),
				prefix,
				suffix,
			}
		}
	}
	return best
}

function resolveExportTarget(target, capture, pkgDir) {
	if (typeof target === "string") {
		let path = capture == null ? target : target.replaceAll("*", capture)
		if (path.startsWith("./")) path = path.slice(2)
		return pkgDir + "/" + path
	}
	if (typeof target === "object" && target !== null && !Array.isArray(target)) {
		for (const cond of ["import", "default"]) {
			if (cond in target) {
				const resolved = resolveExportTarget(target[cond], capture, pkgDir)
				if (resolved) return resolved
			}
		}
	}
	return null
}

function resolveNodeModules(baseName, name) {
	// Extract package name
	let pkgLen
	if (name.startsWith("@")) {
		pkgLen = name.indexOf("/", name.indexOf("/") + 1)
		if (pkgLen < 0) pkgLen = name.length
	} else {
		pkgLen = name.indexOf("/")
		if (pkgLen < 0) pkgLen = name.length
	}
	const pkgName = name.slice(0, pkgLen)
	const subpath = pkgLen < name.length ? name.slice(pkgLen + 1) : "."

	let dir = dirname(baseName)
	while (dir && dir !== "/") {
		const pkgDir = dir + "/node_modules/" + pkgName
		if (dirExists(pkgDir)) {
			// Try package.json
			const resolved = resolvePackageJson(pkgDir, subpath)
			if (resolved && fileExists(resolved)) return resolved

			// Fallback: direct file resolution
			const target = subpath === "." ? pkgDir : pkgDir + "/" + subpath
			const found = resolveWithIndex(target)
			if (found) return found
		}
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return null
}

function resolveCompileRealpath(path) {
	const real = realpath(path)
	if (!real) return null
	const cwd = getCwd()
	if (cwd && real.startsWith(cwd + "/")) {
		return real.slice(cwd.length + 1)
	}
	return real
}

/* ---- POSIX path helpers (for tsconfig paths env) ----
   qnc.js runs on vanilla qjs without node:path, so we inline minimal
   helpers sufficient for the tsconfig-paths resolver. */

function normalizePosix(p) {
	if (!p) return "."
	const isAbs = p.startsWith("/")
	const segs = p.split("/").filter(s => s && s !== ".")
	const out = []
	for (const s of segs) {
		if (s === "..") {
			if (out.length && out[out.length - 1] !== "..") out.pop()
			else if (!isAbs) out.push("..")
		} else out.push(s)
	}
	const res = out.join("/")
	return isAbs ? "/" + res : (res || ".")
}

function joinPosix(...parts) {
	const joined = parts.filter(Boolean).join("/").replace(/\/+/g, "/")
	return normalizePosix(joined)
}

function resolvePosix(...parts) {
	let acc = ""
	for (const p of parts) {
		if (!p) continue
		if (p.startsWith("/")) acc = p
		else acc = acc ? acc + "/" + p : p
	}
	return normalizePosix(acc || ".")
}

function isAbsolutePosix(p) { return typeof p === "string" && p.startsWith("/") }

/* ---- tsconfig paths resolver (preloaded at module init; consulted by
   resolverFn as a last-resort fallback for bare specifiers so source
   trees using TypeScript `compilerOptions.paths` compile via qnc). */

const _tsconfigPathsModulePath = extractedMode
	? scriptDir + "/js/node/qn/tsconfig-paths.js"
	: repoRoot + "/node/qn/tsconfig-paths.js"
const { createTsconfigPathsResolver: _createTsconfigPathsResolver } =
	await import(_tsconfigPathsModulePath)
const tsconfigPathsResolver = _createTsconfigPathsResolver({
	env: {
		readFile: p => readFile(p),
		isFile: p => fileExists(p),
		isDir: p => dirExists(p),
		dirname,
		isAbsolute: isAbsolutePosix,
		join: joinPosix,
		resolve: resolvePosix,
	}
})

/* ---- Source transforms ---- */

let tsTransform = null

function initTypeScriptTransform() {
	// Load Sucrase for TypeScript stripping
	// We import node:module which imports qn:sucrase → vendor/sucrase-js
	const nodePath = std.getenv("NODE_PATH") || ""
	const dirs = nodePath.split(":").filter(Boolean)

	// Try to find and load the transform
	for (const dir of dirs) {
		const modulePath = dir + "/node/module.js"
		if (fileExists(modulePath)) {
			try {
				const mod = std.loadFile(modulePath)
				// We can't easily dynamic-import in vanilla qjs within
				// this context, so we'll use a simpler approach: check
				// if the Sucrase transform is available via the compile
				// engine's separate TS runtime
				break
			} catch {}
		}
	}
}

// For TypeScript transform, we'll use a separate Compiler instance
// dedicated to running the transform in its own context.
// Actually, since qnc.js runs on vanilla qjs which can load modules,
// we can import Sucrase directly.
let sucraseTransform = null
let sucraseParse = null

function loadSucrase() {
	// Find sucrase in NODE_PATH
	const nodePath = std.getenv("NODE_PATH") || ""
	for (const dir of nodePath.split(":").filter(Boolean)) {
		const indexPath = dir + "/qn/sucrase.js"
		if (fileExists(indexPath)) {
			return import(indexPath)
		}
		// Also try direct vendor path
		const vendorPath = dir + "/../vendor/sucrase-js/sucrase/src/index.js"
		if (fileExists(vendorPath)) {
			return import(vendorPath)
		}
	}
	return null
}

function stripTypeScript(source, filename) {
	if (!filename.endsWith(".ts")) return source
	if (!sucraseTransform) return source // TS not available, pass through

	// Reject value namespaces before either mode runs — neither strip nor
	// transform can faithfully emit them, so we throw with a clear error
	// instead of producing code that fails at runtime.
	const TT_DECLARE = 103952, CK_NAMESPACE = 23
	const detectTokens = sucraseParse(source, false, true, false).tokens
	for (let i = 0; i < detectTokens.length; i++) {
		const t = detectTokens[i]
		if (t.contextualKeyword !== CK_NAMESPACE) continue
		let j = i - 1
		while (j >= 0 && detectTokens[j].start === detectTokens[j].end) j--
		if (j < 0 || detectTokens[j].type !== TT_DECLARE) {
			throw new SyntaxError(
				"TypeScript namespace with runtime values is not supported. " +
				"Use `declare namespace` for type-only declarations or ES modules."
			)
		}
	}

	// Try strip mode first (preserves source positions). Blanking can silently
	// produce invalid JS when newlines inside a type region violate a
	// no-LineTerminator restriction (e.g. multi-line arrow return type —
	// LT between `)` and `=>` is a parse error), so re-parse to validate.
	try {
		const blanked = blankTypeScriptTypes(source)
		sucraseParse(blanked, false, false, false)
		return blanked
	} catch {
		// Fall back to full transform
		return sucraseTransform(source, {
			transforms: ["typescript"],
			disableESTransforms: true
		}).code
	}
}

// Minimal TypeScript type blanking (mirrors node/node/module.js)
function blankTypeScriptTypes(code) {
	if (!sucraseParse) throw new Error("Sucrase parser not available")
	const TT_IMPORT = 90640, TT_EXPORT = 89104, TT_STRING = 4608
	const TT_ENUM = 113168, TT_BRACE_R = 11264
	const CK_TYPE = 38, CK_NAMESPACE = 23, CK_FROM = 13

	const file = sucraseParse(code, false, true, false)
	const tokens = file.tokens
	const ranges = []

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]
		if (t.start === t.end) continue
		if (t.type === TT_ENUM) throw new SyntaxError("TypeScript enum not supported in strip mode")
		if (t.contextualKeyword === CK_NAMESPACE && !t.isType)
			throw new SyntaxError("TypeScript namespace not supported in strip mode")

		if ((t.type === TT_IMPORT || t.type === TT_EXPORT) && i + 1 < tokens.length) {
			const next = tokens[i + 1]
			if (next.contextualKeyword === CK_TYPE && !next.isType) {
				let lastIdx = i + 1
				for (let j = i + 2; j < tokens.length; j++) {
					if (tokens[j].start === tokens[j].end) continue
					lastIdx = j
					if (tokens[j].type === TT_STRING) break
					if (tokens[j].type === TT_BRACE_R) {
						let hasFrom = false
						for (let k = j + 1; k < tokens.length; k++) {
							if (tokens[k].start === tokens[k].end) continue
							if (tokens[k].contextualKeyword === CK_FROM) hasFrom = true
							break
						}
						if (!hasFrom) break
					}
				}
				ranges.push(t.start, tokens[lastIdx].end)
				i = lastIdx
				continue
			}
		}

		if (t.isType) {
			let regionStart = t.start
			if (i > 0 && !tokens[i - 1].isType) regionStart = tokens[i - 1].end
			let regionEnd = t.end
			while (i + 1 < tokens.length && tokens[i + 1].isType) {
				i++
				regionEnd = tokens[i].end
			}
			ranges.push(regionStart, regionEnd)
		}
	}

	if (ranges.length === 0) return code
	let out = "", pos = 0
	for (let i = 0; i < ranges.length; i += 2) {
		const start = ranges[i], end = ranges[i + 1]
		out += code.slice(pos, start)
		for (let j = start; j < end; j++) {
			const ch = code.charCodeAt(j)
			out += (ch === 10 || ch === 13) ? code[j] : " "
		}
		pos = end
	}
	return out + code.slice(pos)
}

/* ---- CJS detection ---- */

function isCjs(filename, source) {
	if (filename.endsWith(".cjs")) return true
	if (filename.endsWith(".mjs")) return false
	if (!filename.endsWith(".js")) return false

	// Walk up looking for package.json "type" field
	let pkgType = null
	let dir = dirname(filename)
	while (dir && dir !== "/") {
		const pkgPath = dir + "/package.json"
		const content = readFile(pkgPath)
		if (content) {
			try {
				pkgType = JSON.parse(content).type ?? null
			} catch {}
			break
		}
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	if (pkgType === "commonjs") return true
	if (pkgType === "module") return false
	if (source === undefined) return false
	// Match Node's --experimental-detect-module: ESM if source has top-level
	// import/export, otherwise CJS.
	return !sniffEsm(source)
}

function sniffEsm(code) {
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

function wrapCjs(source) {
	return CJS_PREFIX + source + CJS_SUFFIX
}

/* ---- Source transform pipeline ---- */

function transformSource(source, filename) {
	source = stripTypeScript(source, filename)
	if (isCjs(filename, source)) source = wrapCjs(source)
	return source
}

/* ---- Native module detection (package.json "qnc" field) ---- */

function parseNativePackage(pkgDir, targetNameMatch) {
	const pkgPath = pkgDir + "/package.json"
	const content = readFile(pkgPath)
	if (!content) return null
	let pkg
	try { pkg = JSON.parse(content) } catch { return null }
	if (!pkg.qnc) return null
	const qnc = pkg.qnc
	if (!qnc.target_name) return null
	if (targetNameMatch && qnc.target_name !== targetNameMatch) return null

	const nm = {
		targetName: qnc.target_name,
		initName: "js_init_module_" + qnc.target_name,
		pkgJsonPath: pkgPath,
		sources: [],
		objects: [],
		includeDirs: [],
		defines: [],
		cflags: [],
		ldflags: [],
		objFiles: [],
	}

	// Parse arrays (resolve relative to pkgDir)
	if (Array.isArray(qnc.sources))
		nm.sources = qnc.sources.map(s => pkgDir + "/" + s)
	if (Array.isArray(qnc.objects))
		nm.objects = qnc.objects.map(s => pkgDir + "/" + s)
	if (Array.isArray(qnc.include_dirs))
		nm.includeDirs = qnc.include_dirs.map(s => pkgDir + "/" + s)
	if (Array.isArray(qnc.defines))
		nm.defines = [...qnc.defines]
	if (Array.isArray(qnc.cflags))
		nm.cflags = [...qnc.cflags]
	if (Array.isArray(qnc.ldflags))
		nm.ldflags = [...qnc.ldflags]

	// source_dirs: recursively collect .c files
	if (Array.isArray(qnc.source_dirs)) {
		for (const sd of qnc.source_dirs) {
			collectCSources(pkgDir + "/" + sd, nm.sources)
		}
	}

	return nm
}

function collectCSources(dir, sources) {
	const [entries, err] = os.readdir(dir)
	if (err !== 0 || !entries) return
	for (const name of entries) {
		if (name.startsWith(".")) continue
		const path = dir + "/" + name
		const [st, err] = os.stat(path)
		if (err !== 0) continue
		if ((st.mode & os.S_IFMT) === os.S_IFDIR) {
			collectCSources(path, sources)
		} else if (name.endsWith(".c")) {
			sources.push(path)
		}
	}
}

/* ---- C code generation ---- */

function encodeUTF8(str) {
	const bytes = []
	for (let i = 0; i < str.length; i++) {
		let c = str.charCodeAt(i)
		if (c < 0x80) {
			bytes.push(c)
		} else if (c < 0x800) {
			bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
		} else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
			const c2 = str.charCodeAt(i + 1)
			if (c2 >= 0xdc00 && c2 <= 0xdfff) {
				c = ((c - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000
				i++
				bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f),
					0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
			}
		} else {
			bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
		}
	}
	return bytes
}

function dumpHex(bytes) {
	let out = "", col = 0
	for (let i = 0; i < bytes.length; i++) {
		out += " 0x" + bytes[i].toString(16).padStart(2, "0") + ","
		if (++col === 8) { out += "\n"; col = 0 }
	}
	if (col !== 0) out += "\n"
	return out
}

function generateCFile(entries, importMap, initModules, embeddedNames,
                       featureBitmap, stackSize, cModules, noDefaultModules) {
	let out = "/* File generated automatically by the QuickJS compiler. */\n\n"

	out += '#include "quickjs-libc.h"\n'
	out += '#include "cutils.h"\n'
	out += "#include <sys/stat.h>\n"
	out += "#include <unistd.h>\n\n"
	out += '#include "module_resolution/module-resolution.h"\n'
	out += '#include "exit-handler.h"\n'
	out += '#include "libuv/qn-vm.h"\n'
	out += '#include "libuv/qn-worker.h"\n\n'

	// Runtime module loader
	out += `static JSModuleDef *qn_loader(JSContext *ctx, const char *name, void *opaque, JSValueConst attributes) {
    if (has_embedded_prefix(name)) {
        JS_ThrowReferenceError(ctx, "could not load embedded module '%s'", name + EMBEDDED_PREFIX_LEN);
        return NULL;
    }
    if (name[0] != '.' && name[0] != '/') {
        char *path = resolve_node_path(ctx, name);
        if (path) {
            JSModuleDef *mod = qn_module_loader(ctx, path, opaque, attributes);
            js_free(ctx, path);
            return mod;
        }
    }
    if (!is_node_resolution()) {
        char *resolved_path = resolve_with_index(ctx, name);
        if (resolved_path) {
            JSModuleDef *mod = qn_module_loader(ctx, resolved_path, opaque, attributes);
            js_free(ctx, resolved_path);
            return mod;
        }
    }
    return qn_module_loader(ctx, name, opaque, attributes);
}\n\n`

	// Bytecode arrays
	for (const e of entries) {
		if (e.type === "cmodule") continue
		out += `const uint32_t ${e.cname}_size = ${e.bytecode.length};\n\n`
		out += `const uint8_t ${e.cname}[${e.bytecode.length}] = {\n`
		out += dumpHex(e.bytecode)
		out += "};\n\n"
		// For JSON modules, also output the module name
		if (e.type === "json" && e.moduleName) {
			const nameBytes = encodeUTF8(e.moduleName + "\0")
			out += `static const uint8_t ${e.cname}_module_name[] = {\n`
			out += dumpHex(nameBytes)
			out += "};\n\n"
		}
	}

	// Embedded module names array
	out += "/* Embedded module names for runtime resolution */\n"
	out += "static const char *qn_embedded_modules[] = {\n"
	for (const name of embeddedNames)
		out += `    "${name}",\n`
	out += "    NULL\n};\n\n"

	// Import map
	out += "/* Import map: (base, specifier) -> resolved name */\n"
	out += "static const QNImportMapEntry qn_import_map[] = {\n"
	for (const e of importMap)
		out += `    { "${e.base}", "${e.specifier}", "${e.resolved}" },\n`
	out += "};\n\n"

	// Resolver context
	out += `static QNModuleResolverContext qn_resolver_ctx = {
    .embedded_modules = qn_embedded_modules,
    .import_map = qn_import_map,
    .import_map_count = ${importMap.length},
    .compile_mode = 0,
    .record_import = NULL,
};\n\n`

	// Feature list
	const features = [
		"Date", "Eval", "StringNormalize", "RegExp", "JSON", "Proxy",
		"MapSet", "TypedArrays", "Promise", null /* module-loader */, "WeakRef"
	]
	const FE_MODULE_LOADER = 9

	// JS_NewCustomContext
	out += `static JSContext *JS_NewCustomContext(JSRuntime *rt)
{
  JSContext *ctx = JS_NewContextRaw(rt);
  if (!ctx) return NULL;
  JS_AddIntrinsicBaseObjects(ctx);\n`
	for (let i = 0; i < features.length; i++) {
		if ((featureBitmap & (1n << BigInt(i))) && features[i])
			out += `  JS_AddIntrinsic${features[i]}(ctx);\n`
	}
	// Init C modules
	for (const m of initModules) {
		out += `  {\n`
		out += `    extern JSModuleDef *js_init_module_${m.cname}(JSContext *ctx, const char *name);\n`
		out += `    js_init_module_${m.cname}(ctx, "${m.name}");\n`
		out += `  }\n`
	}
	// Eval dependency module bytecodes (load_only=1, don't execute yet)
	for (const e of entries) {
		if (e.isEntry) continue  // entry points go in main()
		if (e.type === "module")
			out += `  qn_vm_eval_binary(ctx, ${e.cname}, ${e.cname}_size, 1);\n`
		else if (e.type === "json")
			out += `  qn_vm_eval_binary_json_module(ctx, ${e.cname}, ${e.cname}_size, (const char *)${e.cname}_module_name);\n`
	}
	out += "  return ctx;\n}\n\n"

	// Worker setup
	out += `static void qn_setup_worker_runtime(JSRuntime *rt) {
  js_std_init_handlers(rt);\n`
	if (featureBitmap & (1n << BigInt(FE_MODULE_LOADER)))
		out += `  JS_SetModuleLoaderFunc2(rt, qn_module_normalizer, qn_loader, js_module_check_attributes, &qn_resolver_ctx);\n`
	out += "}\n\n"

	// Bind the __qn_* C functions on globalThis so JS code (notably qn:init
	// and the bootstrap's -e handler) can register hooks and evaluate modules.
	out += `static void qn_install_qn_bindings(JSContext *ctx) {
  JSValue g = JS_GetGlobalObject(ctx);
  JS_SetPropertyStr(ctx, g, "__qn_setSourceTransform",
    JS_NewCFunction(ctx, js_qn_set_source_transform, "__qn_setSourceTransform", 1));
  JS_SetPropertyStr(ctx, g, "__qn_setModuleResolverFallback",
    JS_NewCFunction(ctx, js_qn_set_module_resolver_fallback, "__qn_setModuleResolverFallback", 1));
  JS_SetPropertyStr(ctx, g, "__qn_evalModule",
    JS_NewCFunction(ctx, js_qn_eval_module, "__qn_evalModule", 1));
  JS_FreeValue(ctx, g);
}\n\n`

	// Run qn:init — the shared pre-user-code init module that installs
	// node-globals, registers the .ts/CJS source transform, and registers the
	// tsconfig-paths module resolver fallback. Same module imported by
	// node/bootstrap.js so qn and qnc-built binaries behave identically.
	// Only emitted when qn:init is embedded (i.e. default modules are on).
	if (!noDefaultModules) {
		out += `static void qn_run_qn_init(JSContext *ctx) {
  static const char init_src[] = "import \\"qn:init\\"\\n";
  JSValue val = JS_Eval(ctx, init_src, sizeof(init_src) - 1,
                        "<qn-init>", JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
  if (JS_IsException(val)) {
    js_std_dump_error(ctx);
  } else {
    JSValue ret = JS_EvalFunction(ctx, val);
    if (JS_IsException(ret))
      js_std_dump_error(ctx);
    JS_FreeValue(ctx, ret);
  }
}\n\n`
	}

	// Worker context setup
	out += `static void qn_setup_worker_context(JSContext *ctx) {
  js_std_add_helpers(ctx, 0, NULL);
  qn_install_qn_bindings(ctx);\n`
	if (!noDefaultModules)
		out += `  qn_run_qn_init(ctx);\n`
	out += `}\n\n`

	// main()
	out += `int main(int argc, char **argv)
{
  JSRuntime *rt;
  JSContext *ctx;
  rt = JS_NewRuntime();
  js_std_set_worker_new_context_func(JS_NewCustomContext);
  js_std_init_handlers(rt);\n`

	if (stackSize > 0)
		out += `  JS_SetMaxStackSize(rt, ${stackSize});\n`
	if (featureBitmap & (1n << BigInt(FE_MODULE_LOADER)))
		out += `  JS_SetModuleLoaderFunc2(rt, qn_module_normalizer, qn_loader, js_module_check_attributes, &qn_resolver_ctx);\n`

	out += `  ctx = JS_NewCustomContext(rt);
  qn_vm_init(ctx);
  qn_worker_set_init(qn_setup_worker_runtime, JS_NewCustomContext, qn_setup_worker_context);
  js_std_add_helpers(ctx, argc, argv);
  qn_install_qn_bindings(ctx);\n`
	if (!noDefaultModules)
		out += `  qn_run_qn_init(ctx);\n`

	// Eval entry bytecodes (scripts and entry modules)
	for (const e of entries) {
		if (e.type === "script")
			out += `  qn_vm_eval_binary(ctx, ${e.cname}, ${e.cname}_size, 0);\n`
		else if (e.isEntry && e.type === "module")
			out += `  qn_vm_eval_binary(ctx, ${e.cname}, ${e.cname}_size, 0);\n`
	}

	out += `  qn_vm_loop(ctx);
  int exit_code = qn_call_exit_handler(ctx);
  qn_vm_free(rt);
  qn_free_source_transform(rt);
  qn_free_module_resolver_fallback(rt);
  js_std_free_handlers(rt);
  JS_FreeContext(ctx);
  JS_FreeRuntime(rt);
  return exit_code;
}\n`

	return out
}

/* ---- Compilation orchestration ---- */

function compileProject(opts) {
	const {
		inputFiles, outputFile, outputType, cname: cnameOverride,
		module: moduleMode, dynamicModules, cModules, extraLinkFiles,
		stripFlags, byteSwap, verbose, featureBitmap, stackSize,
		noDefaultModules, cacheDir, prefix, cc,
	} = opts

	// Auto-detect libuv C modules (qn_vm, qn_uv_fs, etc.)
	// These are compiled from libuv/*.c and linked into the binary.
	// Only register files that define js_init_module (skip utility files).
	const LIBUV_UTILS = new Set(["qn_uv_utils"])  // no js_init_module
	const [libuvEntries, libuvErr] = os.readdir(repoRoot + "/libuv")
	if (libuvErr === 0 && libuvEntries) {
		for (const name of libuvEntries) {
			if (!name.endsWith(".c")) continue
			const cname = name.slice(0, -2).replace(/-/g, "_")
			if (LIBUV_UTILS.has(cname)) continue
			if (!cModules.some(m => m.name === cname))
				cModules.push({ name: cname, cname })
		}
	}

	const compiler = new Compiler({
		stripFlags,
		byteSwap,
		prefix: prefix || "qjsc_",
	})

	// Register system C modules and add them to init list
	const initModules = []       // { name, cname }
	for (const m of cModules) {
		compiler.addCModule(m.name)
		initModules.push({ name: m.name, cname: m.cname })
	}

	const entries = []           // { cname, bytecode, type, moduleName, isEntry }
	const importMap = []         // { base, specifier, resolved }
	const embeddedNames = new Set()
	const nativeModules = []     // parsed native module configs
	const cwd = getCwd()
	const entryCnames = new Set() // cnames of entry-point modules

	// Track which modules have been loaded (avoid duplicates)
	const loadedModules = new Set()

	compiler.setBytecodeHandler((cname, bytecode, type, moduleName) => {
		// Skip synthetic stubs (dynamic module triggers)
		if (moduleName && moduleName.includes("<input")) return
		entries.push({
			cname,
			bytecode: new Uint8Array(bytecode),
			type,
			moduleName,
			isEntry: false,
		})
	})

	function resolverFn(base, specifier) {
		// Compile-mode normalizer
		const rawBase = base.startsWith(EMBEDDED_PREFIX) ?
			base.slice(EMBEDDED_PREFIX.length) : base

		// Colon translation: node:fs → node/fs
		const translated = translateColons(specifier)
		const workName = translated || specifier

		// Resolve relative paths
		let effectiveBase = rawBase
		if (isFilesystemPath(rawBase)) {
			const real = realpath(rawBase)
			if (real) effectiveBase = real
		}

		let resolved = normalizeModuleName(effectiveBase, workName)
		let foundOnDisk = false

		if (!isFilesystemPath(workName)) {
			// Bare import — search NODE_PATH and node_modules
			const fullPath = resolveNodePath(resolved)
			if (fullPath) {
				const real = resolveCompileRealpath(fullPath)
				resolved = real || fullPath
				foundOnDisk = true
			} else {
				const nmResolved = resolveNodeModules(effectiveBase, resolved)
				if (nmResolved) {
					const real = resolveCompileRealpath(nmResolved)
					resolved = real || nmResolved
					foundOnDisk = true
				} else {
					const withExt = resolveWithIndex(resolved)
					if (withExt) {
						const real = resolveCompileRealpath(withExt)
						resolved = real || withExt
						foundOnDisk = true
					} else {
						// tsconfig.json / jsconfig.json `compilerOptions.paths`
						// fallback — consulted only when the usual lookups miss,
						// so catch-all aliases don't shadow real packages.
						// Walk up from the importing file's real directory.
						const baseAbs = isAbsolutePosix(effectiveBase)
							? effectiveBase
							: resolvePosix(cwd, effectiveBase)
						const fromDir = dirname(baseAbs)
						const viaPaths = tsconfigPathsResolver.resolve(specifier, fromDir)
						if (viaPaths) {
							const real = resolveCompileRealpath(viaPaths)
							resolved = real || viaPaths
							foundOnDisk = true
						}
					}
				}
			}

			if (foundOnDisk) {
				// Record import map entry for bare imports
				importMap.push({
					base: EMBEDDED_PREFIX + (resolveCompileRealpath(rawBase) || rawBase),
					specifier,
					resolved: EMBEDDED_PREFIX + resolved,
				})
				return EMBEDDED_PREFIX + resolved
			}
			// Not found — assume C module, return as-is
			return resolved
		} else {
			// Filesystem path — probe extensions
			const probed = resolveWithIndex(resolved)
			if (probed) resolved = probed

			const real = resolveCompileRealpath(resolved)
			if (real) resolved = real

			// Record import map entries for paths that differ between
			// the original specifier (stored in bytecode) and the resolved
			// embedded name. This handles absolute paths that get CWD-stripped,
			// ensuring the runtime normalizer can resolve them.
			if (specifier !== resolved && (specifier.startsWith("/") || resolved.startsWith("/"))) {
				importMap.push({
					base: EMBEDDED_PREFIX + (resolveCompileRealpath(rawBase) || rawBase),
					specifier,
					resolved: EMBEDDED_PREFIX + resolved,
				})
			}
			return EMBEDDED_PREFIX + resolved
		}
	}
	compiler.setResolver(resolverFn)

	compiler.setLoader((name) => {
		if (loadedModules.has(name)) return null
		loadedModules.add(name)

		// Strip embedded:// prefix for disk operations
		const diskName = name.startsWith(EMBEDDED_PREFIX)
			? name.slice(EMBEDDED_PREFIX.length) : name

		// Check if it's a registered C module
		if (cModules.some(m => m.name === diskName)) {
			initModules.push({ name, cname: cModules.find(m => m.name === diskName).cname })
			return { type: "cmodule", cname: cModules.find(m => m.name === diskName).cname }
		}

		// Handle .so native modules
		if (diskName.endsWith(".so")) {
			const soDir = dirname(diskName)
			const soBase = basename(diskName)
			const soTarget = soBase.replace(/\.so$/, "")

			const nm = parseNativePackage(soDir, soTarget)
			if (nm) {
				nm.regName = name
				nativeModules.push(nm)
				initModules.push({ name, cname: nm.targetName })
				embeddedNames.add(diskName)
				return { type: "cmodule", cname: nm.targetName }
			}
			// No package.json — warn and create dummy
			std.err.puts(`Warning: binary module '${diskName}' will be dynamically loaded\n`)
			return { type: "cmodule", cname: "dynamic" }
		}

		// Synthetic version-info module
		if (diskName === "qn/version-info" || diskName.endsWith("/qn/version-info.js")) {
			const commit = std.getenv("QNC_GIT_COMMIT") || "unknown"
			const buildTime = std.getenv("QNC_BUILD_TIME")
			const source = buildTime
				? `export const commit = '${commit}', buildTime = '${buildTime}';`
				: `export const commit = '${commit}', buildTime = null;`
			embeddedNames.add(diskName)
			return { type: "module", source, diskName }
		}

		// JSON files
		if (diskName.endsWith(".json")) {
			const source = readFile(diskName)
			if (!source) return null
			embeddedNames.add(diskName)
			return { type: "json", source, diskName }
		}

		// JS/TS modules
		let source = readFile(diskName)
		if (!source) return null

		// Apply source transforms
		source = transformSource(source, diskName)

		embeddedNames.add(diskName)
		return { type: "module", source, diskName }
	})

	// Compile input files
	for (const file of inputFiles) {
		const source = readFile(file)
		if (!source) {
			std.err.puts(`Could not load '${file}'\n`)
			std.exit(1)
		}

		const transformed = transformSource(source, file)

		// Determine if module
		let isModule = moduleMode
		if (isModule < 0) {
			isModule = file.endsWith(".mjs") || file.endsWith(".ts") ||
				compiler.detectModule(transformed)
		}

		// Resolve canonical name
		let canonical = file
		const realFile = realpath(file)
		if (realFile) {
			canonical = realFile
			if (cwd && realFile.startsWith(cwd + "/"))
				canonical = realFile.slice(cwd.length + 1)
		}
		const evalName = isModule ? EMBEDDED_PREFIX + canonical : canonical

		loadedModules.add(evalName)

		const compileOpts = { module: !!isModule, script: !isModule }
		if (cnameOverride) compileOpts.cname = cnameOverride
		const entryCname = compiler.compile(transformed, evalName, compileOpts)
		// Mark this entry as an entry point — goes in main(), not JS_NewCustomContext
		const entry = entries.find(e => e.cname === entryCname)
		if (entry) entry.isEntry = true
	}

	// Compile dynamic modules (-D flags)
	// Use resolver to normalize, then compile synthetic imports.
	// Each gets a unique name but we record import map entries with
	// embedded://<input> base so the runtime normalizer can find them.
	for (let di = 0; di < dynamicModules.length; di++) {
		const dyn = dynamicModules[di]
		// Resolve through our resolver with <input> base
		const resolved = resolverFn(EMBEDDED_PREFIX + "<input>", dyn)
		if (!resolved) {
			std.err.puts(`Could not resolve dynamic module '${dyn}'\n`)
			std.exit(1)
		}

		if (loadedModules.has(resolved)) continue

		// Record import map entry with <input> base for runtime lookups
		importMap.push({
			base: EMBEDDED_PREFIX + "<input>",
			specifier: dyn,
			resolved,
		})

		// Trigger the loader by compiling a synthetic import
		const importSource = `import "${dyn}"\n`
		const importName = EMBEDDED_PREFIX + "<input:" + di + ">"
		try {
			compiler.compile(importSource, importName, { module: true })
		} catch (e) {
			std.err.puts(`Could not load dynamic module '${dyn}': ${e.message}\n`)
			std.exit(1)
		}
	}

	compiler.close()

	// Generate output
	if (outputType === "c" || outputType === "c_main") {
		// Just write the C file
		const cContent = outputType === "c_main"
			? generateCFile(entries, importMap, initModules,
				[...embeddedNames], featureBitmap, stackSize, cModules, noDefaultModules)
			: generateCBytecodeOnly(entries)
		const f = std.open(outputFile, "w")
		f.puts(cContent)
		f.close()
	} else {
		// Generate C, compile to executable
		const cfile = `/tmp/out${os.getpid ? os.getpid() : Date.now()}.c`
		const cContent = generateCFile(entries, importMap, initModules,
			[...embeddedNames], featureBitmap, stackSize, cModules, noDefaultModules)
		const f = std.open(cfile, "w")
		f.puts(cContent)
		f.close()

		const ret = buildExecutable(outputFile, cfile, nativeModules,
			extraLinkFiles, cc, verbose, cacheDir)
		os.remove(cfile)
		if (ret !== 0) std.exit(ret)
	}
}

function generateCBytecodeOnly(entries) {
	let out = "/* File generated automatically by the QuickJS compiler. */\n\n"
	out += "#include <inttypes.h>\n\n"
	for (const e of entries) {
		if (e.type === "cmodule") continue
		out += `const uint32_t ${e.cname}_size = ${e.bytecode.length};\n\n`
		out += `const uint8_t ${e.cname}[${e.bytecode.length}] = {\n`
		out += dumpHex(e.bytecode)
		out += "};\n\n"
	}
	return out
}

/* ---- Build executable ---- */

function buildExecutable(outFile, cfile, nativeModules, extraLinkFiles,
                         cc, verbose, cacheDir) {
	const platform = os.platform || "linux"

	// Find include dir and C sources for compilation
	let incDir, srcDir
	if (extractedMode) {
		// Extracted mode: everything is in scriptDir
		incDir = scriptDir
		srcDir = scriptDir
	} else {
		// Dev mode: headers in bin/<platform>/, sources in repo root
		const binDir = `${repoRoot}/bin/${platform}`
		if (fileExists(`${binDir}/quickjs.h`)) {
			incDir = binDir
			srcDir = repoRoot
		} else {
			std.err.puts("qnc: cannot find support files (quickjs.h)\n")
			return 1
		}
	}

	// Compile native modules
	for (const nm of nativeModules) {
		const ret = compileNativeModule(nm, incDir, cc, verbose, cacheDir)
		if (ret !== 0) return ret
	}

	// Compile embedded native C sources (libuv wrappers) from source tree
	const embeddedNativeObjs = []
	const embeddedNativeSrcs = [
		"libuv/qn-vm.c", "libuv/qn-worker.c", "libuv/qn-uv-utils.c",
		"libuv/qn-uv-fs.c", "libuv/qn-uv-stream.c", "libuv/qn-uv-dgram.c",
		"libuv/qn-uv-process.c", "libuv/qn-uv-dns.c", "libuv/qn-uv-signals.c",
		"libuv/qn-uv-pty.c", "libuv/qn-uv-fs-event.c", "libuv/qn-zlib.c",
	]
	const uvIncDir = srcDir + "/vendor/libuv/include"
	const minizIncDir = srcDir + "/vendor/miniz"
	const minizShimIncDir = srcDir + "/vendor/miniz_shim"
	for (let i = 0; i < embeddedNativeSrcs.length; i++) {
		const src = srcDir + "/" + embeddedNativeSrcs[i]
		if (!fileExists(src)) continue
		let objPath
		if (cacheDir) {
			const targetDir = cacheDir + "/native"
			ensureDir(targetDir)
			objPath = targetDir + "/" + basename(src).replace(/\.c$/, ".o")
			if (getMtime(objPath) >= getMtime(src)) {
				if (verbose) print(`qnc: cached ${objPath}`)
				embeddedNativeObjs.push(objPath)
				continue
			}
		} else {
			objPath = `/tmp/qnc_native_${os.getpid()}_${i}.o`
		}
		const ret = execCmd([cc, "-O2", "-D_GNU_SOURCE",
			"-I", incDir, "-I", uvIncDir, "-I", srcDir,
			"-I", minizIncDir, "-I", minizShimIncDir,
			"-c", "-o", objPath, src], verbose, `cc ${basename(src)}`)
		if (ret !== 0) {
			std.err.puts(`qnc: failed to compile '${src}'\n`)
			return ret
		}
		embeddedNativeObjs.push(objPath)
	}

	// Compile miniz (DEFLATE/zlib) — used by qn-zlib.c. Skip miniz_zip.c
	// (we don't expose archive APIs; node:zlib only needs deflate/inflate).
	const minizObjs = []
	const minizSrcs = ["miniz.c", "miniz_tinfl.c", "miniz_tdef.c"]
	for (let i = 0; i < minizSrcs.length; i++) {
		const src = `${minizIncDir}/${minizSrcs[i]}`
		if (!fileExists(src)) continue
		let objPath
		if (cacheDir) {
			const targetDir = cacheDir + "/miniz"
			ensureDir(targetDir)
			objPath = targetDir + "/" + minizSrcs[i].replace(/\.c$/, ".o")
			if (getMtime(objPath) >= getMtime(src)) {
				if (verbose) print(`qnc: cached ${objPath}`)
				minizObjs.push(objPath)
				continue
			}
		} else {
			objPath = `/tmp/qnc_miniz_${os.getpid()}_${i}.o`
		}
		const ret = execCmd([cc, "-O2",
			"-DMINIZ_NO_ARCHIVE_APIS", "-DMINIZ_NO_STDIO",
			"-I", minizIncDir, "-I", minizShimIncDir,
			"-c", "-o", objPath, src], verbose, `cc ${basename(src)}`)
		if (ret !== 0) {
			std.err.puts(`qnc: failed to compile miniz source '${src}'\n`)
			return ret
		}
		minizObjs.push(objPath)
	}

	// Compile QuickJS core sources
	const quickjsObjs = []
	const qjsSrcDir = extractedMode ? srcDir + "/quickjs" : srcDir + "/bin/" + platform + "/quickjs"
	const quickjsSrcs = [
		{ src: `${qjsSrcDir}/quickjs.c`, name: "quickjs" },
		{ src: `${qjsSrcDir}/libregexp.c`, name: "libregexp" },
		{ src: `${qjsSrcDir}/libunicode.c`, name: "libunicode" },
		{ src: `${qjsSrcDir}/cutils.c`, name: "cutils" },
		{ src: `${qjsSrcDir}/dtoa.c`, name: "dtoa" },
		// repl.c is NOT included — repl bytecode comes from the generated C file
		{ src: extractedMode ? `${srcDir}/quickjs/quickjs-libc.c` : `${srcDir}/bin/${platform}/obj/quickjs-libc.c`, name: "quickjs-libc" },
	]
	for (const qsrc of quickjsSrcs) {
		if (!fileExists(qsrc.src)) continue
		let objPath
		if (cacheDir) {
			const targetDir = cacheDir + "/quickjs"
			ensureDir(targetDir)
			objPath = targetDir + "/" + qsrc.name + ".o"
			if (getMtime(objPath) >= getMtime(qsrc.src)) {
				if (verbose) print(`qnc: cached ${objPath}`)
				quickjsObjs.push(objPath)
				continue
			}
		} else {
			objPath = `/tmp/qnc_qjs_${os.getpid()}_${qsrc.name}.o`
		}
		const ret = execCmd([cc, "-O2", "-D_GNU_SOURCE", "-DCONFIG_BIGNUM",
			'-DCONFIG_VERSION="2024-01-13"', "-DUSE_SANDBOX",
			"-fwrapv", "-Wno-array-bounds",
			"-I", incDir, "-I", qjsSrcDir,
			"-I", uvIncDir, "-I", srcDir,
			"-c", "-o", objPath, qsrc.src], verbose, `cc ${basename(qsrc.src)}`)
		if (ret !== 0) {
			std.err.puts(`qnc: failed to compile '${qsrc.src}'\n`)
			return ret
		}
		quickjsObjs.push(objPath)
	}

	// Compile other C modules (sandboxed-worker, introspect)
	const miscSrcs = [
		{ src: "sandboxed-worker/sandboxed-worker.c", name: "sandboxed-worker" },
		{ src: "introspect/introspect.c", name: "introspect" },
	]
	const miscObjs = []
	for (const msrc of miscSrcs) {
		const fullSrc = srcDir + "/" + msrc.src
		if (!fileExists(fullSrc)) continue
		let objPath
		if (cacheDir) {
			const targetDir = cacheDir + "/misc"
			ensureDir(targetDir)
			objPath = targetDir + "/" + msrc.name + ".o"
			if (getMtime(objPath) >= getMtime(fullSrc)) {
				if (verbose) print(`qnc: cached ${objPath}`)
				miscObjs.push(objPath)
				continue
			}
		} else {
			objPath = `/tmp/qnc_misc_${os.getpid()}_${msrc.name}.o`
		}
		const ret = execCmd([cc, "-O2", "-D_GNU_SOURCE", "-DUSE_SANDBOX",
			"-I", incDir, "-I", qjsSrcDir, "-I", srcDir,
			"-c", "-o", objPath, fullSrc], verbose, `cc ${basename(fullSrc)}`)
		if (ret !== 0) {
			std.err.puts(`qnc: failed to compile '${fullSrc}'\n`)
			return ret
		}
		miscObjs.push(objPath)
	}

	// Compile libuv from source
	const libuvObjs = []
	const LIBUV_SRCS_COMMON = [
		"src/fs-poll.c", "src/idna.c", "src/inet.c", "src/random.c",
		"src/strscpy.c", "src/strtok.c", "src/thread-common.c",
		"src/threadpool.c", "src/timer.c", "src/uv-common.c",
		"src/uv-data-getter-setters.c", "src/version.c",
		"src/unix/async.c", "src/unix/core.c", "src/unix/dl.c",
		"src/unix/fs.c", "src/unix/getaddrinfo.c", "src/unix/getnameinfo.c",
		"src/unix/loop.c", "src/unix/loop-watcher.c", "src/unix/pipe.c",
		"src/unix/poll.c", "src/unix/process.c", "src/unix/proctitle.c",
		"src/unix/random-devurandom.c", "src/unix/signal.c",
		"src/unix/stream.c", "src/unix/tcp.c", "src/unix/thread.c",
		"src/unix/tty.c", "src/unix/udp.c",
	]
	const LIBUV_SRCS_LINUX = [
		"src/unix/linux.c", "src/unix/procfs-exepath.c",
		"src/unix/random-getrandom.c", "src/unix/random-sysctl-linux.c",
	]
	const LIBUV_SRCS_DARWIN = [
		"src/unix/bsd-ifaddrs.c", "src/unix/kqueue.c",
		"src/unix/random-getentropy.c",
		"src/unix/darwin-proctitle.c", "src/unix/darwin.c",
		"src/unix/fsevents.c",
	]

	const libuvSrcs = [...LIBUV_SRCS_COMMON,
		...(platform === "darwin" ? LIBUV_SRCS_DARWIN : LIBUV_SRCS_LINUX)]
	const libuvCflags = platform === "darwin"
		? ["-D_DARWIN_UNLIMITED_SELECT=1", "-D_DARWIN_USE_64_BIT_INODE=1"]
		: []

	for (let i = 0; i < libuvSrcs.length; i++) {
		const src = `${srcDir}/vendor/libuv/${libuvSrcs[i]}`
		if (!fileExists(src)) continue
		const oname = libuvSrcs[i].replace(/\//g, "_").replace(/\.c$/, ".o")
		let objPath
		if (cacheDir) {
			const targetDir = cacheDir + "/libuv"
			ensureDir(targetDir)
			objPath = targetDir + "/" + oname
			if (getMtime(objPath) >= getMtime(src)) {
				if (verbose) print(`qnc: cached ${objPath}`)
				libuvObjs.push(objPath)
				continue
			}
		} else {
			objPath = `/tmp/qnc_uv_${os.getpid()}_${i}.o`
		}
		const ret = execCmd([cc, "-O2", "-D_GNU_SOURCE",
			"-I", uvIncDir, `-I${srcDir}/vendor/libuv/src`,
			...libuvCflags,
			"-c", "-o", objPath, src], verbose, `cc ${basename(src)}`)
		if (ret !== 0) {
			std.err.puts(`qnc: failed to compile libuv source '${src}'\n`)
			return ret
		}
		libuvObjs.push(objPath)
	}

	// Build final link command
	const argv = [cc, "-O2", "-D_GNU_SOURCE", "-I", incDir,
		"-o", outFile, "-rdynamic", cfile]

	// All object files
	for (const obj of embeddedNativeObjs) argv.push(obj)
	for (const obj of quickjsObjs) argv.push(obj)
	for (const obj of miscObjs) argv.push(obj)
	for (const obj of libuvObjs) argv.push(obj)
	for (const obj of minizObjs) argv.push(obj)

	// Native module .o files (from package.json qnc field)
	for (const nm of nativeModules) {
		for (const obj of nm.objFiles) argv.push(obj)
	}

	// Extra link files (--link)
	for (const f of extraLinkFiles) argv.push(f)

	// Native module ldflags
	for (const nm of nativeModules) {
		if (nm.ldflags) for (const f of nm.ldflags) argv.push(f)
	}

	// System libraries
	argv.push("-lm", "-ldl", "-lpthread")
	if (platform !== "darwin") argv.push("-lrt")

	return execCmd(argv, verbose, `ld ${basename(outFile)}`)
}

function compileNativeModule(nm, incDir, cc, verbose, cacheDir) {
	for (let si = 0; si < nm.sources.length; si++) {
		const src = nm.sources[si]
		let objPath
		if (cacheDir) {
			const targetDir = cacheDir + "/" + nm.targetName
			ensureDir(targetDir)
			const srcBase = basename(src).replace(/\.c$/, ".o")
			objPath = targetDir + "/" + srcBase

			// Check cache
			if (getMtime(objPath) >= getMtime(src) &&
				(!nm.pkgJsonPath || getMtime(objPath) >= getMtime(nm.pkgJsonPath))) {
				if (verbose) print(`qnc: cached ${objPath}`)
				nm.objFiles.push(objPath)
				continue
			}
		} else {
			objPath = `/tmp/qnc_${nm.targetName}_${si}.o`
		}

		const argv = [cc, "-O2", "-D_GNU_SOURCE", "-I", incDir,
			`-Djs_init_module=${nm.initName}`]
		for (const inc of nm.includeDirs) { argv.push("-I", inc) }
		for (const def of nm.defines) { argv.push(`-D${def}`) }
		for (const flag of nm.cflags) { argv.push(flag) }
		argv.push("-c", "-o", objPath, src)

		const ret = execCmd(argv, verbose, `cc ${basename(src)}`)
		if (ret !== 0) {
			std.err.puts(`qnc: failed to compile native module source '${src}'\n`)
			return ret
		}
		nm.objFiles.push(objPath)
	}
	// Add pre-built objects
	for (const obj of nm.objects) nm.objFiles.push(obj)
	return 0
}

/* ---- CLI ---- */

function parseArgs() {
	const args = scriptArgs.slice(1)  // skip script name
	const opts = {
		inputFiles: [],
		outputFile: null,
		outputType: "executable",  // "c" | "c_main" | "executable"
		cname: null,
		module: -1,  // -1 = autodetect
		dynamicModules: [],
		cModules: [
			{ name: "std", cname: "std" },
			{ name: "os", cname: "os" },
		],
		extraLinkFiles: [],
		stripFlags: 1,  // JS_STRIP_SOURCE
		byteSwap: false,
		verbose: 0,
		featureBitmap: -1n,  // FE_ALL = all bits set
		stackSize: 0,
		noDefaultModules: false,
		cacheDir: null,
		prefix: "qjsc_",
		cc: std.getenv("CC") || "gcc",
	}

	let i = 0
	while (i < args.length && args[i].startsWith("-")) {
		const arg = args[i]
		if (arg === "-") break
		if (arg === "--") { i++; break }

		if (arg === "-h" || arg === "--help") { printHelp(); std.exit(0) }
		if (arg === "-o") { opts.outputFile = args[++i]; i++; continue }
		if (arg === "-c") { opts.outputType = "c"; i++; continue }
		if (arg === "-e") { opts.outputType = "c_main"; i++; continue }
		if (arg === "-m") { opts.module = 1; i++; continue }
		if (arg === "-x") { opts.byteSwap = true; i++; continue }
		if (arg === "-v") { opts.verbose++; i++; continue }
		if (arg === "-s") { opts.stripFlags = 2; i++; continue } // JS_STRIP_DEBUG
		if (arg === "--keep-source") { opts.stripFlags = 0; i++; continue }
		if (arg === "-N") { opts.cname = args[++i]; i++; continue }
		if (arg === "-p") { opts.prefix = args[++i]; i++; continue }
		if (arg === "-S") { opts.stackSize = parseSuffixedSize(args[++i]); i++; continue }
		if (arg === "-D") { opts.dynamicModules.push(args[++i]); i++; continue }
		if (arg === "-M") {
			const spec = args[++i]
			const comma = spec.indexOf(",")
			if (comma >= 0) {
				opts.cModules.push({ name: spec.slice(0, comma), cname: spec.slice(comma + 1) })
			} else {
				const cname = spec.replace(/[^a-zA-Z0-9]/g, "_")
				opts.cModules.push({ name: spec, cname })
			}
			i++; continue
		}
		if (arg === "--link") { opts.extraLinkFiles.push(args[++i]); i++; continue }
		if (arg === "--cache-dir") { opts.cacheDir = args[++i]; i++; continue }
		if (arg === "--no-default-modules") { opts.noDefaultModules = true; i++; continue }
		if (arg.startsWith("-f")) {
			const flag = arg.slice(2)
			if (flag === "lto") { /* ignored for now */ }
			i++; continue
		}
		std.err.puts(`qnc: unknown option '${arg}'\n`)
		std.exit(1)
	}

	// Remaining args are input files
	while (i < args.length) opts.inputFiles.push(args[i++])

	if (opts.inputFiles.length === 0) { printHelp(); std.exit(1) }

	// Add default modules
	if (!opts.noDefaultModules) {
		for (const m of DEFAULT_MODULES) {
			if (!opts.dynamicModules.includes(m))
				opts.dynamicModules.push(m)
		}
	}

	// Default output filename
	if (!opts.outputFile) {
		opts.outputFile = opts.outputType === "executable" ? "a.out" : "out.c"
	}

	return opts
}

function parseSuffixedSize(str) {
	let v = parseInt(str)
	const suffix = str.slice(String(v).length)
	if (suffix === "G") v <<= 30
	else if (suffix === "M") v <<= 20
	else if (suffix === "K" || suffix === "k") v <<= 10
	return v
}

function printHelp() {
	print(`QuickJS Compiler (JS)
usage: qnc [options] [files]

options:
-c          only output bytecode to a C file
-e          output main() and bytecode to a C file
-o output   set the output filename
-N cname    set the C name of the generated data
-m          compile as Javascript module (default=autodetect)
-D name     compile a dynamically loaded module
-M name[,cname] add initialization code for an external C module
-x          byte swapped output
-p prefix   set the prefix of the generated C names
-S n        set the maximum stack size (supports K/M/G suffixes)
-s          strip all debug info
--keep-source keep the source code
--link file   pass file (.o/.a) to the linker
--cache-dir d cache compiled .o files in directory d
--no-default-modules  don't include default modules`)
}

/* ---- Package subcommand ---- */

function buildNativePackage(pkgDir, outFilename, verbose, cc) {
	const resolved = realpath(pkgDir)
	if (!resolved) {
		std.err.puts(`qnc package: cannot resolve path '${pkgDir}': No such file or directory\n`)
		return 1
	}

	const nm = parseNativePackage(resolved, null)
	if (!nm) {
		std.err.puts(`qnc package: no "qnc" field in ${resolved}/package.json\n`)
		return 1
	}

	if (nm.sources.length === 0 && nm.objects.length === 0) {
		std.err.puts(`qnc package: no sources or objects found for target '${nm.targetName}'\n`)
		return 1
	}

	// Find QuickJS headers for -I
	const platform = os.platform || "linux"
	let incDir
	if (extractedMode) {
		incDir = scriptDir
	} else {
		const binDir = `${repoRoot}/bin/${platform}`
		if (fileExists(`${binDir}/quickjs.h`)) {
			incDir = binDir
		} else {
			std.err.puts("qnc package: cannot find support files (quickjs.h)\n")
			return 1
		}
	}

	// Determine output filename
	const soPath = outFilename || `${resolved}/${nm.targetName}.so`

	// Compile sources with -fPIC (no init_name renaming for package builds)
	const objFiles = []
	const tempObjs = []

	// Pre-built objects
	for (const obj of nm.objects) objFiles.push(obj)

	// Compile each source
	for (let si = 0; si < nm.sources.length; si++) {
		const src = nm.sources[si]
		const objPath = `/tmp/qnc_pkg_${nm.targetName}_${si}.o`

		const argv = [cc, "-O2", "-fPIC", "-D_GNU_SOURCE", "-I", incDir]
		for (const inc of nm.includeDirs) { argv.push("-I", inc) }
		for (const def of nm.defines) { argv.push(`-D${def}`) }
		for (const flag of nm.cflags) { argv.push(flag) }
		argv.push("-c", "-o", objPath, src)

		const ret = execCmd(argv, verbose, `cc ${basename(src)}`)
		if (ret !== 0) {
			std.err.puts(`qnc package: failed to compile '${src}'\n`)
			for (const t of tempObjs) os.remove(t)
			return ret
		}
		objFiles.push(objPath)
		tempObjs.push(objPath)
	}

	// Link into shared library
	const linkArgv = [cc, "-shared"]
	if (platform === "darwin") {
		linkArgv.push("-undefined", "dynamic_lookup")
	}
	linkArgv.push("-o", soPath)
	for (const obj of objFiles) linkArgv.push(obj)
	for (const ldf of nm.ldflags) linkArgv.push(ldf)
	linkArgv.push("-lm")

	const linkRet = execCmd(linkArgv, verbose, `ld ${basename(soPath)}`)

	// Clean up temp .o files
	for (const t of tempObjs) os.remove(t)

	if (linkRet !== 0) {
		std.err.puts("qnc package: linking failed\n")
		return linkRet
	}

	print(soPath)
	return 0
}

function runPackageSubcommand() {
	const args = scriptArgs.slice(2)  // skip script name and "package"
	let outFile = null
	let verbose = false
	let pkgDir = "."
	const cc = std.getenv("CC") || "gcc"
	let i = 0

	while (i < args.length && args[i].startsWith("-")) {
		if (args[i] === "-o" && i + 1 < args.length) {
			outFile = args[++i]
		} else if (args[i] === "-v") {
			verbose = true
		} else if (args[i] === "-h" || args[i] === "--help") {
			print(`usage: qnc package [-o output.so] [-v] [directory]

Build a native module .so from a directory containing
a package.json with a "qnc" field.

options:
  -o output   set the output filename (default: <dir>/<target_name>.so)
  -v          verbose (show compiler commands)
  directory   package directory (default: current directory)`)
			std.exit(0)
		} else {
			std.err.puts(`qnc package: unknown option '${args[i]}'\n`)
			std.exit(1)
		}
		i++
	}
	if (i < args.length) pkgDir = args[i]

	std.exit(buildNativePackage(pkgDir, outFile, verbose, cc))
}

/* ---- Main ---- */

// Handle "qnc package" subcommand before normal arg parsing
if (scriptArgs.length >= 2 && scriptArgs[1] === "package") {
	runPackageSubcommand()
}

// Try to load Sucrase for TypeScript support
try {
	const sucrase = await loadSucrase()
	if (sucrase) {
		sucraseTransform = sucrase.transform
		sucraseParse = sucrase.parse
	}
} catch (e) {
	// TS support not available, that's OK
}

// Set version info environment variables for synthetic module
const gitCommit = std.getenv("QNC_GIT_COMMIT")
const gitDirty = std.getenv("QNC_GIT_DIRTY")
const buildTime = std.getenv("QNC_BUILD_TIME")

const opts = parseArgs()
compileProject(opts)
