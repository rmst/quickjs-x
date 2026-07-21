/*
 * PEM decoding and certificate ownership for qn:crypto.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bearssl.h"
#include "qn-crypto-pem.h"
#include "qn-crypto-util.h"

/* Duplicate a blob */
static unsigned char *blob_dup(const unsigned char *src, size_t len)
{
	unsigned char *d = malloc(len);
	if (d) memcpy(d, src, len);
	return d;
}

/* ---- Trust anchor storage ---- */

typedef struct {
	br_x509_trust_anchor *anchors;
	size_t num_anchors;
	size_t cap_anchors;
} trust_anchor_store_t;

static trust_anchor_store_t trust_anchor_store;

/* Add a decoded certificate as trust anchor.
 * Takes ownership of dn_data. */
static void add_trust_anchor(trust_anchor_store_t *store,
                             br_x509_decoder_context *xc,
                             unsigned char *dn_data, size_t dn_len)
{
	br_x509_pkey *pkey = br_x509_decoder_get_pkey(xc);
	if (!pkey) {
		free(dn_data);
		return;
	}

	if (store->num_anchors >= store->cap_anchors) {
		size_t new_cap = store->cap_anchors ? store->cap_anchors * 2 : 128;
		br_x509_trust_anchor *p = realloc(store->anchors,
			new_cap * sizeof(br_x509_trust_anchor));
		if (!p) {
			free(dn_data);
			return;
		}
		store->anchors = p;
		store->cap_anchors = new_cap;
	}

	br_x509_trust_anchor *ta = &store->anchors[store->num_anchors];

	ta->dn.data = dn_data;
	ta->dn.len = dn_len;
	ta->flags = br_x509_decoder_isCA(xc) ? BR_X509_TA_CA : 0;

	ta->pkey.key_type = pkey->key_type;
	if (pkey->key_type == BR_KEYTYPE_RSA) {
		ta->pkey.key.rsa.n = blob_dup(pkey->key.rsa.n, pkey->key.rsa.nlen);
		ta->pkey.key.rsa.nlen = pkey->key.rsa.nlen;
		ta->pkey.key.rsa.e = blob_dup(pkey->key.rsa.e, pkey->key.rsa.elen);
		ta->pkey.key.rsa.elen = pkey->key.rsa.elen;
		if (!ta->pkey.key.rsa.n || !ta->pkey.key.rsa.e) {
			free(ta->pkey.key.rsa.n);
			free(ta->pkey.key.rsa.e);
			free(dn_data);
			return;
		}
	} else if (pkey->key_type == BR_KEYTYPE_EC) {
		ta->pkey.key.ec.curve = pkey->key.ec.curve;
		ta->pkey.key.ec.q = blob_dup(pkey->key.ec.q, pkey->key.ec.qlen);
		ta->pkey.key.ec.qlen = pkey->key.ec.qlen;
		if (!ta->pkey.key.ec.q) {
			free(dn_data);
			return;
		}
	} else {
		free(dn_data);
		return;
	}

	store->num_anchors++;
}

/* Load trust anchors from a PEM file. */

typedef struct {
	br_x509_decoder_context x509;
	qn_crypto_byte_vec_t dn;
} cert_decode_ctx_t;

static void cert_dn_append(void *ctx, const void *buf, size_t len)
{
	cert_decode_ctx_t *cc = ctx;
	qn_crypto_byte_vec_append_callback(&cc->dn, buf, len);
}

static void cert_data_push(void *ctx, const void *buf, size_t len)
{
	cert_decode_ctx_t *cc = ctx;
	br_x509_decoder_push(&cc->x509, buf, len);
}

