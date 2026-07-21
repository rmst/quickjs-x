/*
 * ECDH and ECDSA bindings for qn:crypto.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bearssl.h"
#include "quickjs.h"

#include "qn-crypto.h"

/* --------------------------------------------------------------------------
 * ECDH via BearSSL
 *
 * ecdhGenerateKeys(curve)         → { publicKey: ArrayBuffer, privateKey: ArrayBuffer }
 * ecdhComputeSecret(curve, privKey, pubKey) → ArrayBuffer
 * -------------------------------------------------------------------------- */

static int curve_from_name(const char *name)
{
	if (strcmp(name, "prime256v1") == 0 || strcmp(name, "P-256") == 0 ||
	    strcmp(name, "secp256r1") == 0)
		return BR_EC_secp256r1;
	if (strcmp(name, "secp384r1") == 0 || strcmp(name, "P-384") == 0)
		return BR_EC_secp384r1;
	if (strcmp(name, "secp521r1") == 0 || strcmp(name, "P-521") == 0)
		return BR_EC_secp521r1;
	if (strcmp(name, "curve25519") == 0 || strcmp(name, "x25519") == 0)
		return BR_EC_curve25519;
	return -1;
}

static JSValue js_ecdhGenerateKeys(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
	const char *curve_name = JS_ToCString(ctx, argv[0]);
	if (!curve_name) return JS_EXCEPTION;
	int curve = curve_from_name(curve_name);
	JS_FreeCString(ctx, curve_name);
	if (curve < 0)
		return JS_ThrowTypeError(ctx, "unsupported curve");

	const br_ec_impl *ec = br_ec_get_default();
	br_hmac_drbg_context rng;
	br_hmac_drbg_init(&rng, &br_sha256_vtable, "seed", 4);

	/* Seed with system randomness. Entropy failure must be loud: falling
	 * back to BearSSL's deterministic initial state would produce weak keys. */
	uint8_t seed[32];
	FILE *f = fopen("/dev/urandom", "rb");
	if (!f) {
		return JS_ThrowInternalError(ctx, "failed to open /dev/urandom: %s", strerror(errno));
	}
	size_t got = fread(seed, 1, sizeof(seed), f);
	int read_error = ferror(f);
	int read_errno = errno;
	fclose(f);
	if (got != sizeof(seed)) {
		return JS_ThrowInternalError(ctx, "failed to read entropy from /dev/urandom: %s",
			read_error ? strerror(read_errno) : "short read");
	}
	br_hmac_drbg_update(&rng, seed, sizeof(seed));

	uint8_t priv_buf[BR_EC_KBUF_PRIV_MAX_SIZE];
	br_ec_private_key sk;
	size_t priv_len = br_ec_keygen(&rng.vtable, ec, &sk, priv_buf, curve);
	if (priv_len == 0)
		return JS_ThrowTypeError(ctx, "ECDH key generation failed");

	uint8_t pub_buf[BR_EC_KBUF_PUB_MAX_SIZE];
	br_ec_public_key pk;
	size_t pub_len = br_ec_compute_pub(ec, &pk, pub_buf, &sk);
	if (pub_len == 0)
		return JS_ThrowTypeError(ctx, "ECDH public key computation failed");

	JSValue result = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, result, "publicKey",
		JS_NewArrayBufferCopy(ctx, pk.q, pk.qlen));
	JS_SetPropertyStr(ctx, result, "privateKey",
		JS_NewArrayBufferCopy(ctx, sk.x, sk.xlen));
	return result;
}

/*
 * ecdhComputeSecret(curve, privKey, pubKey) → ArrayBuffer (shared secret)
 */
static JSValue js_ecdhComputeSecret(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
	const char *curve_name = JS_ToCString(ctx, argv[0]);
	if (!curve_name) return JS_EXCEPTION;
	int curve = curve_from_name(curve_name);
	JS_FreeCString(ctx, curve_name);
	if (curve < 0)
		return JS_ThrowTypeError(ctx, "unsupported curve");

	size_t priv_len, pub_len;
	uint8_t *priv = JS_GetArrayBuffer(ctx, &priv_len, argv[1]);
	if (!priv) return JS_EXCEPTION;
	uint8_t *pub = JS_GetArrayBuffer(ctx, &pub_len, argv[2]);
	if (!pub) return JS_EXCEPTION;

	/* Make a copy of pub since mul() modifies it in place */
	uint8_t *pub_copy = js_malloc(ctx, pub_len);
	if (!pub_copy) return JS_EXCEPTION;
	memcpy(pub_copy, pub, pub_len);

	const br_ec_impl *ec = br_ec_get_default();
	uint32_t ok = ec->mul(pub_copy, pub_len, priv, priv_len, curve);
	if (!ok) {
		js_free(ctx, pub_copy);
		return JS_ThrowTypeError(ctx, "ECDH computation failed");
	}

	/* Extract x-coordinate: skip format byte for non-x25519 curves */
	size_t xoff_len;
	size_t xoff = ec->xoff(curve, &xoff_len);

	JSValue result = JS_NewArrayBufferCopy(ctx, pub_copy + xoff, xoff_len);
	js_free(ctx, pub_copy);
	return result;
}

