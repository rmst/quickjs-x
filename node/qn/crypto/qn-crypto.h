#ifndef QN_CRYPTO_H
#define QN_CRYPTO_H

#include "quickjs.h"

#define QN_CRYPTO_COUNT_OF(array) ((int)(sizeof(array) / sizeof((array)[0])))

typedef struct {
	const JSCFunctionListEntry *exports;
	int export_count;
	int (*init_classes)(JSContext *ctx);
} qn_crypto_component_t;

extern const qn_crypto_component_t qn_crypto_tls_component;
extern const qn_crypto_component_t qn_crypto_digest_component;
extern const qn_crypto_component_t qn_crypto_cipher_component;
extern const qn_crypto_component_t qn_crypto_ecc_component;

#endif