static int load_ca_pem(trust_anchor_store_t *store, const char *path)
{
	FILE *f = fopen(path, "rb");
	if (!f) return -1;

	br_pem_decoder_context pem;
	cert_decode_ctx_t cc;
	unsigned char buf[8192];
	int in_cert = 0;
	size_t initial_count = store->num_anchors;

	br_pem_decoder_init(&pem);

	for (;;) {
		size_t n = fread(buf, 1, sizeof(buf), f);
		if (n == 0) break;

		size_t off = 0;
		while (off < n) {
			size_t pushed = br_pem_decoder_push(&pem, buf + off, n - off);
			off += pushed;

			int event = br_pem_decoder_event(&pem);
			if (event == BR_PEM_BEGIN_OBJ) {
				const char *name = br_pem_decoder_name(&pem);
				if (strcmp(name, "CERTIFICATE") == 0 ||
				    strcmp(name, "X509 CERTIFICATE") == 0 ||
				    strcmp(name, "TRUSTED CERTIFICATE") == 0) {
					qn_crypto_byte_vec_init(&cc.dn);
					br_x509_decoder_init(&cc.x509,
						cert_dn_append, &cc);
					br_pem_decoder_setdest(&pem,
						cert_data_push, &cc);
					in_cert = 1;
				} else {
					in_cert = 0;
					br_pem_decoder_setdest(&pem, NULL, NULL);
				}
			} else if (event == BR_PEM_END_OBJ && in_cert) {
				int err = br_x509_decoder_last_error(&cc.x509);
				if (qn_crypto_byte_vec_failed(&cc.dn)) {
					qn_crypto_byte_vec_clear(&cc.dn);
					fclose(f);
					return -1;
				} else if (err == 0) {
					size_t dn_len;
					unsigned char *dn_data = qn_crypto_byte_vec_take(&cc.dn, &dn_len);
					add_trust_anchor(store, &cc.x509,
						dn_data, dn_len);
				} else {
					qn_crypto_byte_vec_clear(&cc.dn);
				}
				in_cert = 0;
			} else if (event == BR_PEM_ERROR) {
				int failed = in_cert && qn_crypto_byte_vec_failed(&cc.dn);
				if (in_cert) qn_crypto_byte_vec_clear(&cc.dn);
				if (failed) {
					fclose(f);
					return -1;
				}
				break;
			}
		}
	}

	if (in_cert) {
		int failed = qn_crypto_byte_vec_failed(&cc.dn);
		qn_crypto_byte_vec_clear(&cc.dn);
		if (failed) {
			fclose(f);
			return -1;
		}
	}
	fclose(f);
	return (int)(store->num_anchors - initial_count);
}


/* ---- Certificate chain and private key loading from PEM ---- */

static unsigned char *read_file_data(const char *path, size_t *out_len)
{
	FILE *f = fopen(path, "rb");
	if (!f) return NULL;

	unsigned char *data = NULL;
	size_t len = 0, cap = 0;
	unsigned char buf[8192];

	for (;;) {
		size_t n = fread(buf, 1, sizeof(buf), f);
		if (n > 0) {
			if (len + n > cap) {
				size_t new_cap = cap ? cap * 2 : 8192;
				while (new_cap < len + n) new_cap *= 2;
				unsigned char *p = realloc(data, new_cap);
				if (!p) {
					free(data);
					fclose(f);
					return NULL;
				}
				data = p;
				cap = new_cap;
			}
			memcpy(data + len, buf, n);
			len += n;
		}
		if (n < sizeof(buf)) {
			if (ferror(f)) {
				free(data);
				fclose(f);
				return NULL;
			}
			break;
		}
	}

	fclose(f);
	*out_len = len;
	return data;
}

static int append_cert_to_chain(br_x509_certificate **chain,
                                unsigned char ***bufs,
                                size_t *num,
                                size_t *cap,
                                qn_crypto_byte_vec_t *current)
{
	if (*num >= *cap) {
		size_t new_cap = *cap ? *cap * 2 : 4;
		br_x509_certificate *nc = realloc(*chain,
			new_cap * sizeof(br_x509_certificate));
		if (!nc) return -1;
		*chain = nc;

		unsigned char **nb = realloc(*bufs,
			new_cap * sizeof(unsigned char *));
		if (!nb) return -1;
		*bufs = nb;
		*cap = new_cap;
	}

	size_t der_len;
	unsigned char *der = qn_crypto_byte_vec_take(current, &der_len);
	if (!der) return -1;
	(*bufs)[*num] = der;
	(*chain)[*num].data = der;
	(*chain)[*num].data_len = der_len;
	(*num)++;
	return 0;
}

static void free_cert_chain_parts(br_x509_certificate *chain,
                                  unsigned char **bufs,
                                  size_t num)
{
	for (size_t i = 0; i < num; i++)
		free(bufs[i]);
	free(bufs);
	free(chain);
}

static int load_cert_chain_pem_data(const unsigned char *data, size_t len,
                                    br_x509_certificate **out_chain,
                                    unsigned char ***out_bufs,
                                    size_t *out_len)
{
	br_pem_decoder_context pem;
	br_pem_decoder_init(&pem);
	int in_cert = 0;
	qn_crypto_byte_vec_t current;
	qn_crypto_byte_vec_init(&current);

	br_x509_certificate *chain = NULL;
	unsigned char **bufs = NULL;
	size_t num = 0, cap = 0;
	size_t off = 0;

	while (off < len) {
		size_t pushed = br_pem_decoder_push(&pem, data + off, len - off);
		off += pushed;

		int event = br_pem_decoder_event(&pem);
		if (event == BR_PEM_BEGIN_OBJ) {
			const char *name = br_pem_decoder_name(&pem);
			if (strcmp(name, "CERTIFICATE") == 0 ||
			    strcmp(name, "X509 CERTIFICATE") == 0 ||
			    strcmp(name, "TRUSTED CERTIFICATE") == 0) {
				qn_crypto_byte_vec_init(&current);
				br_pem_decoder_setdest(&pem, qn_crypto_byte_vec_append_callback, &current);
				in_cert = 1;
			} else {
				in_cert = 0;
				br_pem_decoder_setdest(&pem, NULL, NULL);
			}
		} else if (event == BR_PEM_END_OBJ && in_cert) {
			if (append_cert_to_chain(&chain, &bufs, &num, &cap,
			                         &current) < 0) {
				qn_crypto_byte_vec_clear(&current);
				goto fail;
			}
			in_cert = 0;
		} else if (event == BR_PEM_ERROR) {
			if (in_cert) qn_crypto_byte_vec_clear(&current);
			goto fail;
		}
	}

	if (in_cert) {
		qn_crypto_byte_vec_clear(&current);
		goto fail;
	}
	if (num == 0)
		goto fail;

	*out_chain = chain;
	*out_bufs = bufs;
	*out_len = num;
	return (int)num;

fail:
	free_cert_chain_parts(chain, bufs, num);
	return -1;
}

