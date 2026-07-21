#ifndef QN_CRYPTO_UTIL_H
#define QN_CRYPTO_UTIL_H

#include <stddef.h>
#include <stdint.h>

#include "quickjs.h"

typedef struct {
	unsigned char *data;
	size_t len;
	size_t cap;
	int failed;
} qn_crypto_byte_vec_t;

void qn_crypto_byte_vec_init(qn_crypto_byte_vec_t *vec);
int qn_crypto_byte_vec_append(qn_crypto_byte_vec_t *vec,
	const void *data, size_t len);
void qn_crypto_byte_vec_append_callback(void *ctx,
	const void *data, size_t len);
int qn_crypto_byte_vec_failed(const qn_crypto_byte_vec_t *vec);

/* Transfers the buffer to the caller and resets vec. The caller owns the returned buffer and must free it. */
unsigned char *qn_crypto_byte_vec_take(qn_crypto_byte_vec_t *vec,
	size_t *out_len);
void qn_crypto_byte_vec_clear(qn_crypto_byte_vec_t *vec);

/* Returns bytes borrowed from value, tmp_array_buffer, or a temporary C string. The caller must always release tmp_array_buffer with JS_FreeValue and, when is_string is set, release the returned pointer with JS_FreeCString. */
const uint8_t *qn_crypto_get_bytes(JSContext *ctx, JSValueConst value,
	size_t *out_len, int *is_string, JSValue *tmp_array_buffer);

#endif
