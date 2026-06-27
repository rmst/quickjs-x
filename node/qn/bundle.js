/**
 * qn:bundle — minimal bundler
 *
 * Traces static imports + literal dynamic imports from entry points,
 * transforms each file with Sucrase (typescript + jsx + imports),
 * concatenates reachable modules into a single file wrapped in a tiny
 * CJS-style runtime, and emits side-effect CSS imports as sibling assets.
 * Signature loosely mirrors `Bun.build()`.
 *
 * Non-features: tree shaking, minification, source maps, code splitting,
 * top-level await (module wrappers are sync).
 */

import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs"
import { dirname, join, resolve, extname, basename, isAbsolute } from "node:path"
import { transform, parse } from "qn:sucrase"
import { createTsconfigPathsResolver, nodeEnv } from "./tsconfig-paths.js"

const CODE_EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json"]
const STYLE_EXTS = [".css"]
const PROBE_EXTS = [...CODE_EXTS, ...STYLE_EXTS]
const FORMATS = ["esm", "iife"]
const TARGETS = ["browser", "node"]

// Sucrase token type constants we care about (from
// vendor/sucrase-js/sucrase/src/parser/tokenizer/types.js). Hard-coded rather
// than imported to keep the bundler's dependency surface narrow.
const TT = {
	string: 4608, name: 5632, eof: 6144, parenL: 13824, parenR: 14336,
	comma: 15360, semi: 16384, dot: 19456, eq: 29728, star: 52235,
	_default: 67600, _export: 89104, _import: 90640, _as: 112144,
}
const CK_FROM = 13 // ContextualKeyword._from
const CK_AS = 3
// IdentifierRole.Access — used for read-references; declarations and import/
// export specifier names use other values, which we deliberately skip when
// applying --define.
const IR_ACCESS = 0

const IMPORT_META_RE = /\bimport\.meta\.(url|dirname|filename)\b/g

// Match `@jsxImportSource <name>` inside a block comment near the top of file.
// Matches what Bun, esbuild, and tsc accept.
const JSX_IMPORT_SOURCE_RE = /\/\*[^]*?@jsxImportSource\s+(\S+)[^]*?\*\//

function detectJsxImportSource(source) {
	const head = source.slice(0, 1024)
	const m = JSX_IMPORT_SOURCE_RE.exec(head)
	return m ? m[1] : null
}

/* ------------------------------------------------------------------ *
 * Filesystem helpers                                                  *
 * ------------------------------------------------------------------ */

function statOr(p) {
	try { return statSync(p) } catch { return null }
}

function isFile(p) {
	const st = statOr(p)
	return st != null && st.isFile()
}

function isStyleFile(p) {
	return STYLE_EXTS.includes(extname(p))
}

function readJson(p) {
	try { return JSON.parse(readFileSync(p, "utf8")) } catch { return null }
}

/* ------------------------------------------------------------------ *
 * Module resolution                                                   *
 * ------------------------------------------------------------------ */

function probe(base) {
	const st = statOr(base)
	if (st && st.isFile()) return base
	for (const ext of PROBE_EXTS) {
		if (isFile(base + ext)) return base + ext
	}
	if (st && st.isDirectory()) {
		const pkg = readJson(join(base, "package.json"))
		if (pkg) {
			const sub = pickPackageEntry(pkg, ".", base, ["browser", "import", "default"])
			if (sub) return sub
		}
		for (const ext of PROBE_EXTS) {
			const idx = join(base, "index" + ext)
			if (isFile(idx)) return idx
		}
	}
	return null
}

function resolvePackageExports(exports, subpath, pkgDir, conditions) {
	const target = matchExports(exports, subpath, conditions)
	if (!target || !target.startsWith("./")) return null
	return probe(join(pkgDir, target))
}

function matchExports(exports, subpath, conditions) {
	if (typeof exports === "string") return subpath === "." ? exports : null
	if (Array.isArray(exports)) {
		for (const e of exports) {
			const r = matchExports(e, subpath, conditions)
			if (r) return r
		}
		return null
	}
	if (typeof exports !== "object" || exports === null) return null

	const keys = Object.keys(exports)
	const hasSubpaths = keys.some(k => k.startsWith("."))

	if (hasSubpaths) {
		if (exports[subpath]) return resolveConditional(exports[subpath], conditions)
		for (const key of keys) {
			if (!key.includes("*")) continue
			const [pre, post] = key.split("*")
			if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= pre.length + post.length) {
				const stem = subpath.slice(pre.length, subpath.length - post.length)
				const target = resolveConditional(exports[key], conditions)
				return target ? target.replace("*", stem) : null
			}
		}
		return null
	}

	// Bare conditional object at the root is equivalent to the "." entry.
	if (subpath !== ".") return null
	return resolveConditional(exports, conditions)
}