static int load_cert_chain_pem(const char *path,
                               br_x509_certificate **out_chain,
                               unsigned char ***out_bufs,
                               size_t *out_len)
{
	size_t len;
	unsigned char *data = read_file_data(path, &len);
	if (!data) return -1;
	int ret = load_cert_chain_pem_data(data, len,
		out_chain, out_bufs, out_len);
	free(data);
	return ret;
}

static int load_private_key_pem_data(const unsigned char *data, size_t len,
                                     br_skey_decoder_context *skey)
{
	br_pem_decoder_context pem;
	br_pem_decoder_init(&pem);
	br_skey_decoder_init(skey);

	qn_crypto_byte_vec_t current;
	qn_crypto_byte_vec_init(&current);
	int in_key = 0;
	int found = 0;
	size_t off = 0;

	while (off < len) {
		size_t pushed = br_pem_decoder_push(&pem, data + off, len - off);
		off += pushed;

		int event = br_pem_decoder_event(&pem);
		if (event == BR_PEM_BEGIN_OBJ) {
			const char *name = br_pem_decoder_name(&pem);
			if (strcmp(name, "PRIVATE KEY") == 0 ||
			    strcmp(name, "RSA PRIVATE KEY") == 0 ||
			    strcmp(name, "EC PRIVATE KEY") == 0) {
				qn_crypto_byte_vec_init(&current);
				br_pem_decoder_setdest(&pem, qn_crypto_byte_vec_append_callback, &current);
				in_key = 1;
			} else {
				in_key = 0;
				br_pem_decoder_setdest(&pem, NULL, NULL);
			}
		} else if (event == BR_PEM_END_OBJ && in_key) {
			if (qn_crypto_byte_vec_failed(&current)) {
				qn_crypto_byte_vec_clear(&current);
				return -1;
			}
			size_t der_len;
			unsigned char *der = qn_crypto_byte_vec_take(&current, &der_len);
			if (!der) return -1;
			br_skey_decoder_push(skey, der, der_len);
			free(der);
			found = 1;
			in_key = 0;
			break;
		} else if (event == BR_PEM_ERROR) {
			if (in_key) qn_crypto_byte_vec_clear(&current);
			break;
		}
	}

	if (in_key) qn_crypto_byte_vec_clear(&current);
	if (!found || br_skey_decoder_last_error(skey) != 0)
		return -1;
	return 0;
}

static int load_private_key_pem(const char *path, br_skey_decoder_context *skey)
{
	size_t len;
	unsigned char *data = read_file_data(path, &len);
	if (!data) return -1;
	int ret = load_private_key_pem_data(data, len, skey);
	free(data);
	return ret;
}

int qn_crypto_load_trust_anchors_file(const char *path)
{
	return load_ca_pem(&trust_anchor_store, path);
}

const br_x509_trust_anchor *qn_crypto_get_trust_anchors(size_t *count)
{
	*count = trust_anchor_store.num_anchors;
	return trust_anchor_store.anchors;
}

int qn_crypto_load_cert_chain_file(const char *path,
                                   qn_crypto_cert_chain_t *out)
{
	memset(out, 0, sizeof(*out));
	return load_cert_chain_pem(path, &out->certificates,
	                           &out->buffers, &out->length);
}

int qn_crypto_load_cert_chain_pem(const unsigned char *data, size_t len,
                                  qn_crypto_cert_chain_t *out)
{
	memset(out, 0, sizeof(*out));
	return load_cert_chain_pem_data(data, len, &out->certificates,
	                                &out->buffers, &out->length);
}

void qn_crypto_cert_chain_clear(qn_crypto_cert_chain_t *chain)
{
	free_cert_chain_parts(chain->certificates, chain->buffers, chain->length);
	memset(chain, 0, sizeof(*chain));
}

int qn_crypto_load_private_key_file(const char *path,
                                    br_skey_decoder_context *out)
{
	return load_private_key_pem(path, out);
}

int qn_crypto_load_private_key_pem(const unsigned char *data, size_t len,
                                   br_skey_decoder_context *out)
{
	return load_private_key_pem_data(data, len, out);
}
