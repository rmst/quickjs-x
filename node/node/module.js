/**
 * Node.js module compatibility for Qn.
 * Implements the subset used by qn.
 * @see https://nodejs.org/api/module.html
 */

import { transform, parse } from "qn:sucrase"

/**
 * createRequire — delegates to qn:cjs which registers itself via a global.
 * This avoids eagerly importing qn:cjs (which depends on node:path) when
 * node:module is loaded.  qnc's lightweight TS context imports node:module
 * only for stripTypeScriptTypes and must not pull in the full CJS runtime.
 */
export function createRequire(filenameOrUrl) {
	const impl = globalThis.__qn_createRequire
	if (!impl) {
		throw new Error("createRequire is not available — qn:cjs was not loaded")
	}
	return impl(filenameOrUrl)
}

// Token type and contextual keyword constants from Sucrase's parser
const TT_IMPORT = 90640
const TT_EXPORT = 89104
const TT_STRING = 4608
const TT_ENUM = 113168
const TT_BRACE_R = 11264
const TT_PAREN_L = 13824
const TT_COMMA = 15360
const TT_NON_NULL_ASSERTION = 61440
const TT_DECLARE = 103952
const TT_READONLY = 104976
const TT_ABSTRACT = 106000
const TT_PUBLIC = 107536
const TT_PRIVATE = 108560
const TT_PROTECTED = 109584
const TT_OVERRIDE = 110608
const CK_TYPE = 38
const CK_NAMESPACE = 23
const CK_FROM = 13

function isClassModifierType(type) {
	return type === TT_PUBLIC || type === TT_PRIVATE || type === TT_PROTECTED
		|| type === TT_READONLY || type === TT_ABSTRACT || type === TT_OVERRIDE
		|| type === TT_DECLARE
}

/**
 * Strips TypeScript type annotations from source code, returning plain JavaScript.
 *
 * In 'strip' mode (default), type-only syntax is replaced with whitespace to preserve
 * source positions (inspired by ts-blank-space). Throws on constructs that require
 * runtime code generation (enums, namespaces with values, constructor parameter
 * properties).
 *
 * In 'transform' mode, Sucrase's full transform is used. Handles all TypeScript
 * constructs including enums, but does not preserve source positions.
 *
 * @param {string} code - TypeScript source code
 * @param {object} [options] - Options
 * @param {string} [options.mode] - 'strip' (default) or 'transform'
 * @returns {string} JavaScript source code
 */
export function stripTypeScriptTypes(code, options) {
	const mode = options?.mode ?? "strip"
	const { tokens } = parse(code, false, true, false)
	// Neither strip nor Sucrase's transform can faithfully emit a TS value
	// namespace (strip blanks it, transform drops it). Reject before either
	// path runs so callers get a clear error instead of code that fails at
	// runtime with a mysterious "X is not defined".
	requireNoValueNamespace(tokens)
	if (mode === "transform") {
		return transform(code, { transforms: ["typescript"], disableESTransforms: true }).code
	}
	const blanked = blankTypeScriptTypes(code, tokens)
	// Blanking can silently produce invalid JS when newlines inside a type region
	// violate a no-LineTerminator restriction in the surrounding JS — most notably
	// a multi-line return type on an arrow function, where the LineTerminator
	// between `)` and `=>` is a parse error. Re-parse the blanked output to catch
	// this and throw so callers can fall back to transform mode.
	try {
		parse(blanked, false, false, false)
	} catch {
		throw new SyntaxError(
			"TypeScript type spans lines in a position where the surrounding JavaScript " +
			"forbids line terminators (e.g. multi-line arrow return type). " +
			"Use { mode: 'transform' } instead.",
		)
	}
	return blanked
}

/**
 * Reject value namespaces. `declare namespace` is type-only per TS spec and
 * safely erasable; anything else may emit runtime values that we cannot preserve.
 */
function requireNoValueNamespace(tokens) {
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]
		if (t.contextualKeyword !== CK_NAMESPACE) continue
		let j = i - 1
		while (j >= 0 && tokens[j].start === tokens[j].end) j--
		if (j < 0 || tokens[j].type !== TT_DECLARE) {
			throw new SyntaxError(
				"TypeScript namespace with runtime values is not supported. " +
				"Use `declare namespace` for type-only declarations or ES modules.",
			)
		}
	}
}

