/**
 * qn:tls - Async TLS I/O module
 *
 * Drives BearSSL's non-blocking engine using the QuickJS event loop.
 * The C side (qn:crypto) exposes thin wrappers around the BearSSL engine
 * state machine; this module provides the async I/O loop on top.
 *
 * All I/O goes through a transport object { read, write } created from
 * libuv stream handles via streamTransport().
 */

import {
	tlsConnect as _tlsConnect, tlsAccept as _tlsAccept,
	tlsLoadCACerts, tlsCaCertCount, tlsLoadServerCert, tlsLoadServerCertPem,
	tlsState, tlsError, tlsPeerLeafDer as _tlsPeerLeafDer,
	tlsSendApp, tlsRecvApp, tlsFlush as _tlsFlush, tlsClose as _tlsClose,
	tlsGetSendRec, tlsSendRecAck, tlsRecvRecPush,
	hashInit, hashUpdate, hashOut,
	TLS_CLOSED, TLS_SENDREC, TLS_RECVREC, TLS_SENDAPP, TLS_RECVAPP,
} from 'qn:crypto'
import { existsSync } from 'node:fs'
import {
	readStart, readStop, write as _streamWrite,
	setOnRead,
} from 'qn/uv-stream'

export {
	tlsLoadCACerts as loadCACerts,
	tlsCaCertCount as caCertCount,
	tlsLoadServerCert as loadServerCert,
	tlsLoadServerCertPem as loadServerCertPem,
}
export { TLS_CLOSED, TLS_SENDREC, TLS_RECVREC, TLS_SENDAPP, TLS_RECVAPP }

const SYSTEM_CA_PATHS = [
	'/etc/ssl/certs/ca-certificates.crt',
	'/etc/pki/tls/certs/ca-bundle.crt',
	'/etc/ssl/cert.pem',
	'/etc/ssl/ca-bundle.pem',
	'/usr/local/share/certs/ca-root-nss.crt',
	'/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
]

let _caCertsLoaded = false

export function ensureCACerts() {
	if (_caCertsLoaded) return
	_caCertsLoaded = true

	const sslCertFile = globalThis.process?.env?.SSL_CERT_FILE
	if (sslCertFile) {
		tlsLoadCACerts(sslCertFile)
	} else {
		for (const p of SYSTEM_CA_PATHS) {
			if (existsSync(p)) {
				tlsLoadCACerts(p)
				break
			}
		}
	}

	const extraCerts = globalThis.process?.env?.NODE_EXTRA_CA_CERTS
	if (extraCerts) tlsLoadCACerts(extraCerts)
}

/* Per-connection pin options, set via connect() and consumed by handshake(). */
const _pinOpts = new WeakMap()

/**
 * Create a TLS client context (transport-based, no fd).
 *
 * @param {string} hostname  Server hostname (used for SNI + certificate
 *                           subject matching).
 * @param {object} [opts]    qn-specific options (not aliased to node:tls).
 *   opts.rejectUnauthorized If false, bypass BearSSL chain / hostname
 *                           verification. This is insecure and intended only
 *                           for node:https compatibility.
 *   opts.pin                Optional pin spec. If set, handshake() will
 *                           verify it after the BearSSL engine is happy:
 *     pin.certSha256        Base64 SHA-256 of full leaf cert DER, or array.
 *     pin.spkiSha256        Base64 SHA-256 of leaf cert SPKI DER, or array.
 *                           If both are given, both must match.
 *     pin.trustOnlyPin      If true, BearSSL chain validation (CA trust,
 *                           signatures, expiry, hostname matching) is
 *                           bypassed and the pin is the sole identity
 *                           check. Required for self-signed certs. Must
 *                           be combined with at least one hash field.
 */
export function connect(hostname, opts) {
	const pin = opts && opts.pin ? _normalizePin(opts.pin) : null
	const skip = opts?.rejectUnauthorized === false || (pin && pin.trustOnlyPin) ? 1 : 0
	const conn = _tlsConnect(-1, hostname, skip)
	if (pin) _pinOpts.set(conn, pin)
	return conn
}

