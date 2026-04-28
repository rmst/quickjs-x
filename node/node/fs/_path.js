/**
 * Internal helpers for node:fs. Not part of the public API.
 */

import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'

/**
 * Coerce a Node-style fs path argument (string | Buffer | URL) into a string
 * filesystem path. Mirrors Node's `getValidatedPath` for the cases qn supports.
 */
export function toPath(p) {
	if (typeof p === 'string') return p
	if (p instanceof URL) return fileURLToPath(p)
	if (Buffer.isBuffer(p)) return p.toString('utf8')
	const err = new TypeError(`The "path" argument must be of type string, Buffer, or URL. Received ${typeof p}`)
	err.code = 'ERR_INVALID_ARG_TYPE'
	throw err
}
