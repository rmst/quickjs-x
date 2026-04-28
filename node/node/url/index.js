/**
 * WHATWG URL Standard implementation for Qn
 *
 * Ported from jsdom/whatwg-url (MIT License)
 * https://github.com/jsdom/whatwg-url
 * Copyright (c) Sebastian Mayr
 *
 * This is a simplified port for Qn with the following changes:
 * - Converted from CommonJS to ES modules
 * - Removed webidl2js wrapper layer
 * - Removed tr46 dependency (IDN/Punycode not supported)
 *
 * LIMITATION: Internationalized Domain Names (IDN) are NOT supported.
 * URLs with non-ASCII hostnames (e.g., https://münchen.de/) will throw an error.
 * Use the ASCII/Punycode form instead (e.g., https://xn--mnchen-3ya.de/).
 */

import { URL } from "./URL.js";
import { URLSearchParams } from "./URLSearchParams.js";
import { resolve as pathResolve } from "node:path";

/**
 * Convert a file: URL (or URL string) to a filesystem path. POSIX semantics:
 * rejects non-file schemes, rejects host components, rejects encoded slashes,
 * decodes the rest via decodeURIComponent.
 */
export function fileURLToPath(path) {
	if (typeof path === 'string') path = new URL(path)
	else if (!(path instanceof URL)) {
		const err = new TypeError('The "path" argument must be of type string or an instance of URL.')
		err.code = 'ERR_INVALID_ARG_TYPE'
		throw err
	}
	if (path.protocol !== 'file:') {
		const err = new TypeError('The URL must be of scheme file')
		err.code = 'ERR_INVALID_URL_SCHEME'
		throw err
	}
	if (path.hostname !== '') {
		const err = new TypeError('File URL host must be "localhost" or empty')
		err.code = 'ERR_INVALID_FILE_URL_HOST'
		throw err
	}
	const pathname = path.pathname
	for (let i = 0; i < pathname.length; i++) {
		if (pathname.charCodeAt(i) === 37 /* % */) {
			const third = pathname.charCodeAt(i + 2) | 0x20
			if (pathname.charCodeAt(i + 1) === 50 /* 2 */ && third === 102 /* f */) {
				const err = new TypeError('File URL path must not include encoded / characters')
				err.code = 'ERR_INVALID_FILE_URL_PATH'
				throw err
			}
		}
	}
	return decodeURIComponent(pathname)
}

/**
 * Inverse of fileURLToPath. Resolves the input against cwd, percent-encodes
 * characters that are not safe inside a URL path, and returns a file: URL.
 */
export function pathToFileURL(filepath) {
	if (typeof filepath !== 'string') {
		const err = new TypeError('Path must be a string.')
		err.code = 'ERR_INVALID_ARG_TYPE'
		throw err
	}
	let resolved = pathResolve(filepath)
	// path.resolve strips trailing slashes — restore for directory inputs.
	if (filepath.endsWith('/') && !resolved.endsWith('/')) resolved += '/'
	if (resolved.includes('%')) resolved = resolved.replaceAll('%', '%25')
	if (resolved.includes('\\')) resolved = resolved.replaceAll('\\', '%5C')
	if (resolved.includes('\n')) resolved = resolved.replaceAll('\n', '%0A')
	if (resolved.includes('\r')) resolved = resolved.replaceAll('\r', '%0D')
	if (resolved.includes('\t')) resolved = resolved.replaceAll('\t', '%09')
	const url = new URL('file://')
	url.pathname = resolved
	return url
}

export { URL, URLSearchParams }

export default { URL, URLSearchParams, fileURLToPath, pathToFileURL }