/**
 * Return the captured leaf certificate DER bytes from a client connection,
 * or null if unavailable. Only meaningful after handshake.
 */
export function peerLeafDer(conn) {
	const ab = _tlsPeerLeafDer(conn)
	return ab ? new Uint8Array(ab) : null
}

/** Create a TLS server context (transport-based, no fd). */
export function accept(cred) {
	return _tlsAccept(-1, cred)
}

/* ---- libuv stream-based transport ---- */

/**
 * Create a transport { read, write } from a libuv stream handle.
 * The read side uses one-shot reads: start reading, resolve on first chunk, stop.
 */
export function streamTransport(handle) {
	let pendingResolve = null
	let pendingReject = null
	let pendingSignal = null
	let pendingAbort = null
	let buffered = null
	let eof = false

	const clearPendingRead = () => {
		if (pendingSignal && pendingAbort)
			pendingSignal.removeEventListener('abort', pendingAbort)
		pendingResolve = null
		pendingReject = null
		pendingSignal = null
		pendingAbort = null
	}

	setOnRead(handle, (buf, err) => {
		if (err) {
			readStop(handle)
			if (pendingReject) {
				const rej = pendingReject
				clearPendingRead()
				rej(new Error('TLS: stream read error'))
			}
			return
		}
		if (buf === null) {
			eof = true
			readStop(handle)
			if (pendingResolve) {
				const res = pendingResolve
				clearPendingRead()
				res(null)
			}
			return
		}
		/* Got data — stop reading and deliver */
		readStop(handle)
		const chunk = new Uint8Array(buf)
		if (pendingResolve) {
			const res = pendingResolve
			clearPendingRead()
			res(chunk)
		} else {
			buffered = chunk
		}
	})

	return {
		read({ signal } = {}) {
			if (buffered) {
				const b = buffered
				buffered = null
				return Promise.resolve(b)
			}
			if (eof) return Promise.resolve(null)
			if (signal?.aborted) return Promise.reject(signal.reason)
			return new Promise((resolve, reject) => {
				pendingResolve = resolve
				pendingReject = reject
				if (signal) {
					pendingSignal = signal
					pendingAbort = () => {
						readStop(handle)
						const rej = pendingReject
						clearPendingRead()
						if (rej) rej(signal.reason)
					}
					signal.addEventListener('abort', pendingAbort, { once: true })
				}
				try {
					readStart(handle)
				} catch (err) {
					clearPendingRead()
					reject(err)
				}
			})
		},
		write(data, { signal } = {}) {
			if (signal?.aborted) return Promise.reject(signal.reason)
			return _streamWrite(handle, data)
		},
	}
}

/** Leftover state for connections */
const _recvState = new WeakMap()

/**
 * Core engine driver: pumps record I/O through transport until condition
 * is met or engine closes.
 */
async function drive(conn, transport, condition, signal) {
	let rs = _recvState.get(conn)
	if (!rs) { rs = { leftover: null }; _recvState.set(conn, rs) }
	for (;;) {
		if (signal?.aborted) throw signal.reason
		const state = tlsState(conn)
		if (condition(state)) return state
		if (state & TLS_CLOSED) return state
		if (state & TLS_SENDREC) {
			const data = tlsGetSendRec(conn)
			if (data && data.byteLength > 0) {
				await transport.write(new Uint8Array(data), { signal })
				tlsSendRecAck(conn, data.byteLength)
			}
			continue
		}
		if (state & TLS_RECVREC) {
			if (rs.leftover) {
				const lo = rs.leftover
				const n = tlsRecvRecPush(conn, lo.buffer, lo.byteOffset, lo.byteLength)
				rs.leftover = n >= lo.byteLength ? null : lo.subarray(n)
			} else {
				const chunk = await transport.read({ signal })
				if (!chunk) { _tlsClose(conn); continue }
				const n = tlsRecvRecPush(conn, chunk.buffer, chunk.byteOffset, chunk.byteLength)
				if (n < chunk.byteLength) rs.leftover = chunk.subarray(n)
			}
			continue
		}
	}
}