function resolveConditional(target, conditions) {
	if (typeof target === "string") return target
	if (target === null) return null
	if (Array.isArray(target)) {
		for (const t of target) {
			const r = resolveConditional(t, conditions)
			if (r) return r
		}
		return null
	}
	if (typeof target !== "object") return null
	for (const cond of conditions) {
		if (cond in target) {
			const r = resolveConditional(target[cond], conditions)
			if (r) return r
		}
	}
	if ("default" in target) return resolveConditional(target.default, conditions)
	return null
}

function pickPackageEntry(pkg, subpath, pkgDir, conditions) {
	if (pkg.exports) {
		const r = resolvePackageExports(pkg.exports, subpath, pkgDir, conditions)
		if (r) return r
	}
	if (subpath !== ".") return probe(join(pkgDir, subpath))
	if (conditions.includes("browser") && typeof pkg.browser === "string") {
		const r = probe(join(pkgDir, pkg.browser))
		if (r) return r
	}
	for (const field of ["module", "main"]) {
		if (pkg[field]) {
			const r = probe(join(pkgDir, pkg[field]))
			if (r) return r
		}
	}
	return probe(join(pkgDir, "index"))
}

function splitBareSpecifier(spec) {
	if (spec.startsWith("@")) {
		const parts = spec.split("/")
		return { name: parts.slice(0, 2).join("/"), subpath: parts.length > 2 ? "./" + parts.slice(2).join("/") : "." }
	}
	const i = spec.indexOf("/")
	return i < 0 ? { name: spec, subpath: "." } : { name: spec.slice(0, i), subpath: "./" + spec.slice(i + 1) }
}

function resolveBare(specifier, fromDir, conditions) {
	const { name, subpath } = splitBareSpecifier(specifier)
	let cur = fromDir
	for (;;) {
		const pkgDir = join(cur, "node_modules", name)
		const pkg = readJson(join(pkgDir, "package.json"))
		if (pkg) {
			const r = pickPackageEntry(pkg, subpath, pkgDir, conditions)
			if (r) return r
		}
		const parent = dirname(cur)
		if (parent === cur) return null
		cur = parent
	}
}

const tsconfigPaths = createTsconfigPathsResolver({ env: nodeEnv(nodeFs, nodePath), probe })

function resolveSpecifier(specifier, fromDir, conditions) {
	if (specifier.startsWith("./") || specifier.startsWith("../")) return probe(resolve(fromDir, specifier))
	if (isAbsolute(specifier)) return probe(specifier)
	const bare = resolveBare(specifier, fromDir, conditions)
	if (bare) return bare
	return tsconfigPaths.resolve(specifier, fromDir)
}

/* ------------------------------------------------------------------ *
 * Token-based import extraction                                       *
 *                                                                     *
 * Uses Sucrase's own parser to enumerate ESM import/export specifiers *
 * and literal dynamic `import(...)` expressions with exact source     *
 * positions. No regex on source code — zero false positives from      *
 * comments, strings, template literals, or regex literals.            *
 * ------------------------------------------------------------------ */

// Parse a string-literal token body ("..." or '...') to its value.
// Sufficient for import specifiers, which do not contain complex escapes.
function unquoteSpecifier(raw) {
	return raw.slice(1, -1).replace(/\\(.)/g, (_, c) => c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c)
}

