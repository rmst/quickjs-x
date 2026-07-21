/*
 * Symmetric cipher and AEAD bindings for qn:crypto.
 */

#include <stdlib.h>
#include <string.h>

#include "bearssl.h"
#include "quickjs.h"

#include "qn-crypto.h"
#include "qn-crypto-util.h"

/* --------------------------------------------------------------------------
 * Symmetric cipher API via BearSSL
 *
 * cipherInit(algo, encrypt, key, iv)  → opaque handle
 * cipherUpdate(handle, data)          → ArrayBuffer (processed data)
 * cipherSetAAD(handle, data)          — for GCM/ChaCha20-Poly1305
 * cipherGetAuthTag(handle)            → ArrayBuffer(16)
 * cipherSetAuthTag(handle, tag)       — for decryption verification
 * -------------------------------------------------------------------------- */

enum cipher_type {
	CIPHER_AES_CTR,
	CIPHER_AES_GCM,
	CIPHER_CHACHA20_POLY1305,
};

typedef struct {
	enum cipher_type type;
	int encrypt;
	union {
		struct {
			br_aes_ct_ctr_keys ctr;
			uint8_t iv[16]; /* 16 bytes: 4-byte fixed + 8-byte counter + 4-byte block counter */
			uint32_t cc;
		} aes_ctr;
		struct {
			br_aes_ct_ctr_keys ctr;
			br_gcm_context gcm;
			int flipped; /* whether aad_inject→flip has happened */
			uint8_t tag[16];
			int has_tag; /* set after getAuthTag or setAuthTag */
		} aes_gcm;
		struct {
			uint8_t key[32];
			uint8_t iv[12];
			qn_crypto_byte_vec_t aad;
			qn_crypto_byte_vec_t data;
		} chapoly;
	} u;
} cipher_ctx_t;

static JSClassID cipher_class_id;

static void cipher_finalizer(JSRuntime *rt, JSValue val) {
	cipher_ctx_t *cc = JS_GetOpaque(val, cipher_class_id);
	if (cc) {
		if (cc->type == CIPHER_CHACHA20_POLY1305) {
			qn_crypto_byte_vec_clear(&cc->u.chapoly.aad);
			qn_crypto_byte_vec_clear(&cc->u.chapoly.data);
		}
		js_free_rt(rt, cc);
	}
}

static JSClassDef cipher_class = { "CipherContext", .finalizer = cipher_finalizer };

/*
 * cipherInit(algo, encrypt, key, iv)
 *   algo: "aes-128-ctr" | "aes-192-ctr" | "aes-256-ctr" |
 *         "aes-128-gcm" | "aes-256-gcm" | "chacha20-poly1305"
 */
