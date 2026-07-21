#ifndef QN_CRYPTO_PEM_H
#define QN_CRYPTO_PEM_H

#include <stddef.h>

#include "bearssl.h"

typedef struct {
	br_x509_certificate *certificates;
	unsigned char **buffers;
	size_t length;
} qn_crypto_cert_chain_t;

int qn_crypto_load_trust_anchors_file(const char *path);
const br_x509_trust_anchor *qn_crypto_get_trust_anchors(size_t *count);

/* out must be empty and zero-initialized. On success, it owns all certificate buffers; release them with qn_crypto_cert_chain_clear before reuse or destruction. */
int qn_crypto_load_cert_chain_file(const char *path,
	qn_crypto_cert_chain_t *out);
int qn_crypto_load_cert_chain_pem(const unsigned char *data, size_t len,
	qn_crypto_cert_chain_t *out);
void qn_crypto_cert_chain_clear(qn_crypto_cert_chain_t *chain);

int qn_crypto_load_private_key_file(const char *path,
	br_skey_decoder_context *out);
int qn_crypto_load_private_key_pem(const unsigned char *data, size_t len,
	br_skey_decoder_context *out);

#endif