// Returns a list of import entries. `start/end` cover the range that should
// be replaced:
//   - static: just the string-literal token (so the replacement becomes a
//     new specifier string, which Sucrase's imports transform then turns
//     into require(newSpec)).
//   - dynamic: the whole `import(...)` expression (replaced with a call
//     into our runtime).
// Side-effect imports also include `statementStart/statementEnd`, which lets
// asset imports be removed from the JS stream instead of becoming require()
// calls.
//
// In files with no ESM import/export syntax, also collects literal
// `require("X")` calls so hand-written CJS modules get the same id rewrite.
// Member access (`obj.require(...)`) and computed forms (`require(name)`)
// are skipped — only top-level static literals are safe to rewrite without
// runtime evaluation. Files with any ESM import/export are treated as ESM
// and their `require()` calls are left alone (esbuild-style format split):
// this preserves the `const require = createRequire(import.meta.url)`
// pattern, where `require` is a user-defined runtime helper, not a
// bundle-time spec.
function extractImports(code, ext) {
	const isJSX = ext === ".jsx" || ext === ".tsx"
	const isTS = ext === ".ts" || ext === ".tsx"
	const tokens = parse(code, isJSX, isTS, false).tokens
	const out = []
	let hasEsm = false
	const sideEffectStatementEnd = (strIdx) => {
		const strTok = tokens[strIdx]
		const next = tokens[strIdx + 1]
		if (!next || next.type === TT.eof) return strTok.end
		if (next.type === TT.semi) return next.end
		const gap = code.slice(strTok.end, next.start)
		if (/[\r\n]/.test(gap)) return strTok.end
		return null
	}
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]

		// Dynamic: `import ( "X" )`
		if (t.type === TT._import && tokens[i + 1]?.type === TT.parenL) {
			const strTok = tokens[i + 2]
			const closeTok = tokens[i + 3]
			if (strTok?.type === TT.string && closeTok?.type === TT.parenR) {
				out.push({
					kind: "dynamic",
					syntax: "dynamic",
					start: t.start,
					end: closeTok.end,
					specifier: unquoteSpecifier(code.slice(strTok.start, strTok.end)),
				})
				i += 3
			}
			hasEsm = true
			continue
		}

		// Static side-effect: `import "X"`
		if (t.type === TT._import && tokens[i + 1]?.type === TT.string) {
			const strTok = tokens[i + 1]
			const statementEnd = sideEffectStatementEnd(i + 1)
			out.push({
				kind: "static",
				syntax: "side-effect",
				start: strTok.start,
				end: strTok.end,
				statementStart: t.start,
				statementEnd,
				specifier: unquoteSpecifier(code.slice(strTok.start, strTok.end)),
			})
			i += 1
			hasEsm = true
			continue
		}

		// Static with from-clause: `import ... from "X"` or `export ... from "X"`
		if (t.type === TT._import || t.type === TT._export) {
			hasEsm = true
			for (let j = i + 1; j < tokens.length; j++) {
				const u = tokens[j]
				if (u.type === TT.semi || u.type === TT.eof) break
				if (u.type === TT._import || u.type === TT._export) break
				if (u.type === TT.name && u.contextualKeyword === CK_FROM) {
					const strTok = tokens[j + 1]
					if (strTok?.type === TT.string) {
						out.push({
							kind: "static",
							syntax: t.type === TT._export ? "export-from" : "import-from",
							start: strTok.start,
							end: strTok.end,
							specifier: unquoteSpecifier(code.slice(strTok.start, strTok.end)),
						})
					}
					break
				}
			}
		}
	}

	if (!hasEsm) {
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i]
			if (t.type === TT.name
				&& tokens[i + 1]?.type === TT.parenL
				&& tokens[i + 2]?.type === TT.string
				&& tokens[i + 3]?.type === TT.parenR
				&& tokens[i - 1]?.type !== TT.dot
				&& code.slice(t.start, t.end) === "require") {
				const strTok = tokens[i + 2]
				out.push({
					kind: "static",
					syntax: "require",
					start: strTok.start,
					end: strTok.end,
					specifier: unquoteSpecifier(code.slice(strTok.start, strTok.end)),
				})
				i += 3
			}
		}
	}

	return out
}

// Replace each {start, end, text} range in `code`, preserving everything else
// verbatim. Ranges may be unordered; overlapping ranges are an error.
function applyRanges(code, ranges) {
	if (ranges.length === 0) return code
	const sorted = ranges.slice().sort((a, b) => a.start - b.start)
	const chunks = []
	let cursor = 0
	for (const r of sorted) {
		if (r.start < cursor) throw new Error(`overlapping rewrite at ${r.start} (prev cursor ${cursor})`)
		chunks.push(code.slice(cursor, r.start), r.text)
		cursor = r.end
	}
	chunks.push(code.slice(cursor))
	return chunks.join("")
}

// Parse `--define` keys into segment arrays, e.g. "process.env.NODE_ENV" →
// ["process", "env", "NODE_ENV"]. Single-identifier keys produce a 1-element
// array. Returns a list paired with the replacement text.
function compileDefines(define) {
	const out = []
	for (const [key, text] of Object.entries(define || {})) {
		const segments = key.split(".")
		if (segments.length === 0 || segments.some(s => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s))) {
			throw new Error(`bundle: invalid --define key ${JSON.stringify(key)} (must be an identifier or dotted identifier path)`)
		}
		out.push({ segments, text })
	}
	// Match longer paths first so e.g. `process.env.NODE_ENV` wins over `process`.
	out.sort((a, b) => b.segments.length - a.segments.length)
	return out
}

// Find positions in `code` where each compiled define key matches a real
// identifier reference (not a property access continuation, not a declaration,
// not an import/export specifier name). Returns {start, end, text} ranges
// suitable for applyRanges.
function extractDefineMatches(code, ext, defines) {
	if (defines.length === 0) return []
	const isJSX = ext === ".jsx" || ext === ".tsx"
	const isTS = ext === ".ts" || ext === ".tsx"
	const tokens = parse(code, isJSX, isTS, false).tokens
	const out = []
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]
		if (t.type !== TT.name || t.identifierRole !== IR_ACCESS) continue
		const head = code.slice(t.start, t.end)
		for (const def of defines) {
			if (def.segments[0] !== head) continue
			let endIdx = i
			let ok = true
			for (let s = 1; s < def.segments.length; s++) {
				const dotTok = tokens[endIdx + 1]
				const nameTok = tokens[endIdx + 2]
				if (!dotTok || dotTok.type !== TT.dot || !nameTok || nameTok.type !== TT.name) { ok = false; break }
				if (code.slice(nameTok.start, nameTok.end) !== def.segments[s]) { ok = false; break }
				endIdx += 2
			}
			if (!ok) continue
			out.push({ start: t.start, end: tokens[endIdx].end, text: def.text })
			i = endIdx
			break
		}
	}
	return out
}