static JSValue js_cipherInit(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	const char *algo = JS_ToCString(ctx, argv[0]);
	if (!algo) return JS_EXCEPTION;

	int encrypt;
	if (JS_ToInt32(ctx, &encrypt, argv[1])) {
		JS_FreeCString(ctx, algo);
		return JS_EXCEPTION;
	}

	size_t key_len; int ks; JSValue ktmp;
	const uint8_t *key = qn_crypto_get_bytes(ctx, argv[2], &key_len, &ks, &ktmp);
	if (!key) { JS_FreeCString(ctx, algo); return JS_EXCEPTION; }

	size_t iv_len; int ivs; JSValue ivtmp;
	const uint8_t *iv = qn_crypto_get_bytes(ctx, argv[3], &iv_len, &ivs, &ivtmp);
	if (!iv) {
		if (ks) JS_FreeCString(ctx, (const char *)key);
		JS_FreeValue(ctx, ktmp);
		JS_FreeCString(ctx, algo);
		return JS_EXCEPTION;
	}

	cipher_ctx_t *cc = js_mallocz(ctx, sizeof(*cc));
	if (!cc) goto oom;

	if (strncmp(algo, "aes-", 4) == 0 && strstr(algo, "-ctr")) {
		/* AES-CTR: key must be 16/24/32 bytes, IV must be 16 bytes */
		if ((key_len != 16 && key_len != 24 && key_len != 32) || iv_len != 16) {
			js_free(ctx, cc);
			if (ks) JS_FreeCString(ctx, (const char *)key);
			if (ivs) JS_FreeCString(ctx, (const char *)iv);
			JS_FreeValue(ctx, ktmp); JS_FreeValue(ctx, ivtmp);
			JS_FreeCString(ctx, algo);
			return JS_ThrowRangeError(ctx, "AES-CTR: invalid key/IV length");
		}
		cc->type = CIPHER_AES_CTR;
		cc->encrypt = encrypt;
		br_aes_ct_ctr_init(&cc->u.aes_ctr.ctr, key, key_len);
		memcpy(cc->u.aes_ctr.iv, iv, 16);
		cc->u.aes_ctr.cc = 0;
	} else if (strncmp(algo, "aes-", 4) == 0 && strstr(algo, "-gcm")) {
		/* AES-GCM: key 16/32 bytes, IV typically 12 bytes */
		if ((key_len != 16 && key_len != 32) || iv_len != 12) {
			js_free(ctx, cc);
			if (ks) JS_FreeCString(ctx, (const char *)key);
			if (ivs) JS_FreeCString(ctx, (const char *)iv);
			JS_FreeValue(ctx, ktmp); JS_FreeValue(ctx, ivtmp);
			JS_FreeCString(ctx, algo);
			return JS_ThrowRangeError(ctx, "AES-GCM: invalid key/IV length");
		}
		cc->type = CIPHER_AES_GCM;
		cc->encrypt = encrypt;
		br_aes_ct_ctr_init(&cc->u.aes_gcm.ctr, key, key_len);
		br_gcm_init(&cc->u.aes_gcm.gcm, &cc->u.aes_gcm.ctr.vtable,
		            br_ghash_ctmul);
		br_gcm_reset(&cc->u.aes_gcm.gcm, iv, iv_len);
		cc->u.aes_gcm.flipped = 0;
		cc->u.aes_gcm.has_tag = 0;
	} else if (strcmp(algo, "chacha20-poly1305") == 0) {
		if (key_len != 32 || iv_len != 12) {
			js_free(ctx, cc);
			if (ks) JS_FreeCString(ctx, (const char *)key);
			if (ivs) JS_FreeCString(ctx, (const char *)iv);
			JS_FreeValue(ctx, ktmp); JS_FreeValue(ctx, ivtmp);
			JS_FreeCString(ctx, algo);
			return JS_ThrowRangeError(ctx, "ChaCha20-Poly1305: key must be 32 bytes, IV 12 bytes");
		}
		cc->type = CIPHER_CHACHA20_POLY1305;
		cc->encrypt = encrypt;
		memcpy(cc->u.chapoly.key, key, 32);
		memcpy(cc->u.chapoly.iv, iv, 12);
		qn_crypto_byte_vec_init(&cc->u.chapoly.aad);
		qn_crypto_byte_vec_init(&cc->u.chapoly.data);
	} else {
		js_free(ctx, cc);
		if (ks) JS_FreeCString(ctx, (const char *)key);
		if (ivs) JS_FreeCString(ctx, (const char *)iv);
		JS_FreeValue(ctx, ktmp); JS_FreeValue(ctx, ivtmp);
		JS_FreeCString(ctx, algo);
		return JS_ThrowTypeError(ctx, "unsupported cipher algorithm");
	}

	if (ks) JS_FreeCString(ctx, (const char *)key);
	if (ivs) JS_FreeCString(ctx, (const char *)iv);
	JS_FreeValue(ctx, ktmp); JS_FreeValue(ctx, ivtmp);
	JS_FreeCString(ctx, algo);

	JSValue obj = JS_NewObjectClass(ctx, cipher_class_id);
	if (JS_IsException(obj)) { js_free(ctx, cc); return obj; }
	JS_SetOpaque(obj, cc);
	return obj;

oom:
	if (ks) JS_FreeCString(ctx, (const char *)key);
	if (ivs) JS_FreeCString(ctx, (const char *)iv);
	JS_FreeValue(ctx, ktmp); JS_FreeValue(ctx, ivtmp);
	JS_FreeCString(ctx, algo);
	return JS_EXCEPTION;
}

