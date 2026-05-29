/**
 * qn:crypto - Low-level crypto primitives backed by BearSSL
 *
 * This module provides the native bindings used by both qn:tls and node:crypto.
 */

export {
	// TLS engine
	tlsConnect, tlsAccept,
	tlsLoadCACerts, tlsCaCertCount, tlsLoadServerCert, tlsLoadServerCertPem,
	tlsState, tlsError, tlsPeerLeafDer,
	tlsSendApp, tlsRecvApp, tlsFlush, tlsClose,
	tlsGetSendRec, tlsSendRecAck, tlsRecvRecPush,
	TLS_CLOSED, TLS_SENDREC, TLS_RECVREC, TLS_SENDAPP, TLS_RECVAPP,
	EAGAIN,
	// Hashing (backward-compatible aliases)
	sha256Init, sha256Update, sha256Out,
	sha1Init, sha1Update, sha1Out,
	// Generic hash
	hashInit, hashUpdate, hashOut,
	// HMAC
	hmacInit, hmacUpdate, hmacOut,
	// Symmetric ciphers
	cipherInit, cipherUpdate, cipherSetAAD, cipherFinal,
	cipherGetAuthTag, cipherSetAuthTag,
	// ECDH
	ecdhGenerateKeys, ecdhComputeSecret,
	// ECDSA
	ecdsaSign, ecdsaVerify,
} from './qn_crypto.so'