/* ------------------------------------------------------------------ *
 * Entry export enumeration                                            *
 *                                                                     *
 * For `format=esm` we want the bundle to expose real top-level        *
 * `export` declarations so downstream tools (esbuild/Rollup/Vite) can *
 * statically see the entry's exports. The entry itself is still       *
 * closure-wrapped in __qn_modules; after running it we read its       *
 * mod.exports and re-emit the names as ESM exports. Snapshot          *
 * semantics: importers see the values at module-load time, not live   *
 * bindings — fine for compiled npm packages whose exports don't get   *
 * reassigned post-init.                                               *
 * ------------------------------------------------------------------ */

// Parse the entry source to detect unsupported `export *` (without `as`).
// We do this on the *original* source because Sucrase compiles `export *`
// into an opaque runtime helper call that's harder to identify reliably.
function checkUnsupportedStarExport(source, ext, filePath) {
	const isJSX = ext === ".jsx" || ext === ".tsx"
	const isTS = ext === ".ts" || ext === ".tsx"
	const tokens = parse(source, isJSX, isTS, false).tokens
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type !== TT._export) continue
		const a = tokens[i + 1]
		if (!a || a.type !== TT.star) continue
		const b = tokens[i + 2]
		const isAs = b && (b.type === TT._as || (b.type === TT.name && b.contextualKeyword === CK_AS))
		if (!isAs) {
			throw new Error(
				`bundle: \`export *\` is not supported in entry "${filePath}" with format=esm. ` +
				`Use named re-exports (\`export { x } from "..."\`) or \`export * as ns from "..."\`.`)
		}
	}
}

// Walk Sucrase's CJS-shaped output for the entry and collect every name that
// gets attached to `exports`. Catches all the forms ESM allows: declaration
// exports, named exports (with rename), default exports, and re-exports.
// `export *` is rejected upstream by checkUnsupportedStarExport.
function collectEntryExportNames(cjsCode) {
	const tokens = parse(cjsCode, false, false, false).tokens
	const names = new Set()
	let hasDefault = false
	const tokText = (t) => cjsCode.slice(t.start, t.end)
	const recordName = (name) => {
		if (name === "__esModule") return
		if (name === "default") { hasDefault = true; return }
		if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) names.add(name)
	}
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]
		if (t.type === TT.eof) break
		// Pattern: `exports . NAME =` (Sucrase emits this for export decls).
		if (t.type === TT.name && tokText(t) === "exports") {
			const a = tokens[i + 1], b = tokens[i + 2], c = tokens[i + 3]
			if (a && a.type === TT.dot && b && (b.type === TT.name || b.type === TT._default) && c && c.type === TT.eq) {
				recordName(tokText(b))
			}
		}
		// Pattern: `Object . defineProperty ( exports , "NAME"` — re-exports
		// from another module are emitted via Object.defineProperty.
		if (t.type === TT.name && tokText(t) === "Object") {
			const seq = [tokens[i + 1], tokens[i + 2], tokens[i + 3], tokens[i + 4], tokens[i + 5], tokens[i + 6]]
			if (seq.every(Boolean)
				&& seq[0].type === TT.dot
				&& seq[1].type === TT.name && tokText(seq[1]) === "defineProperty"
				&& seq[2].type === TT.parenL
				&& seq[3].type === TT.name && tokText(seq[3]) === "exports"
				&& seq[4].type === TT.comma
				&& seq[5].type === TT.string) {
				const raw = tokText(seq[5])
				recordName(raw.slice(1, -1))
			}
		}
		// Pattern: `_createNamedExportFrom ( <name> , "NAME"` — Sucrase emits
		// this helper for `export { x } from "..."`. The second argument is
		// the local export name on the bundle's `exports` object.
		if (t.type === TT.name && tokText(t) === "_createNamedExportFrom") {
			const seq = [tokens[i + 1], tokens[i + 2], tokens[i + 3], tokens[i + 4]]
			if (seq.every(Boolean)
				&& seq[0].type === TT.parenL
				&& seq[1].type === TT.name
				&& seq[2].type === TT.comma
				&& seq[3].type === TT.string) {
				const raw = tokText(seq[3])
				recordName(raw.slice(1, -1))
			}
		}
	}
	return { names: [...names], hasDefault }
}

/* ------------------------------------------------------------------ *
 * Per-module load + transform                                         *
 * ------------------------------------------------------------------ */

// Substitute `import.meta.url/dirname/filename` with bundle-time constants.
// Module wrappers are plain functions — `import.meta` would be invalid there.
// Runs on already-transformed output, where `import.meta` only appears inside
// expression positions Sucrase has preserved verbatim.
function substituteImportMeta(code, filePath) {
	if (!code.includes("import.meta")) return code
	return code.replace(IMPORT_META_RE, (_full, field) => {
		if (field === "url") return JSON.stringify("file://" + filePath)
		if (field === "dirname") return JSON.stringify(dirname(filePath))
		return JSON.stringify(filePath)
	})
}