/* cipherUpdate(handle, data) → ArrayBuffer */
static JSValue js_cipherUpdate(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	cipher_ctx_t *cc = JS_GetOpaque2(ctx, argv[0], cipher_class_id);
	if (!cc) return JS_EXCEPTION;

	size_t len; int is_string; JSValue tmp;
	const uint8_t *data = qn_crypto_get_bytes(ctx, argv[1], &len, &is_string, &tmp);
	if (!data) return JS_EXCEPTION;

	if (cc->type == CIPHER_AES_CTR) {
		uint8_t *out = js_malloc(ctx, len);
		if (!out) goto cleanup;
		memcpy(out, data, len);
		/* AES-CTR encrypt and decrypt are the same operation */
		cc->u.aes_ctr.cc = br_aes_ct_ctr_run(&cc->u.aes_ctr.ctr,
			cc->u.aes_ctr.iv, cc->u.aes_ctr.cc, out, len);
		if (is_string) JS_FreeCString(ctx, (const char *)data);
		JS_FreeValue(ctx, tmp);
		JSValue ab = JS_NewArrayBuffer(ctx, out, len,
			(void (*)(JSRuntime *, void *, void *))js_free_rt, NULL, 0);
		if (JS_IsException(ab)) js_free(ctx, out);
		return ab;
	} else if (cc->type == CIPHER_AES_GCM) {
		if (!cc->u.aes_gcm.flipped) {
			br_gcm_flip(&cc->u.aes_gcm.gcm);
			cc->u.aes_gcm.flipped = 1;
		}
		uint8_t *out = js_malloc(ctx, len);
		if (!out) goto cleanup;
		memcpy(out, data, len);
		br_gcm_run(&cc->u.aes_gcm.gcm, cc->encrypt, out, len);
		if (is_string) JS_FreeCString(ctx, (const char *)data);
		JS_FreeValue(ctx, tmp);
		JSValue ab = JS_NewArrayBuffer(ctx, out, len,
			(void (*)(JSRuntime *, void *, void *))js_free_rt, NULL, 0);
		if (JS_IsException(ab)) js_free(ctx, out);
		return ab;
	} else if (cc->type == CIPHER_CHACHA20_POLY1305) {
		/* Accumulate data; process in cipherFinal */
		if (!qn_crypto_byte_vec_append(&cc->u.chapoly.data, data, len)) {
			if (is_string) JS_FreeCString(ctx, (const char *)data);
			JS_FreeValue(ctx, tmp);
			return JS_ThrowOutOfMemory(ctx);
		}
		if (is_string) JS_FreeCString(ctx, (const char *)data);
		JS_FreeValue(ctx, tmp);
		return JS_UNDEFINED; /* data returned from cipherFinal */
	}
cleanup:
	if (is_string) JS_FreeCString(ctx, (const char *)data);
	JS_FreeValue(ctx, tmp);
	return JS_EXCEPTION;
}

/* cipherSetAAD(handle, data) */
static JSValue js_cipherSetAAD(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	cipher_ctx_t *cc = JS_GetOpaque2(ctx, argv[0], cipher_class_id);
	if (!cc) return JS_EXCEPTION;

	size_t len; int is_string; JSValue tmp;
	const uint8_t *data = qn_crypto_get_bytes(ctx, argv[1], &len, &is_string, &tmp);
	if (!data) return JS_EXCEPTION;

	if (cc->type == CIPHER_AES_GCM) {
		br_gcm_aad_inject(&cc->u.aes_gcm.gcm, data, len);
	} else if (cc->type == CIPHER_CHACHA20_POLY1305) {
		if (!qn_crypto_byte_vec_append(&cc->u.chapoly.aad, data, len)) {
			if (is_string) JS_FreeCString(ctx, (const char *)data);
			JS_FreeValue(ctx, tmp);
			return JS_ThrowOutOfMemory(ctx);
		}
	}

	if (is_string) JS_FreeCString(ctx, (const char *)data);
	JS_FreeValue(ctx, tmp);
	return JS_UNDEFINED;
}

/* cipherFinal(handle) → ArrayBuffer (for chapoly: processed data; for others: empty) */
static JSValue js_cipherFinal(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	cipher_ctx_t *cc = JS_GetOpaque2(ctx, argv[0], cipher_class_id);
	if (!cc) return JS_EXCEPTION;

	if (cc->type == CIPHER_AES_GCM) {
		if (!cc->u.aes_gcm.flipped) {
			br_gcm_flip(&cc->u.aes_gcm.gcm);
			cc->u.aes_gcm.flipped = 1;
		}
		br_gcm_get_tag(&cc->u.aes_gcm.gcm, cc->u.aes_gcm.tag);
		cc->u.aes_gcm.has_tag = 1;
		return JS_NewArrayBufferCopy(ctx, NULL, 0);
	} else if (cc->type == CIPHER_CHACHA20_POLY1305) {
		if (qn_crypto_byte_vec_failed(&cc->u.chapoly.data) || qn_crypto_byte_vec_failed(&cc->u.chapoly.aad))
			return JS_ThrowOutOfMemory(ctx);
		size_t dlen = cc->u.chapoly.data.len;
		uint8_t *out = js_malloc(ctx, dlen > 0 ? dlen : 1);
		if (!out) return JS_EXCEPTION;
		if (dlen > 0)
			memcpy(out, cc->u.chapoly.data.data, dlen);

		/* BearSSL poly1305 does encrypt+MAC or decrypt+verify in one call */
		uint8_t tag[16];
		br_poly1305_ctmul_run(cc->u.chapoly.key, cc->u.chapoly.iv,
			out, dlen,
			cc->u.chapoly.aad.data, cc->u.chapoly.aad.len,
			tag, br_chacha20_ct_run, cc->encrypt);

		/* Store tag for getAuthTag */
		/* Reuse chapoly.aad to store the tag */
		qn_crypto_byte_vec_clear(&cc->u.chapoly.aad);
		qn_crypto_byte_vec_clear(&cc->u.chapoly.data);
		if (!qn_crypto_byte_vec_append(&cc->u.chapoly.aad, tag, 16)) {
			js_free(ctx, out);
			return JS_ThrowOutOfMemory(ctx);
		}

		JSValue ab = JS_NewArrayBuffer(ctx, out, dlen,
			(void (*)(JSRuntime *, void *, void *))js_free_rt, NULL, 0);
		if (JS_IsException(ab)) js_free(ctx, out);
		return ab;
	}
	return JS_NewArrayBufferCopy(ctx, NULL, 0);
}