/* Hash metadata used by ECDSA signing. */
static const unsigned char *hash_oid_for_name(const char *name,
                                               const br_hash_class **out_hc,
                                               size_t *out_hash_len)
{
	if (strcmp(name, "sha1") == 0) {
		*out_hc = &br_sha1_vtable;
		*out_hash_len = br_sha1_SIZE;
		return BR_HASH_OID_SHA1;
	}
	if (strcmp(name, "sha256") == 0) {
		*out_hc = &br_sha256_vtable;
		*out_hash_len = br_sha256_SIZE;
		return BR_HASH_OID_SHA256;
	}
	if (strcmp(name, "sha384") == 0) {
		*out_hc = &br_sha384_vtable;
		*out_hash_len = br_sha384_SIZE;
		return BR_HASH_OID_SHA384;
	}
	if (strcmp(name, "sha512") == 0) {
		*out_hc = &br_sha512_vtable;
		*out_hash_len = br_sha512_SIZE;
		return BR_HASH_OID_SHA512;
	}
	return NULL;
}

/* --------------------------------------------------------------------------
 * ECDSA sign/verify via BearSSL
 *
 * ecdsaSign(hashAlgo, hash, curve, privKey)       → ArrayBuffer (raw signature)
 * ecdsaVerify(hashAlgo, hash, sig, curve, pubKey)  → boolean
 * -------------------------------------------------------------------------- */

static JSValue js_ecdsaSign(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	const char *algo_name = JS_ToCString(ctx, argv[0]);
	if (!algo_name) return JS_EXCEPTION;
	const br_hash_class *hc; size_t hash_len;
	const unsigned char *oid = hash_oid_for_name(algo_name, &hc, &hash_len);
	JS_FreeCString(ctx, algo_name);
	if (!oid) return JS_ThrowTypeError(ctx, "unsupported hash for ECDSA");

	size_t digest_len;
	uint8_t *digest = JS_GetArrayBuffer(ctx, &digest_len, argv[1]);
	if (!digest) return JS_EXCEPTION;

	const char *curve_name = JS_ToCString(ctx, argv[2]);
	if (!curve_name) return JS_EXCEPTION;
	int curve = curve_from_name(curve_name);
	JS_FreeCString(ctx, curve_name);
	if (curve < 0) return JS_ThrowTypeError(ctx, "unsupported curve");

	size_t priv_len;
	uint8_t *priv = JS_GetArrayBuffer(ctx, &priv_len, argv[3]);
	if (!priv) return JS_EXCEPTION;

	br_ec_private_key sk;
	sk.curve = curve;
	sk.x = priv;
	sk.xlen = priv_len;

	const br_ec_impl *ec = br_ec_get_default();
	uint8_t sig[132]; /* max ECDSA sig size for P-521 */
	size_t sig_len = br_ecdsa_i31_sign_raw(ec, hc, digest, &sk, sig);
	if (sig_len == 0)
		return JS_ThrowTypeError(ctx, "ECDSA signing failed");

	return JS_NewArrayBufferCopy(ctx, sig, sig_len);
}

static JSValue js_ecdsaVerify(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	const char *algo_name = JS_ToCString(ctx, argv[0]);
	if (!algo_name) return JS_EXCEPTION;
	const br_hash_class *hc; size_t hash_len;
	const unsigned char *oid = hash_oid_for_name(algo_name, &hc, &hash_len);
	JS_FreeCString(ctx, algo_name);
	if (!oid) return JS_ThrowTypeError(ctx, "unsupported hash for ECDSA");

	size_t digest_len;
	uint8_t *digest = JS_GetArrayBuffer(ctx, &digest_len, argv[1]);
	if (!digest) return JS_EXCEPTION;

	size_t sig_len;
	uint8_t *sig = JS_GetArrayBuffer(ctx, &sig_len, argv[2]);
	if (!sig) return JS_EXCEPTION;

	const char *curve_name = JS_ToCString(ctx, argv[3]);
	if (!curve_name) return JS_EXCEPTION;
	int curve = curve_from_name(curve_name);
	JS_FreeCString(ctx, curve_name);
	if (curve < 0) return JS_ThrowTypeError(ctx, "unsupported curve");

	size_t pub_len;
	uint8_t *pub = JS_GetArrayBuffer(ctx, &pub_len, argv[4]);
	if (!pub) return JS_EXCEPTION;

	br_ec_public_key pk;
	pk.curve = curve;
	pk.q = pub;
	pk.qlen = pub_len;

	const br_ec_impl *ec = br_ec_get_default();
	uint32_t ok = br_ecdsa_i31_vrfy_raw(ec, digest, digest_len, &pk, sig, sig_len);
	return JS_NewBool(ctx, ok == 1);
}

static const JSCFunctionListEntry ecc_exports[] = {
	JS_CFUNC_DEF("ecdhGenerateKeys", 1, js_ecdhGenerateKeys),
	JS_CFUNC_DEF("ecdhComputeSecret", 3, js_ecdhComputeSecret),
	JS_CFUNC_DEF("ecdsaSign", 4, js_ecdsaSign),
	JS_CFUNC_DEF("ecdsaVerify", 5, js_ecdsaVerify),
};

const qn_crypto_component_t qn_crypto_ecc_component = {
	.exports = ecc_exports,
	.export_count = QN_CRYPTO_COUNT_OF(ecc_exports),
	.init_classes = NULL,
};
