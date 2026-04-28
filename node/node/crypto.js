import { randomFill } from 'qn_vm'
import {
	hashInit, hashUpdate, hashOut,
	hmacInit, hmacUpdate, hmacOut,
	cipherInit, cipherUpdate, cipherSetAAD, cipherFinal,
	cipherGetAuthTag, cipherSetAuthTag,
	ecdhGenerateKeys, ecdhComputeSecret,
	ecdsaSign, ecdsaVerify,
} from 'qn:crypto'
import { Buffer } from 'node:buffer'

function toBuffer(ab, encoding) {
	const buf = Buffer.from(ab)
	if (encoding === 'hex')
		return [...new Uint8Array(ab)].map(b => b.toString(16).padStart(2, '0')).join('')
	if (encoding === 'base64')
		return buf.toString('base64')
	return buf
}

function toBytes(data) {
	if (typeof data === 'string') return data
	if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
	if (data instanceof ArrayBuffer) return new Uint8Array(data)
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
	throw new TypeError("Invalid data type: " + typeof data)
}

/* ---- Hash ---- */

export function createHash(algorithm) {
	const alg = algorithm.toLowerCase()
	return new Hash(alg)
}

export class Hash {
	constructor(alg) {
		this._ctx = hashInit(alg)
	}
	update(data) {
		if (data == null) throw new TypeError("Invalid type: " + typeof data)
		hashUpdate(this._ctx, toBytes(data))
		return this
	}
	digest(encoding) {
		return toBuffer(hashOut(this._ctx), encoding)
	}
}

/* ---- Hmac ---- */

export function createHmac(algorithm, key) {
	return new Hmac(algorithm.toLowerCase(), key)
}

export class Hmac {
	constructor(alg, key) {
		this._ctx = hmacInit(alg, toBytes(key))
	}
	update(data) {
		if (data == null) throw new TypeError("Invalid type: " + typeof data)
		hmacUpdate(this._ctx, toBytes(data))
		return this
	}
	digest(encoding) {
		return toBuffer(hmacOut(this._ctx), encoding)
	}
}

/* ---- Cipheriv / Decipheriv ---- */

export function createCipheriv(algorithm, key, iv) {
	return new Cipheriv(algorithm, key, iv, 1)
}

export function createDecipheriv(algorithm, key, iv) {
	return new Cipheriv(algorithm, key, iv, 0)
}

class Cipheriv {
	constructor(algorithm, key, iv, encrypt) {
		this._encrypt = encrypt
		this._algo = algorithm.toLowerCase()
		this._ctx = cipherInit(this._algo, encrypt, toBytes(key), toBytes(iv))
		this._chunks = []
	}
	setAAD(data) {
		cipherSetAAD(this._ctx, toBytes(data))
		return this
	}
	update(data, inputEncoding, outputEncoding) {
		if (inputEncoding === 'hex')
			data = Buffer.from(data, 'hex')
		else if (inputEncoding === 'base64')
			data = Buffer.from(data, 'base64')
		const result = cipherUpdate(this._ctx, toBytes(data))
		if (result === undefined) {
			// chapoly accumulates; data returned from final()
			return Buffer.alloc(0)
		}
		const buf = Buffer.from(result)
		this._chunks.push(buf)
		return outputEncoding ? toBuffer(result, outputEncoding) : buf
	}
	final(outputEncoding) {
		const result = cipherFinal(this._ctx)
		this._verifyAuthTag()
		const buf = Buffer.from(result)
		if (buf.length > 0) this._chunks.push(buf)
		return outputEncoding ? toBuffer(result, outputEncoding) : buf
	}
	getAuthTag() {
		return Buffer.from(cipherGetAuthTag(this._ctx))
	}
	setAuthTag(tag) {
		this._pendingTag = toBytes(tag)
		return this
	}
	_verifyAuthTag() {
		if (this._pendingTag) {
			const ok = cipherSetAuthTag(this._ctx, this._pendingTag)
			if (!ok) throw new Error("Unsupported state or unable to authenticate data")
			this._pendingTag = null
		}
	}
}