// Surface TLA as a clear build-time error rather than a cryptic runtime
// syntax error inside the generated bundle.
function checkModuleSyntax(code, filePath) {
	if (!/\bawait\b/.test(code)) return
	try {
		new Function("exports", "require", "module", code)
	} catch (e) {
		throw new Error(`top-level await is not supported by qn bundle (in ${filePath}): ${e.message}`)
	}
}

// Load a source file, enumerate its imports, and return both the raw text
// and the import list. CJS files also get the import scan so literal
// `require("…")` calls are rewritten to bundle-internal ids.
function loadAndAnalyse(filePath) {
	const source = readFileSync(filePath, "utf8")
	const ext = extname(filePath)
	if (isStyleFile(filePath)) return { kind: "css", source, ext, imports: [] }
	if (ext === ".json") return { kind: "json", source, ext, imports: [] }
	let imports
	try {
		imports = extractImports(source, ext)
	} catch (e) {
		throw new Error(`failed to parse ${filePath}: ${e.message}`)
	}
	const kind = ext === ".cjs" ? "cjs" : "esm"
	return { kind, source, ext, imports }
}

// Run Sucrase on the specifier-rewritten source. Sucrase's "imports"
// transform then emits `require('<modId>')` for each static import and any
// JSX-runtime auto-injected import.
function runTransform(source, ext, opts) {
	const transforms = ["imports"]
	if (ext === ".ts" || ext === ".tsx") transforms.push("typescript")
	if (ext === ".tsx" || ext === ".jsx") transforms.push("jsx")
	return transform(source, {
		transforms,
		jsxRuntime: opts.jsxRuntime,
		jsxImportSource: opts.jsxImportSource,
		production: opts.production,
		filePath: opts.filePath,
	}).code
}

/* ------------------------------------------------------------------ *
 * Bundle pipeline                                                     *
 * ------------------------------------------------------------------ */

function makeConditions(target, production) {
	const base = ["module", "import", "default"]
	const envCond = target === "browser" ? ["browser"] : ["node"]
	const modeCond = production ? ["production"] : ["development"]
	return [...envCond, ...modeCond, ...base]
}