/**
 * Perform TLS handshake asynchronously.
 * Drives the engine until SENDAPP is available (handshake complete).
 *
 * If pin options were passed to connect(), verifies the captured leaf
 * certificate against them after the BearSSL engine has accepted the
 * chain. A pin mismatch fails the handshake.
 */
export async function handshake(conn, transport, signal) {
	const state = await drive(conn, transport, s => s & TLS_SENDAPP, signal)
	if (!(state & TLS_SENDAPP)) {
		const err = tlsError(conn)
		throw new Error('TLS handshake failed' + (err ? ': error ' + err : ''))
	}

	const pin = _pinOpts.get(conn)
	if (pin) verifyPin(conn, pin)
}

/* ---- Certificate pinning ---- */

function _toBase64(bytes) {
	let bin = ''
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
	return globalThis.btoa(bin)
}

function _sha256Base64(bytes) {
	const h = hashInit('sha256')
	hashUpdate(h, bytes)
	return _toBase64(new Uint8Array(hashOut(h)))
}

function _normalizePin(pin) {
	if (!pin || typeof pin !== 'object')
		throw new TypeError('pin must be an object')
	const out = {}
	if (pin.certSha256 != null) {
		out.certSha256 = Array.isArray(pin.certSha256)
			? pin.certSha256.slice() : [pin.certSha256]
	}
	if (pin.spkiSha256 != null) {
		out.spkiSha256 = Array.isArray(pin.spkiSha256)
			? pin.spkiSha256.slice() : [pin.spkiSha256]
	}
	if (!out.certSha256 && !out.spkiSha256)
		throw new TypeError('pin must specify certSha256 or spkiSha256')
	for (const list of [out.certSha256, out.spkiSha256]) {
		if (!list) continue
		for (const v of list) {
			if (typeof v !== 'string' || v.length === 0)
				throw new TypeError('pin hash must be a non-empty string')
		}
	}
	if (pin.trustOnlyPin) out.trustOnlyPin = true
	return out
}

/*
 * ASN.1 / DER helpers. We need just enough of a parser to walk a
 * Certificate down to its SubjectPublicKeyInfo and return the raw DER
 * of that field, so its SHA-256 can be compared against a standard
 * SPKI pin (e.g. produced by openssl x509 -pubkey | openssl pkey
 * -pubin -outform DER | openssl dgst -sha256 -binary | base64).
 */
function _parseLength(buf, off) {
	if (off >= buf.length) throw new Error('SPKI: truncated length')
	const first = buf[off]
	if (first < 0x80) return [first, 1]
	const n = first & 0x7f
	if (n === 0) throw new Error('SPKI: indefinite length not allowed')
	if (n > 4 || off + 1 + n > buf.length)
		throw new Error('SPKI: bad multi-byte length')
	let len = 0
	for (let i = 0; i < n; i++) len = (len * 256) + buf[off + 1 + i]
	return [len, 1 + n]
}

function _parseTlv(buf, off) {
	if (off >= buf.length) throw new Error('SPKI: truncated tag')
	const tag = buf[off]
	const [len, lenBytes] = _parseLength(buf, off + 1)
	const headerLen = 1 + lenBytes
	if (off + headerLen + len > buf.length)
		throw new Error('SPKI: TLV exceeds buffer')
	return { tag, headerLen, contentOff: off + headerLen, contentLen: len,
		totalLen: headerLen + len }
}

/**
 * Extract the SubjectPublicKeyInfo DER from a Certificate DER.
 * Returns a Uint8Array view into the input.
 */