/* cipherGetAuthTag(handle) → ArrayBuffer(16) */
static JSValue js_cipherGetAuthTag(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
	cipher_ctx_t *cc = JS_GetOpaque2(ctx, argv[0], cipher_class_id);
	if (!cc) return JS_EXCEPTION;

	if (cc->type == CIPHER_AES_GCM) {
		if (!cc->u.aes_gcm.has_tag) {
			br_gcm_get_tag(&cc->u.aes_gcm.gcm, cc->u.aes_gcm.tag);
			cc->u.aes_gcm.has_tag = 1;
		}
		return JS_NewArrayBufferCopy(ctx, cc->u.aes_gcm.tag, 16);
	} else if (cc->type == CIPHER_CHACHA20_POLY1305) {
		if (qn_crypto_byte_vec_failed(&cc->u.chapoly.aad))
			return JS_ThrowOutOfMemory(ctx);
		if (cc->u.chapoly.aad.len == 16)
			return JS_NewArrayBufferCopy(ctx, cc->u.chapoly.aad.data, 16);
	}
	return JS_ThrowTypeError(ctx, "getAuthTag: not an AEAD cipher");
}

/* cipherSetAuthTag(handle, tag) — for verifying decryption */
static JSValue js_cipherSetAuthTag(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
	cipher_ctx_t *cc = JS_GetOpaque2(ctx, argv[0], cipher_class_id);
	if (!cc) return JS_EXCEPTION;

	size_t len; int is_string; JSValue tmp;
	const uint8_t *tag = qn_crypto_get_bytes(ctx, argv[1], &len, &is_string, &tmp);
	if (!tag) return JS_EXCEPTION;

	int ok = 0;
	if (cc->type == CIPHER_AES_GCM && len == 16) {
		if (cc->u.aes_gcm.has_tag) {
			/* Tag already computed — constant-time compare against stored tag */
			uint32_t diff = 0;
			for (size_t i = 0; i < 16; i++)
				diff |= cc->u.aes_gcm.tag[i] ^ tag[i];
			ok = (diff == 0);
		} else {
			ok = br_gcm_check_tag(&cc->u.aes_gcm.gcm, tag);
		}
	} else if (cc->type == CIPHER_CHACHA20_POLY1305) {
		if (qn_crypto_byte_vec_failed(&cc->u.chapoly.aad)) {
			if (is_string) JS_FreeCString(ctx, (const char *)tag);
			JS_FreeValue(ctx, tmp);
			return JS_ThrowOutOfMemory(ctx);
		}
		if (len == 16 && cc->u.chapoly.aad.len == 16) {
			/* Constant-time compare */
			uint32_t diff = 0;
			for (size_t i = 0; i < 16; i++)
				diff |= cc->u.chapoly.aad.data[i] ^ tag[i];
			ok = (diff == 0);
		}
	}

	if (is_string) JS_FreeCString(ctx, (const char *)tag);
	JS_FreeValue(ctx, tmp);
	return JS_NewBool(ctx, ok);
}

static const JSCFunctionListEntry cipher_exports[] = {
	JS_CFUNC_DEF("cipherInit", 4, js_cipherInit),
	JS_CFUNC_DEF("cipherUpdate", 2, js_cipherUpdate),
	JS_CFUNC_DEF("cipherSetAAD", 2, js_cipherSetAAD),
	JS_CFUNC_DEF("cipherFinal", 1, js_cipherFinal),
	JS_CFUNC_DEF("cipherGetAuthTag", 1, js_cipherGetAuthTag),
	JS_CFUNC_DEF("cipherSetAuthTag", 2, js_cipherSetAuthTag),
};

static int init_cipher_classes(JSContext *ctx)
{
	JSRuntime *rt = JS_GetRuntime(ctx);

	JS_NewClassID(&cipher_class_id);
	return JS_NewClass(rt, cipher_class_id, &cipher_class);
}

const qn_crypto_component_t qn_crypto_cipher_component = {
	.exports = cipher_exports,
	.export_count = QN_CRYPTO_COUNT_OF(cipher_exports),
	.init_classes = init_cipher_classes,
};
