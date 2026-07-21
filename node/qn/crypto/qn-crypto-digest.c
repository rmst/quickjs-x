/*
 * Hash and HMAC bindings for qn:crypto.
 */

#include <stdlib.h>
#include <string.h>

#include "bearssl.h"
#include "quickjs.h"

#include "qn-crypto.h"
#include "qn-crypto-util.h"

/* --------------------------------------------------------------------------
 * Generic hash streaming API via BearSSL
 *
 * hashInit(algorithm)       → opaque handle  (algorithm: "md5"|"sha1"|"sha256"|"sha384"|"sha512")
 * hashUpdate(handle, data)  — feed string, ArrayBuffer, or TypedArray
 * hashOut(handle)           → ArrayBuffer, does not consume context
 * -------------------------------------------------------------------------- */

/* Hash algorithm descriptor */
typedef struct {
	const char *name;
	const br_hash_class *vtable;
	size_t ctx_size;
	size_t out_size;
} hash_algo_t;

static const hash_algo_t hash_algos[] = {
	{ "md5",    &br_md5_vtable,    sizeof(br_md5_context),    br_md5_SIZE },
	{ "sha1",   &br_sha1_vtable,   sizeof(br_sha1_context),   br_sha1_SIZE },
	{ "sha256", &br_sha256_vtable, sizeof(br_sha256_context), br_sha256_SIZE },
	{ "sha384", &br_sha384_vtable, sizeof(br_sha384_context), br_sha384_SIZE },
	{ "sha512", &br_sha512_vtable, sizeof(br_sha512_context), br_sha512_SIZE },
};
#define NUM_HASH_ALGOS QN_CRYPTO_COUNT_OF(hash_algos)

static const hash_algo_t *find_hash_algo(const char *name)
{
	for (size_t i = 0; i < NUM_HASH_ALGOS; i++)
		if (strcmp(hash_algos[i].name, name) == 0)
			return &hash_algos[i];
	return NULL;
}

typedef struct {
	const hash_algo_t *algo;
	br_hash_compat_context hc;
} hash_ctx_t;

static JSClassID hash_class_id;

static void hash_finalizer(JSRuntime *rt, JSValue val) {
	hash_ctx_t *hc = JS_GetOpaque(val, hash_class_id);
	if (hc) js_free_rt(rt, hc);
}

static JSClassDef hash_class = { "HashContext", .finalizer = hash_finalizer };

static JSValue js_hashInit(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	const char *name = JS_ToCString(ctx, argv[0]);
	if (!name) return JS_EXCEPTION;
	const hash_algo_t *algo = find_hash_algo(name);
	JS_FreeCString(ctx, name);
	if (!algo)
		return JS_ThrowTypeError(ctx, "unsupported hash algorithm");

	hash_ctx_t *hc = js_mallocz(ctx, sizeof(*hc));
	if (!hc) return JS_EXCEPTION;
	hc->algo = algo;
	algo->vtable->init(&hc->hc.vtable);

	JSValue obj = JS_NewObjectClass(ctx, hash_class_id);
	if (JS_IsException(obj)) { js_free(ctx, hc); return obj; }
	JS_SetOpaque(obj, hc);
	return obj;
}

static JSValue js_hashUpdate(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	hash_ctx_t *hc = JS_GetOpaque2(ctx, argv[0], hash_class_id);
	if (!hc) return JS_EXCEPTION;

	size_t len; int is_string; JSValue tmp;
	const uint8_t *data = qn_crypto_get_bytes(ctx, argv[1], &len, &is_string, &tmp);
	if (!data) return JS_EXCEPTION;
	hc->algo->vtable->update(&hc->hc.vtable, data, len);
	if (is_string) JS_FreeCString(ctx, (const char *)data);
	JS_FreeValue(ctx, tmp);
	return JS_UNDEFINED;
}

static JSValue js_hashOut(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
	hash_ctx_t *hc = JS_GetOpaque2(ctx, argv[0], hash_class_id);
	if (!hc) return JS_EXCEPTION;
	uint8_t out[64]; /* max hash size (sha512) */
	hc->algo->vtable->out(&hc->hc.vtable, out);
	return JS_NewArrayBufferCopy(ctx, out, hc->algo->out_size);
}

/* --------------------------------------------------------------------------
 * HMAC streaming API via BearSSL
 *
 * hmacInit(algorithm, key)  → opaque handle
 * hmacUpdate(handle, data)  — feed data
 * hmacOut(handle)           → ArrayBuffer
 * -------------------------------------------------------------------------- */

typedef struct {
	br_hmac_context hc;
	size_t out_size;
} hmac_ctx_t;

static JSClassID hmac_class_id;

static void hmac_finalizer(JSRuntime *rt, JSValue val) {
	hmac_ctx_t *hc = JS_GetOpaque(val, hmac_class_id);
	if (hc) js_free_rt(rt, hc);
}