/* ---- ECDH ---- */

const curveAliases = {
	'prime256v1': 'prime256v1', 'p-256': 'prime256v1', 'secp256r1': 'prime256v1',
	'secp384r1': 'secp384r1', 'p-384': 'secp384r1',
	'secp521r1': 'secp521r1', 'p-521': 'secp521r1',
	'curve25519': 'curve25519', 'x25519': 'curve25519',
}

export function createECDH(curveName) {
	return new ECDH(curveName)
}

class ECDH {
	constructor(curveName) {
		const normalized = curveAliases[curveName.toLowerCase()]
		if (!normalized) throw new Error("Unsupported curve: " + curveName)
		this._curve = normalized
		this._pub = null
		this._priv = null
	}
	generateKeys(encoding, format) {
		const keys = ecdhGenerateKeys(this._curve)
		this._pub = Buffer.from(keys.publicKey)
		this._priv = Buffer.from(keys.privateKey)
		return encoding ? toBuffer(keys.publicKey, encoding) : this._pub
	}
	computeSecret(otherPublicKey, inputEncoding, outputEncoding) {
		if (!this._priv) throw new Error("ECDH keys not generated")
		if (inputEncoding === 'hex')
			otherPublicKey = Buffer.from(otherPublicKey, 'hex')
		else if (inputEncoding === 'base64')
			otherPublicKey = Buffer.from(otherPublicKey, 'base64')
		const pub = otherPublicKey instanceof ArrayBuffer
			? otherPublicKey
			: (ArrayBuffer.isView(otherPublicKey)
				? otherPublicKey.buffer.slice(otherPublicKey.byteOffset, otherPublicKey.byteOffset + otherPublicKey.byteLength)
				: otherPublicKey)
		// Need to pass ArrayBuffers to the native function
		const privAb = this._priv.buffer.slice(this._priv.byteOffset, this._priv.byteOffset + this._priv.byteLength)
		const pubAb = Buffer.isBuffer(pub) ? pub.buffer.slice(pub.byteOffset, pub.byteOffset + pub.byteLength) : pub
		const secret = ecdhComputeSecret(this._curve, privAb, pubAb)
		return outputEncoding ? toBuffer(secret, outputEncoding) : Buffer.from(secret)
	}
	getPublicKey(encoding, format) {
		if (!this._pub) throw new Error("ECDH keys not generated")
		return encoding ? toBuffer(this._pub.buffer.slice(this._pub.byteOffset, this._pub.byteOffset + this._pub.byteLength), encoding) : this._pub
	}
	getPrivateKey(encoding) {
		if (!this._priv) throw new Error("ECDH keys not generated")
		return encoding ? toBuffer(this._priv.buffer.slice(this._priv.byteOffset, this._priv.byteOffset + this._priv.byteLength), encoding) : this._priv
	}
	setPrivateKey(privateKey, encoding) {
		if (encoding === 'hex')
			privateKey = Buffer.from(privateKey, 'hex')
		else if (encoding === 'base64')
			privateKey = Buffer.from(privateKey, 'base64')
		this._priv = Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(privateKey)
		// Recompute public key - would need native support, skip for now
		this._pub = null
	}
}

/* ---- Sign / Verify (ECDSA only for now) ---- */

export function createSign(algorithm) {
	return new Sign(algorithm)
}

export function createVerify(algorithm) {
	return new Verify(algorithm)
}