/**
 * Replace TypeScript type-only syntax with whitespace, preserving source positions.
 * Uses Sucrase's parser to identify type regions via the isType token flag, then blanks
 * them in the original source (similar to Bloomberg's ts-blank-space approach).
 */
function blankTypeScriptTypes(code, tokens) {
	// Collect ranges to blank: [start, end, start, end, ...]
	const ranges = []

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]
		if (t.start === t.end) continue

		// Reject constructs that require runtime code generation
		if (t.type === TT_ENUM) {
			throw new SyntaxError("TypeScript enum is not supported in strip-only mode")
		}

		// Non-null assertion `x!`: Sucrase retypes the `!` token to
		// nonNullAssertion but does not mark isType — blank it.
		if (t.type === TT_NON_NULL_ASSERTION) {
			ranges.push(t.start, t.end)
			continue
		}

		// TS-only class modifiers (public/private/protected/readonly/abstract/
		// override/declare) keep isType=false even though they are pure type
		// syntax on class members. Blank them so the emitted JS parses. For
		// constructor parameter properties the same keywords imply a runtime
		// assignment — detect that by looking back past preceding modifier
		// tokens for a `(` or `,` and fall back to transform mode.
		if (!t.isType && isClassModifierType(t.type)) {
			let j = i - 1
			while (j >= 0) {
				const p = tokens[j]
				if (p.start === p.end || isClassModifierType(p.type)) {
					j--
					continue
				}
				break
			}
			if (j >= 0 && (tokens[j].type === TT_PAREN_L || tokens[j].type === TT_COMMA)) {
				throw new SyntaxError("TypeScript parameter property is not supported in strip-only mode")
			}
			ranges.push(t.start, t.end)
			continue
		}

		// Handle `import type ...` and `export type ...` statements.
		// These have isType=false on all tokens, but the `type` keyword after
		// import/export has contextualKeyword === CK_TYPE.
		// Mirrors ts-blank-space: blank the entire statement.
		if ((t.type === TT_IMPORT || t.type === TT_EXPORT) && i + 1 < tokens.length) {
			const next = tokens[i + 1]
			if (next.contextualKeyword === CK_TYPE && !next.isType) {
				// Find the end of this import/export type statement.
				// Ends at the from-clause string literal (TT_STRING) if present,
				// otherwise at the closing brace (e.g. `export type { Foo }`).
				let lastIdx = i + 1
				for (let j = i + 2; j < tokens.length; j++) {
					if (tokens[j].start === tokens[j].end) continue
					lastIdx = j
					if (tokens[j].type === TT_STRING) break
					if (tokens[j].type === TT_BRACE_R) {
						// Check if next non-empty token is `from` — if so, continue
						let hasFrom = false
						for (let k = j + 1; k < tokens.length; k++) {
							if (tokens[k].start === tokens[k].end) continue
							if (tokens[k].contextualKeyword === CK_FROM) hasFrom = true
							break
						}
						if (!hasFrom) break
					}
				}
				const end = tokens[lastIdx].end
				ranges.push(t.start, end)
				i = lastIdx
				continue
			}
		}

		if (t.isType) {
			// Extend back to cover whitespace between previous non-type token and this one
			let regionStart = t.start
			if (i > 0) {
				const prev = tokens[i - 1]
				if (!prev.isType) {
					regionStart = prev.end
				}
			}

			// Extend forward through consecutive isType tokens
			let regionEnd = t.end
			while (i + 1 < tokens.length && tokens[i + 1].isType) {
				i++
				regionEnd = tokens[i].end
			}

			ranges.push(regionStart, regionEnd)
		}
	}

	if (ranges.length === 0) return code

	// Build output: copy non-blanked regions verbatim, blank regions become whitespace
	let out = ""
	let pos = 0
	for (let i = 0; i < ranges.length; i += 2) {
		const start = ranges[i]
		const end = ranges[i + 1]
		out += code.slice(pos, start)
		// Replace with spaces, preserving newlines
		for (let j = start; j < end; j++) {
			const ch = code.charCodeAt(j)
			out += (ch === 10 || ch === 13) ? code[j] : " "
		}
		pos = end
	}
	out += code.slice(pos)
	return out
}

export default { createRequire, stripTypeScriptTypes }
