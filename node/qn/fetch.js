/**
 * qn:fetch - qn-specific extensions to global fetch.
 *
 * Provides a pin registry so callers can require certificate / SPKI
 * pinning for HTTPS fetches to specific hostnames, without relying on
 * non-standard fetch() init options. The fetch implementation in
 * node:fetch consults this registry when establishing TLS to a host.
 *
 * Example:
 *   import { pin } from 'qn:fetch'
 *   pin('api.example.com', {
 *     spkiSha256: ['BASE64_PRIMARY=', 'BASE64_BACKUP='],
 *   })
 *   await fetch('https://api.example.com/x')   // verified against pin
 *
 * Hostnames are matched case-insensitively. URLs are accepted in place
 * of bare hostnames (only the .hostname is used). To pin all hosts,
 * use '*' (the wildcard pin is consulted only when no exact match is
 * registered).
 */

const _pins = new Map()

function _parseHost(hostnameOrUrl) {
	if (typeof hostnameOrUrl !== 'string')
		throw new TypeError('hostname must be a string')
	if (hostnameOrUrl === '*') return '*'
	if (hostnameOrUrl.includes('://')) {
		try {
			return new URL(hostnameOrUrl).hostname.toLowerCase()
		} catch {
			throw new TypeError('invalid URL: ' + hostnameOrUrl)
		}
	}
	return hostnameOrUrl.toLowerCase()
}

/**
 * Register a pin for a hostname. Subsequent fetches to that hostname
 * over HTTPS will be aborted unless the server's leaf cert (or SPKI)
 * matches one of the pinned hashes.
 */
export function pin(hostnameOrUrl, opts) {
	const host = _parseHost(hostnameOrUrl)
	if (!opts || (opts.certSha256 == null && opts.spkiSha256 == null))
		throw new TypeError('pin requires certSha256 or spkiSha256')
	_pins.set(host, opts)
}

/** Remove a previously registered pin. Returns true if one was removed. */
export function unpin(hostnameOrUrl) {
	return _pins.delete(_parseHost(hostnameOrUrl))
}

/** Remove all registered pins. */
export function clearPins() {
	_pins.clear()
}

/**
 * Look up the pin for a hostname, or null if none registered.
 * Used internally by node:fetch.
 */
export function getPin(hostname) {
	if (typeof hostname !== 'string') return null
	const exact = _pins.get(hostname.toLowerCase())
	if (exact) return exact
	return _pins.get('*') || null
}

export default { pin, unpin, clearPins, getPin }