function bundleEntry(entry, opts) {
	const conditions = makeConditions(opts.target, opts.production)
	const entryAbs = resolve(entry)
	if (!isFile(entryAbs)) throw new Error(`entry point not found: ${entry}`)
	if (isStyleFile(entryAbs)) {
		throw new Error(`bundle: CSS entry points are not supported (${entry}); import CSS from a JavaScript or TypeScript entry point`)
	}

	const ids = new Map()
	const modules = new Map()
	const visiting = new Set()
	const cssAssets = []
	const seenCssAssets = new Set()
	const declaredExternals = new Set(opts.external)
	const aliasMap = new Map(Object.entries(opts.alias || {}))
	const compiledDefines = compileDefines(opts.define)
	const usedExternals = new Set()
	const warnings = []
	let counter = 0
	const assignId = p => {
		if (ids.has(p)) return ids.get(p)
		const id = "m" + counter++
		ids.set(p, id)
		return id
	}

	assignId(entryAbs)
	let entryExports = null

	const collectCssAsset = (filePath) => {
		if (seenCssAssets.has(filePath)) return
		seenCssAssets.add(filePath)
		cssAssets.push({ filePath, text: readFileSync(filePath, "utf8") })
	}

	// Only used for the JSX-runtime import that Sucrase auto-injects during
	// transform (it isn't part of the original source tokens we parsed).
	const jsxRuntimeSpec = (ext, importSource) => {
		if (ext !== ".tsx" && ext !== ".jsx") return null
		if (opts.jsxRuntime !== "automatic") return null
		return `${importSource}/${opts.production ? "jsx-runtime" : "jsx-dev-runtime"}`
	}

	visit(entryAbs)

	return { entrypoint: entryAbs, entryId: ids.get(entryAbs), modules, warnings, externals: usedExternals, entryExports, cssAssets }

	function visit(filePath) {
		const id = ids.get(filePath) || assignId(filePath)
		if (modules.has(id) || visiting.has(filePath)) return
		visiting.add(filePath)
		const { kind, source, ext, imports } = loadAndAnalyse(filePath)
		const fromDir = dirname(filePath)

		// Build a flat list of source-range rewrites: import specifiers + any
		// `--define` matches in the same file.
		const ranges = []
		for (const imp of imports) {
			const dep = resolveDep(imp.specifier, filePath, fromDir)
			if (dep === null) continue
			if (dep.kind === "css") {
				ranges.push(cssImportRemovalRange(imp, filePath))
				collectCssAsset(dep.filePath)
				continue
			}
			// External whose resolved spec equals the source spec: leave alone
			// so Sucrase emits `require("<spec>")` which falls through to
			// __qn_externals at runtime. Aliased externals fall through here
			// because dep.spec !== imp.specifier.
			if (dep.kind === "external" && dep.spec === imp.specifier) continue
			const newSpec = dep.kind === "internal" ? dep.id : dep.spec
			const text = imp.kind === "static"
				? JSON.stringify(newSpec)
				: `Promise.resolve(require(${JSON.stringify(newSpec)}))`
			ranges.push({ start: imp.start, end: imp.end, text })
			if (dep.kind === "internal") visit(dep.filePath)
		}
		if (kind !== "json" && compiledDefines.length > 0) {
			for (const m of extractDefineMatches(source, ext, compiledDefines)) ranges.push(m)
		}

		// Pre-rewrite source specifiers to our module ids.
		let rewritten
		if (kind === "json") {
			rewritten = `module.exports = ${source};`
		} else if (kind === "cjs") {
			rewritten = applyRanges(source, ranges)
		} else {
			const preRewritten = applyRanges(source, ranges)
			// Per-file `@jsxImportSource` pragma overrides the bundle default.
			const pragmaSource = (ext === ".tsx" || ext === ".jsx") ? detectJsxImportSource(source) : null
			const fileJsxImportSource = pragmaSource || opts.jsxImportSource
			rewritten = runTransform(preRewritten, ext, { ...opts, jsxImportSource: fileJsxImportSource, filePath })

			// Sucrase auto-injects the JSX runtime import during transform, so
			// its specifier never appeared in the source we parsed. Resolve it
			// separately and patch the emitted require() call.
			const runtime = jsxRuntimeSpec(ext, fileJsxImportSource)
			if (runtime && rewritten.includes(runtime)) {
				const dep = resolveDep(runtime, filePath, fromDir)
				if (dep !== null) {
					if (dep.kind === "css") throw new Error(`bundle: JSX runtime "${runtime}" resolved to a CSS asset`)
					if (dep.kind === "internal") visit(dep.filePath)
					const target = dep.kind === "internal" ? dep.id : dep.spec
					if (target !== runtime) {
						const pat = new RegExp(`require\\((['"])${runtime.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\1\\)`, "g")
						rewritten = rewritten.replace(pat, `require(${JSON.stringify(target)})`)
					}
				}
			}

			rewritten = substituteImportMeta(rewritten, filePath)
		}

		checkModuleSyntax(rewritten, filePath)
		modules.set(id, { filePath, code: rewritten })

		// For format=esm, scan the entry's transformed body for the names it
		// attaches to mod.exports — those become real top-level ESM exports
		// of the bundle so downstream tools can ingest it as a library.
		if (filePath === entryAbs && opts.format === "esm" && kind === "esm") {
			checkUnsupportedStarExport(source, ext, filePath)
			entryExports = collectEntryExportNames(rewritten)
		}
		visiting.delete(filePath)
	}

	// Returns null for unresolved specs, {kind: "internal", id} for bundled
	// modules, {kind: "css", filePath} for stylesheet assets, or
	// {kind: "external", spec} for externals. The spec returned for externals
	// is post-alias, which lets the caller distinguish aliased externals
	// (where the source spec must be rewritten) from plain externals (where
	// the source can be left alone).
	function resolveDep(spec, filePath, fromDir) {
		if (aliasMap.has(spec)) spec = aliasMap.get(spec)
		if (declaredExternals.has(spec)) {
			usedExternals.add(spec)
			return { kind: "external", spec }
		}
		if (spec.startsWith("node:")) {
			if (opts.target === "node") {
				usedExternals.add(spec)
				return { kind: "external", spec }
			}
			throw new Error(
				`cannot bundle "${spec}" (from ${filePath}): node builtins are not available ` +
				`in the "browser" target. Use --target=node, or --external=${spec} to leave it as a runtime require.`)
		}
		const resolved = resolveSpecifier(spec, fromDir, conditions)
		if (!resolved) {
			if (isStyleFile(spec)) throw new Error(`bundle: CSS import "${spec}" from ${filePath} could not be resolved`)
			warnings.push(`unresolved import "${spec}" from ${filePath}`)
			return null
		}
		if (isStyleFile(resolved)) return { kind: "css", filePath: resolved }
		const depId = assignId(resolved)
		return { kind: "internal", id: depId, filePath: resolved }
	}

	function cssImportRemovalRange(imp, filePath) {
		if (imp.syntax === "dynamic") {
			throw new Error(`bundle: dynamic CSS import "${imp.specifier}" from ${filePath} is not supported`)
		}
		if (imp.syntax !== "side-effect") {
			throw new Error(`bundle: CSS import "${imp.specifier}" from ${filePath} must be a side-effect import`)
		}
		if (imp.statementEnd == null) {
			throw new Error(`bundle: CSS import attributes are not supported in ${filePath}`)
		}
		return { start: imp.statementStart, end: imp.statementEnd, text: "" }
	}
}