export function extractSpki(certDer) {
	const buf = certDer instanceof Uint8Array
		? certDer : new Uint8Array(certDer)
	const outer = _parseTlv(buf, 0)
	if (outer.tag !== 0x30) throw new Error('SPKI: Certificate not SEQUENCE')
	const tbs = _parseTlv(buf, outer.contentOff)
	if (tbs.tag !== 0x30) throw new Error('SPKI: tbsCertificate not SEQUENCE')

	let off = tbs.contentOff
	const end = tbs.contentOff + tbs.contentLen

	if (off < end && buf[off] === 0xa0) {
		off += _parseTlv(buf, off).totalLen   /* version [0] */
	}
	const expect = (tag, name) => {
		const t = _parseTlv(buf, off)
		if (t.tag !== tag) throw new Error('SPKI: expected ' + name)
		off += t.totalLen
	}
	expect(0x02, 'serialNumber INTEGER')
	expect(0x30, 'signature SEQUENCE')
	expect(0x30, 'issuer SEQUENCE')
	expect(0x30, 'validity SEQUENCE')
	expect(0x30, 'subject SEQUENCE')

	const spki = _parseTlv(buf, off)
	if (spki.tag !== 0x30) throw new Error('SPKI: not SEQUENCE')
	return buf.subarray(off, off + spki.totalLen)
}

function _matchesAny(actual, expected) {
	for (const e of expected) {
		if (e === actual) return true
	}
	return false
}

/**
 * Verify the leaf cert captured during handshake against pin options.
 * Throws on mismatch; closes the engine so the caller can detect failure
 * and tear down the transport. Idempotent — safe to call once handshake
 * has succeeded. Throws TypeError if no leaf was captured (e.g. server
 * sent a cert larger than PIN_LEAF_MAX).
 */
export function verifyPin(conn, pin) {
	const norm = _normalizePin(pin)
	const leafAb = _tlsPeerLeafDer(conn)
	if (!leafAb) {
		_tlsClose(conn)
		throw new Error('TLS pin verification failed: no leaf cert captured')
	}
	const leaf = new Uint8Array(leafAb)

	if (norm.certSha256) {
		const h = _sha256Base64(leaf)
		if (!_matchesAny(h, norm.certSha256)) {
			_tlsClose(conn)
			throw new Error('TLS pin verification failed: leaf cert hash mismatch')
		}
	}
	if (norm.spkiSha256) {
		const spki = extractSpki(leaf)
		const h = _sha256Base64(spki)
		if (!_matchesAny(h, norm.spkiSha256)) {
			_tlsClose(conn)
			throw new Error('TLS pin verification failed: SPKI hash mismatch')
		}
	}
}

/**
 * Write all data over TLS asynchronously.
 * Handles partial sends and flushes automatically.
 */
export async function writeAll(conn, transport, data, signal) {
	const ab = data.buffer
	let off = data.byteOffset
	let rem = data.byteLength
	while (rem > 0) {
		const state = await drive(conn, transport, s => (s & TLS_SENDAPP) || (s & TLS_CLOSED), signal)
		if (state & TLS_CLOSED) throw new Error('TLS: connection closed during write')
		const n = tlsSendApp(conn, ab, off, rem)
		off += n
		rem -= n
		if (rem > 0) _tlsFlush(conn, 0)
	}
	_tlsFlush(conn, 0)
	await drive(conn, transport, s => !(s & TLS_SENDREC), signal)
}

/**
 * Read decrypted data from TLS connection asynchronously.
 * Returns number of bytes read, or 0 for EOF.
 */
export async function read(conn, transport, buf, off, len, signal) {
	const state = await drive(conn, transport, s => (s & TLS_RECVAPP) || (s & TLS_CLOSED), signal)
	if (state & TLS_RECVAPP) return tlsRecvApp(conn, buf, off, len)
	return 0
}

/**
 * Flush buffered TLS data and pump it to the network.
 */
export async function flush(conn, transport, signal) {
	_tlsFlush(conn, 0)
	await drive(conn, transport, s => !(s & TLS_SENDREC), signal)
}

/**
 * Close TLS connection gracefully (sends close_notify).
 */
export async function close(conn, transport) {
	_tlsClose(conn)
	try {
		for (;;) {
			const state = tlsState(conn)
			if (!(state & TLS_SENDREC)) break
			const data = tlsGetSendRec(conn)
			if (!data || data.byteLength === 0) break
			await transport.write(new Uint8Array(data))
			tlsSendRecAck(conn, data.byteLength)
		}
	} catch {
		// Ignore errors during close - peer may have disconnected
	}
}