class Sign {
	constructor(algorithm) {
		this._algo = algorithm.toLowerCase().replace(/^rsa-/, '')
		this._data = []
	}
	update(data) {
		this._data.push(toBytes(data))
		return this
	}
	sign(privateKey, outputEncoding) {
		// First hash all the data
		const ctx = hashInit(this._algo)
		for (const chunk of this._data)
			hashUpdate(ctx, chunk)
		const digest = hashOut(ctx)

		// For now only ECDSA is supported via the native module
		// privateKey should be { key, dsaEncoding, ... } or a PEM string
		// For raw key usage: { key: Buffer, curve: 'prime256v1' }
		if (typeof privateKey === 'object' && privateKey.curve) {
			const privAb = toArrayBuffer(privateKey.key)
			const sig = ecdsaSign(this._algo, digest, privateKey.curve, privAb)
			return outputEncoding ? toBuffer(sig, outputEncoding) : Buffer.from(sig)
		}
		throw new Error("createSign currently only supports ECDSA with raw keys ({ key, curve })")
	}
}

class Verify {
	constructor(algorithm) {
		this._algo = algorithm.toLowerCase().replace(/^rsa-/, '')
		this._data = []
	}
	update(data) {
		this._data.push(toBytes(data))
		return this
	}
	verify(publicKey, signature, signatureEncoding) {
		const ctx = hashInit(this._algo)
		for (const chunk of this._data)
			hashUpdate(ctx, chunk)
		const digest = hashOut(ctx)

		if (signatureEncoding === 'hex')
			signature = Buffer.from(signature, 'hex')
		else if (signatureEncoding === 'base64')
			signature = Buffer.from(signature, 'base64')

		if (typeof publicKey === 'object' && publicKey.curve) {
			const pubAb = toArrayBuffer(publicKey.key)
			const sigAb = toArrayBuffer(signature)
			return ecdsaVerify(this._algo, digest, sigAb, publicKey.curve, pubAb)
		}
		throw new Error("createVerify currently only supports ECDSA with raw keys ({ key, curve })")
	}
}

function toArrayBuffer(data) {
	if (data instanceof ArrayBuffer) return data
	if (ArrayBuffer.isView(data))
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
	if (Buffer.isBuffer(data))
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
	throw new TypeError("Expected ArrayBuffer or TypedArray")
}

/* ---- Random ---- */

export function randomBytes(size) {
	if (typeof size !== 'number' || size < 0 || size !== Math.floor(size))
		throw new TypeError(`The "size" argument must be a non-negative integer. Received ${size}`)
	return Buffer.from(randomFill(size))
}

export function randomFillSync(buffer, offset = 0, size) {
	if (size === undefined) size = buffer.length - offset
	const bytes = randomFill(size)
	buffer.set(bytes, offset)
	return buffer
}

export function randomUUID() {
	const bytes = randomBytes(16)
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/* ---- Timing-safe compare ---- */

export function timingSafeEqual(a, b) {
	if (!(a instanceof Uint8Array) && !Buffer.isBuffer(a))
		throw new TypeError('The "buf1" argument must be an instance of Buffer, TypedArray, or DataView.')
	if (!(b instanceof Uint8Array) && !Buffer.isBuffer(b))
		throw new TypeError('The "buf2" argument must be an instance of Buffer, TypedArray, or DataView.')
	if (a.length !== b.length)
		throw new RangeError('Input buffers must have the same byte length')
	let result = 0
	for (let i = 0; i < a.length; i++)
		result |= a[i] ^ b[i]
	return result === 0
}

/* ---- Introspection ---- */

export function getHashes() {
	return ['md5', 'sha1', 'sha256', 'sha384', 'sha512']
}

export function getCiphers() {
	return ['aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr', 'aes-128-gcm', 'aes-256-gcm', 'chacha20-poly1305']
}

export function getCurves() {
	return ['prime256v1', 'secp384r1', 'secp521r1', 'curve25519']
}

export default {
	createHash, Hash,
	createHmac, Hmac,
	createCipheriv, createDecipheriv,
	createECDH,
	createSign, createVerify,
	randomBytes, randomFillSync, randomUUID,
	timingSafeEqual,
	getHashes, getCiphers, getCurves,
}