function emitBundle({ entryId, modules, externals, format, entryExports }) {
	const chunks = []
	const hasExternals = externals.size > 0
	const canUseEsmImports = format === "esm"

	if (hasExternals && canUseEsmImports) {
		const entries = []
		let i = 0
		for (const spec of externals) {
			const local = `__qn_ext_${i++}`
			chunks.push(`import * as ${local} from ${JSON.stringify(spec)};\n`)
			entries.push(`\t${JSON.stringify(spec)}: ${local}`)
		}
		chunks.push(`var __qn_externals = {\n${entries.join(",\n")}\n};\n`)
	}

	chunks.push(`// Generated by qn bundle\n`)
	chunks.push(`var __qn_modules = {};\n`)
	chunks.push(`var __qn_cache = {};\n`)
	chunks.push(`function __qn_require(id) {\n`)
	chunks.push(`\tif (id in __qn_cache) return __qn_cache[id].exports;\n`)
	chunks.push(`\tvar fn = __qn_modules[id];\n`)
	if (hasExternals && canUseEsmImports) {
		// `import * as` yields a Module Namespace with a .default property
		// if the source module had one; plain CJS default handling below is
		// what Sucrase's require() callers expect.
		chunks.push(`\tif (!fn) {\n`)
		chunks.push(`\t\tvar ext = __qn_externals[id];\n`)
		chunks.push(`\t\tif (ext) return ext;\n`)
		chunks.push(`\t\tthrow new Error("qn bundle: module not found: " + id);\n`)
		chunks.push(`\t}\n`)
	} else {
		chunks.push(`\tif (!fn) throw new Error("qn bundle: module not found: " + id);\n`)
	}
	chunks.push(`\tvar mod = __qn_cache[id] = { exports: {} };\n`)
	chunks.push(`\tfn.call(mod.exports, mod.exports, __qn_require, mod);\n`)
	chunks.push(`\treturn mod.exports;\n`)
	chunks.push(`}\n`)

	for (const [id, { filePath, code }] of modules) {
		chunks.push(`\n__qn_modules[${JSON.stringify(id)}] = function(exports, require, module) {\n${code}\n};\n`)
	}
	if (entryExports && (entryExports.names.length > 0 || entryExports.hasDefault)) {
		chunks.push(`\nvar __qn_entry = __qn_require(${JSON.stringify(entryId)});\n`)
		for (const name of entryExports.names) {
			chunks.push(`export var ${name} = __qn_entry.${name};\n`)
		}
		if (entryExports.hasDefault) {
			chunks.push(`export default __qn_entry.default;\n`)
		}
	} else {
		chunks.push(`\n__qn_require(${JSON.stringify(entryId)});\n`)
	}
	return chunks.join("")
}

function emitCssBundle(cssAssets) {
	return cssAssets.map(({ text }) => text.endsWith("\n") ? text : text + "\n").join("")
}

/* ------------------------------------------------------------------ *
 * Public API                                                          *
 * ------------------------------------------------------------------ */

/**
 * Walk the static import graph from `entry`, return a Set of absolute file
 * paths reachable via ESM imports (static and literal-dynamic). No transform,
 * no emit — just resolution. Non-disk specifiers (`node:*`, `qn:*`, bare names
 * with no on-disk match) are skipped silently; they're either embedded or
 * genuinely missing, and in either case we cannot watch them.
 *
 * Used by `qn:watch` to know which files to stat; exposed because any tool
 * that wants to reason about "what does this script depend on" benefits.
 */
export function traceModuleGraph(entry, options = {}) {
	const target = options.target || "node"
	const production = options.production !== false
	const conditions = makeConditions(target, production)
	const entryAbs = resolve(entry)
	if (!isFile(entryAbs)) throw new Error(`entry point not found: ${entry}`)

	const files = new Set([entryAbs])
	const stack = [entryAbs]

	while (stack.length) {
		const filePath = stack.pop()
		let analysis
		try {
			analysis = loadAndAnalyse(filePath)
		} catch (err) {
			throw new Error(`failed to analyse module graph node ${filePath}: ${err.message}`, { cause: err })
		}
		const fromDir = dirname(filePath)
		for (const imp of analysis.imports) {
			const spec = imp.specifier
			if (spec.startsWith("node:")) continue
			const resolved = resolveSpecifier(spec, fromDir, conditions)
			if (!resolved) continue
			if (!files.has(resolved)) {
				files.add(resolved)
				stack.push(resolved)
			}
		}
	}

	return files
}