static JSClassDef hmac_class = { "HMACContext", .finalizer = hmac_finalizer };

static JSValue js_hmacInit(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	const char *name = JS_ToCString(ctx, argv[0]);
	if (!name) return JS_EXCEPTION;
	const hash_algo_t *algo = find_hash_algo(name);
	JS_FreeCString(ctx, name);
	if (!algo)
		return JS_ThrowTypeError(ctx, "unsupported HMAC algorithm");

	size_t key_len; int is_string; JSValue tmp;
	const uint8_t *key = qn_crypto_get_bytes(ctx, argv[1], &key_len, &is_string, &tmp);
	if (!key) return JS_EXCEPTION;

	hmac_ctx_t *hc = js_mallocz(ctx, sizeof(*hc));
	if (!hc) {
		if (is_string) JS_FreeCString(ctx, (const char *)key);
		JS_FreeValue(ctx, tmp);
		return JS_EXCEPTION;
	}

	br_hmac_key_context kc;
	br_hmac_key_init(&kc, algo->vtable, key, key_len);
	br_hmac_init(&hc->hc, &kc, 0); /* 0 = full output length */
	hc->out_size = algo->out_size;

	if (is_string) JS_FreeCString(ctx, (const char *)key);
	JS_FreeValue(ctx, tmp);

	JSValue obj = JS_NewObjectClass(ctx, hmac_class_id);
	if (JS_IsException(obj)) { js_free(ctx, hc); return obj; }
	JS_SetOpaque(obj, hc);
	return obj;
}

static JSValue js_hmacUpdate(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	hmac_ctx_t *hc = JS_GetOpaque2(ctx, argv[0], hmac_class_id);
	if (!hc) return JS_EXCEPTION;

	size_t len; int is_string; JSValue tmp;
	const uint8_t *data = qn_crypto_get_bytes(ctx, argv[1], &len, &is_string, &tmp);
	if (!data) return JS_EXCEPTION;
	br_hmac_update(&hc->hc, data, len);
	if (is_string) JS_FreeCString(ctx, (const char *)data);
	JS_FreeValue(ctx, tmp);
	return JS_UNDEFINED;
}

static JSValue js_hmacOut(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
	hmac_ctx_t *hc = JS_GetOpaque2(ctx, argv[0], hmac_class_id);
	if (!hc) return JS_EXCEPTION;
	uint8_t out[64];
	size_t out_len = br_hmac_out(&hc->hc, out);
	return JS_NewArrayBufferCopy(ctx, out, out_len);
}


/* Backward-compatible aliases for existing SHA-256/SHA-1 API */
static JSValue js_sha256Init(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	JSValue args[] = { JS_NewString(ctx, "sha256") };
	JSValue r = js_hashInit(ctx, this_val, 1, args);
	JS_FreeValue(ctx, args[0]);
	return r;
}
static JSValue js_sha1Init(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	JSValue args[] = { JS_NewString(ctx, "sha1") };
	JSValue r = js_hashInit(ctx, this_val, 1, args);
	JS_FreeValue(ctx, args[0]);
	return r;
}

static const JSCFunctionListEntry digest_exports[] = {
	JS_CFUNC_DEF("sha256Init", 0, js_sha256Init),
	JS_CFUNC_DEF("sha256Update", 2, js_hashUpdate),
	JS_CFUNC_DEF("sha256Out", 1, js_hashOut),
	JS_CFUNC_DEF("sha1Init", 0, js_sha1Init),
	JS_CFUNC_DEF("sha1Update", 2, js_hashUpdate),
	JS_CFUNC_DEF("sha1Out", 1, js_hashOut),
	JS_CFUNC_DEF("hashInit", 1, js_hashInit),
	JS_CFUNC_DEF("hashUpdate", 2, js_hashUpdate),
	JS_CFUNC_DEF("hashOut", 1, js_hashOut),
	JS_CFUNC_DEF("hmacInit", 2, js_hmacInit),
	JS_CFUNC_DEF("hmacUpdate", 2, js_hmacUpdate),
	JS_CFUNC_DEF("hmacOut", 1, js_hmacOut),
};

static int init_digest_classes(JSContext *ctx)
{
	JSRuntime *rt = JS_GetRuntime(ctx);

	JS_NewClassID(&hash_class_id);
	if (JS_NewClass(rt, hash_class_id, &hash_class) < 0)
		return -1;

	JS_NewClassID(&hmac_class_id);
	return JS_NewClass(rt, hmac_class_id, &hmac_class);
}

const qn_crypto_component_t qn_crypto_digest_component = {
	.exports = digest_exports,
	.export_count = QN_CRYPTO_COUNT_OF(digest_exports),
	.init_classes = init_digest_classes,
};
