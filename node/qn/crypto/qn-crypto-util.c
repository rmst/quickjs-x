/*
 * Shared allocation and QuickJS byte-value helpers for qn:crypto.
 */

#include <stdlib.h>
#include <string.h>

#include "qn-crypto-util.h"

void qn_crypto_byte_vec_init(qn_crypto_byte_vec_t *v)
{
	v->data = NULL;
	v->len = 0;
	v->cap = 0;
	v->failed = 0;
}

int qn_crypto_byte_vec_append(qn_crypto_byte_vec_t *v, const void *buf, size_t len)
{
	if (v->failed)
		return 0;
	if (len == 0)
		return 1;
	if (len > (size_t)-1 - v->len) {
		v->failed = 1;
		return 0;
	}
	size_t needed = v->len + len;
	if (needed > v->cap) {
		size_t new_cap = v->cap ? v->cap * 2 : 256;
		if (new_cap < v->cap)
			new_cap = needed;
		while (new_cap < needed) {
			if (new_cap > (size_t)-1 / 2) {
				new_cap = needed;
				break;
			}
			new_cap *= 2;
		}
		unsigned char *p = realloc(v->data, new_cap);
		if (!p) {
			v->failed = 1;
			return 0;
		}
		v->data = p;
		v->cap = new_cap;
	}
	memcpy(v->data + v->len, buf, len);
	v->len += len;
	return 1;
}

void qn_crypto_byte_vec_append_callback(void *ctx, const void *buf, size_t len)
{
	(void)qn_crypto_byte_vec_append(ctx, buf, len);
}

int qn_crypto_byte_vec_failed(const qn_crypto_byte_vec_t *v)
{
	return v->failed;
}

unsigned char *qn_crypto_byte_vec_take(qn_crypto_byte_vec_t *v, size_t *out_len)
{
	if (v->failed) {
		free(v->data);
		*out_len = 0;
		qn_crypto_byte_vec_init(v);
		return NULL;
	}
	unsigned char *d = v->data;
	*out_len = v->len;
	v->data = NULL;
	v->len = 0;
	v->cap = 0;
	v->failed = 0;
	return d;
}

void qn_crypto_byte_vec_clear(qn_crypto_byte_vec_t *v)
{
	free(v->data);
	v->data = NULL;
	v->len = 0;
	v->cap = 0;
	v->failed = 0;
}

/* Extract borrowed bytes from an ArrayBuffer, TypedArray, or string. See qn-crypto-util.h for the caller's cleanup obligations. */
const uint8_t *qn_crypto_get_bytes(JSContext *ctx, JSValueConst val,
                                    size_t *out_len, int *is_string,
                                    JSValue *tmp_abuf)
{
	*is_string = 0;
	*tmp_abuf = JS_UNDEFINED;

	/* Try ArrayBuffer */
	size_t len;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &len, val);
	if (buf) { *out_len = len; return buf; }
	JS_FreeValue(ctx, JS_GetException(ctx));

	/* Try TypedArray */
	size_t offset, blen;
	*tmp_abuf = JS_GetTypedArrayBuffer(ctx, val, &offset, &blen, NULL);
	if (!JS_IsException(*tmp_abuf)) {
		buf = JS_GetArrayBuffer(ctx, &len, *tmp_abuf);
		if (buf) { *out_len = blen; return buf + offset; }
	} else {
		JS_FreeValue(ctx, JS_GetException(ctx));
		*tmp_abuf = JS_UNDEFINED;
	}

	/* Try string */
	const char *str = JS_ToCStringLen(ctx, &len, val);
	if (str) { *out_len = len; *is_string = 1; return (const uint8_t *)str; }
	return NULL;
}