export async function build(options) {
	const entrypoints = options.entrypoints || options.entryPoints
	if (!Array.isArray(entrypoints) || entrypoints.length === 0) {
		throw new Error("bundle: entrypoints option is required")
	}
	const format = options.format || "esm"
	if (!FORMATS.includes(format)) throw new Error(`bundle: unsupported format "${format}" (expected ${FORMATS.join("|")})`)
	const target = options.target || "browser"
	if (!TARGETS.includes(target)) throw new Error(`bundle: unsupported target "${target}" (expected ${TARGETS.join("|")})`)

	const outdir = options.outdir ? resolve(options.outdir) : null
	const production = options.production !== false
	const opts = {
		format,
		target,
		external: options.external || [],
		alias: options.alias || {},
		define: options.define || {},
		jsxRuntime: options.jsxRuntime || "automatic",
		jsxImportSource: options.jsxImportSource || "react",
		production,
	}

	const outputs = []
	const logs = []
	const writtenPaths = new Map()
	const reserveOutputPath = (outPath, entry) => {
		const prior = writtenPaths.get(outPath)
		if (prior) {
			throw new Error(
				`two entry points map to the same output "${outPath}": ${prior} and ${entry}. ` +
				`Rename one of the entry points.`)
		}
		writtenPaths.set(outPath, entry)
	}

	for (const entry of entrypoints) {
		const { entrypoint, entryId, modules, warnings, externals: usedExternals, entryExports, cssAssets } = bundleEntry(entry, opts)
		for (const message of warnings) logs.push({ level: "warning", message })
		let body = emitBundle({ entryId, modules, externals: usedExternals, format, entryExports })
		if (format === "iife") body = `(function(){\n${body}\n})();\n`

		let outPath = null
		const outStem = basename(entry).replace(/\.(tsx?|jsx?|mjs|cjs)$/, "")
		if (outdir) {
			outPath = join(outdir, outStem + ".js")
			reserveOutputPath(outPath, entry)
			mkdirSync(outdir, { recursive: true })
			writeFileSync(outPath, body)
		}
		outputs.push({ path: outPath, text: body, kind: "entry-point", entrypoint })
		if (cssAssets.length > 0) {
			const cssBody = emitCssBundle(cssAssets)
			let cssPath = null
			if (outdir) {
				cssPath = join(outdir, outStem + ".css")
				reserveOutputPath(cssPath, entry)
				writeFileSync(cssPath, cssBody)
			}
			outputs.push({ path: cssPath, text: cssBody, kind: "css", entrypoint })
		}
	}

	return { success: true, outputs, logs }
}

/* ------------------------------------------------------------------ *
 * CLI                                                                 *
 * ------------------------------------------------------------------ */

const HELP = `Usage: qn build <entrypoint...> [options]

Bundle JavaScript/TypeScript entry points into single-file outputs.
Side-effect CSS imports are emitted as sibling .css files for browser use.

Options:
  --outdir DIR              Output directory (default: ./dist)
  --format esm|iife         Output format (default: esm)
  --target browser|node     Resolution conditions (default: browser)
  --external PKG            Leave PKG unresolved (repeatable)
  --alias FROM=TO           Rewrite specifier FROM to TO before resolution (repeatable)
  --define KEY=VALUE        Replace identifier path KEY with literal expression VALUE (repeatable)
  --jsx-import-source SRC   Import source for JSX runtime (default: react)
  --development             Use development mode (conditions + jsx-dev-runtime)
  --help, -h                Show this help
`

export async function cli(args) {
	const entrypoints = []
	let outdir = "./dist"
	let format = "esm"
	let target = "browser"
	let jsxImportSource = "react"
	let production = true
	const external = []
	const alias = {}
	const define = {}

	const valueOf = (i, name) => {
		const arg = args[i]
		const eq = arg.indexOf("=")
		if (eq >= 0) return { value: arg.slice(eq + 1), next: i + 1 }
		if (i + 1 >= args.length) {
			console.error(`Missing value for ${name}`)
			process.exit(1)
		}
		return { value: args[i + 1], next: i + 2 }
	}

	const splitKV = (raw, flag) => {
		const eq = raw.indexOf("=")
		if (eq < 0) {
			console.error(`${flag} expects FROM=TO, got ${JSON.stringify(raw)}`)
			process.exit(1)
		}
		return [raw.slice(0, eq), raw.slice(eq + 1)]
	}

	for (let i = 0; i < args.length;) {
		const arg = args[i]
		if (arg === "--help" || arg === "-h") { console.log(HELP); return }
		if (arg === "--development" || arg === "--dev") { production = false; i++; continue }
		const name = arg.split("=")[0]
		if (name === "--outdir") { const { value, next } = valueOf(i, name); outdir = value; i = next }
		else if (name === "--format") { const { value, next } = valueOf(i, name); format = value; i = next }
		else if (name === "--target") { const { value, next } = valueOf(i, name); target = value; i = next }
		else if (name === "--external") { const { value, next } = valueOf(i, name); external.push(value); i = next }
		else if (name === "--alias") { const { value, next } = valueOf(i, name); const [k, v] = splitKV(value, "--alias"); alias[k] = v; i = next }
		else if (name === "--define") { const { value, next } = valueOf(i, name); const [k, v] = splitKV(value, "--define"); define[k] = v; i = next }
		else if (name === "--jsx-import-source") { const { value, next } = valueOf(i, name); jsxImportSource = value; i = next }
		else if (arg.startsWith("-")) { console.error(`Unknown option: ${arg}`); process.exit(1) }
		else { entrypoints.push(arg); i++ }
	}

	if (entrypoints.length === 0) {
		console.error("qn build: no entrypoints given")
		console.error(HELP)
		process.exit(1)
	}

	let result
	try {
		result = await build({ entrypoints, outdir, format, target, external, alias, define, jsxImportSource, production })
	} catch (e) {
		console.error(`qn build: ${e.message}`)
		process.exit(1)
	}
	for (const log of result.logs) {
		if (log.level === "warning") console.warn(`warn: ${log.message}`)
	}
	for (const out of result.outputs) {
		if (out.path) console.log(out.path)
	}
}
