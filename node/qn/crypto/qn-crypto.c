/*
 * qn-crypto.c - Crypto and TLS bindings for QuickJS using BearSSL
 *
 * Provides non-blocking TLS client and server connections plus cryptographic
 * primitives (hashing, HMAC, ciphers, etc.). The C side exposes thin wrappers
 * around BearSSL; JS modules (qn:tls, node:crypto) build APIs on top.
 */

#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/socket.h>

#include "bearssl.h"
#include "quickjs.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

/* Maximum number of trust anchors (CA certificates) */
#define MAX_TRUST_ANCHORS 512


/* ---- Dynamic byte vector (for accumulating DN data) ---- */

typedef struct {
	unsigned char *data;
	size_t len;
	size_t cap;
} byte_vec_t;

static void bv_init(byte_vec_t *v)
{
	v->data = NULL;
	v->len = 0;
	v->cap = 0;
}

static void bv_append(void *ctx, const void *buf, size_t len)
{
	byte_vec_t *v = ctx;
	if (v->len + len > v->cap) {
		size_t new_cap = v->cap ? v->cap * 2 : 256;
		while (new_cap < v->len + len) new_cap *= 2;
		unsigned char *p = realloc(v->data, new_cap);
		if (!p) return;
		v->data = p;
		v->cap = new_cap;
	}
	memcpy(v->data + v->len, buf, len);
	v->len += len;
}

static unsigned char *bv_take(byte_vec_t *v, size_t *out_len)
{
	unsigned char *d = v->data;
	*out_len = v->len;
	v->data = NULL;
	v->len = 0;
	v->cap = 0;
	return d;
}

static void bv_clear(byte_vec_t *v)
{
	free(v->data);
	v->data = NULL;
	v->len = 0;
	v->cap = 0;
}

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

static trust_anchor_store_t g_ta_store;

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
	byte_vec_t dn;
} cert_decode_ctx_t;

static void cert_dn_append(void *ctx, const void *buf, size_t len)
{
	cert_decode_ctx_t *cc = ctx;
	bv_append(&cc->dn, buf, len);
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
					bv_init(&cc.dn);
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
				if (err == 0) {
					size_t dn_len;
					unsigned char *dn_data = bv_take(&cc.dn, &dn_len);
					add_trust_anchor(store, &cc.x509,
						dn_data, dn_len);
				} else {
					bv_clear(&cc.dn);
				}
				in_cert = 0;
			} else if (event == BR_PEM_ERROR) {
				if (in_cert) bv_clear(&cc.dn);
				break;
			}
		}
	}

	fclose(f);
	return (int)(store->num_anchors - initial_count);
}


/* ---- Certificate chain loading (for server certs, raw DER) ---- */

static int load_cert_chain_pem(const char *path,
                                br_x509_certificate **out_chain,
                                unsigned char ***out_bufs,
                                size_t *out_len)
{
	FILE *f = fopen(path, "rb");
	if (!f) return -1;

	br_pem_decoder_context pem;
	br_pem_decoder_init(&pem);
	unsigned char buf[8192];
	int in_cert = 0;
	byte_vec_t current;
	bv_init(&current);

	br_x509_certificate *chain = NULL;
	unsigned char **bufs = NULL;
	size_t num = 0, cap = 0;

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
					bv_init(&current);
					br_pem_decoder_setdest(&pem, bv_append, &current);
					in_cert = 1;
				} else {
					in_cert = 0;
					br_pem_decoder_setdest(&pem, NULL, NULL);
				}
			} else if (event == BR_PEM_END_OBJ && in_cert) {
				if (num >= cap) {
					size_t new_cap = cap ? cap * 2 : 4;
					br_x509_certificate *nc = realloc(chain, new_cap * sizeof(br_x509_certificate));
					unsigned char **nb = realloc(bufs, new_cap * sizeof(unsigned char *));
					if (!nc || !nb) {
						/* On partial realloc success, the original pointer
						 * is still valid — use it for cleanup below */
						if (nc) chain = nc;
						if (nb) bufs = nb;
						bv_clear(&current);
						in_cert = 0;
						goto done_reading;
					}
					chain = nc;
					bufs = nb;
					cap = new_cap;
				}
				size_t der_len;
				unsigned char *der = bv_take(&current, &der_len);
				bufs[num] = der;
				chain[num].data = der;
				chain[num].data_len = der_len;
				num++;
				in_cert = 0;
			} else if (event == BR_PEM_ERROR) {
				if (in_cert) bv_clear(&current);
				break;
			}
		}
	}

done_reading:
	fclose(f);

	if (num == 0) {
		free(chain);
		free(bufs);
		return -1;
	}

	*out_chain = chain;
	*out_bufs = bufs;
	*out_len = num;
	return (int)num;
}


/* ---- Private key loading from PEM ---- */

static int load_private_key_pem(const char *path, br_skey_decoder_context *skey)
{
	FILE *f = fopen(path, "rb");
	if (!f) return -1;

	br_pem_decoder_context pem;
	br_pem_decoder_init(&pem);
	br_skey_decoder_init(skey);

	byte_vec_t current;
	bv_init(&current);
	int in_key = 0;
	int found = 0;
	unsigned char buf[8192];

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
				if (strcmp(name, "PRIVATE KEY") == 0 ||
				    strcmp(name, "RSA PRIVATE KEY") == 0 ||
				    strcmp(name, "EC PRIVATE KEY") == 0) {
					bv_init(&current);
					br_pem_decoder_setdest(&pem, bv_append, &current);
					in_key = 1;
				} else {
					in_key = 0;
					br_pem_decoder_setdest(&pem, NULL, NULL);
				}
			} else if (event == BR_PEM_END_OBJ && in_key) {
				size_t der_len;
				unsigned char *der = bv_take(&current, &der_len);
				br_skey_decoder_push(skey, der, der_len);
				free(der);
				found = 1;
				in_key = 0;
			} else if (event == BR_PEM_ERROR) {
				if (in_key) bv_clear(&current);
				break;
			}
		}
		if (found) break;
	}

	fclose(f);

	if (!found || br_skey_decoder_last_error(skey) != 0)
		return -1;
	return 0;
}


/* ---- TLS connection context ---- */

/*
 * Maximum leaf certificate size we'll capture for pinning. Real-world
 * leaves are typically 1-2 KB; 8 KB is a generous bound. If a server's
 * leaf exceeds this, the capture is marked truncated and pin checks
 * that need the full leaf will fail closed.
 */
#define PIN_LEAF_MAX 8192

/*
 * Wrapping X.509 engine: delegates every method to br_x509_minimal,
 * but additionally captures the leaf (first) certificate's DER bytes
 * so the JS side can do post-handshake pinning checks.
 */
typedef struct {
	const br_x509_class *vtable;
	br_x509_minimal_context inner;
	unsigned char leaf[PIN_LEAF_MAX];
	size_t leaf_len;
	int leaf_truncated;
	int cert_index;       /* 0 = leaf, ≥1 = chain */
	/*
	 * If non-zero, end_chain returns success regardless of the inner
	 * minimal engine's verdict — i.e. CA trust, signatures, expiry,
	 * and hostname matching are all bypassed. Pure-pin mode: callers
	 * must enforce identity entirely via the post-handshake pin check.
	 */
	int skip_chain_check;
} pin_x509_ctx;

typedef struct {
	int is_server;
	union {
		struct {
			br_ssl_client_context sc;
			pin_x509_ctx xw;  /* wraps minimal, replaces it as the engine's x509 */
		} client;
		br_ssl_server_context server;
	} ctx;
	unsigned char iobuf[BR_SSL_BUFSIZE_BIDI];
	int fd;
} tls_conn_t;

/* ---- Leaf-capturing X.509 wrapper around br_x509_minimal ---- */

static void pin_start_chain(const br_x509_class **ctx, const char *server_name)
{
	pin_x509_ctx *p = (pin_x509_ctx *)ctx;
	p->leaf_len = 0;
	p->leaf_truncated = 0;
	p->cert_index = 0;
	p->inner.vtable->start_chain(&p->inner.vtable, server_name);
}

static void pin_start_cert(const br_x509_class **ctx, uint32_t length)
{
	pin_x509_ctx *p = (pin_x509_ctx *)ctx;
	if (p->cert_index == 0 && length > PIN_LEAF_MAX)
		p->leaf_truncated = 1;
	p->inner.vtable->start_cert(&p->inner.vtable, length);
}

static void pin_append(const br_x509_class **ctx,
                       const unsigned char *buf, size_t len)
{
	pin_x509_ctx *p = (pin_x509_ctx *)ctx;
	if (p->cert_index == 0 && !p->leaf_truncated) {
		if (p->leaf_len + len <= PIN_LEAF_MAX) {
			memcpy(p->leaf + p->leaf_len, buf, len);
			p->leaf_len += len;
		} else {
			p->leaf_truncated = 1;
		}
	}
	p->inner.vtable->append(&p->inner.vtable, buf, len);
}

static void pin_end_cert(const br_x509_class **ctx)
{
	pin_x509_ctx *p = (pin_x509_ctx *)ctx;
	p->inner.vtable->end_cert(&p->inner.vtable);
	p->cert_index++;
}

static unsigned pin_end_chain(const br_x509_class **ctx)
{
	pin_x509_ctx *p = (pin_x509_ctx *)ctx;
	unsigned err = p->inner.vtable->end_chain(&p->inner.vtable);
	/*
	 * In pure-pin mode, ignore chain validation errors. The leaf cert's
	 * public key has still been parsed and will be used by the TLS
	 * engine to verify the peer's signed handshake messages, so a
	 * successful TLS handshake combined with a matching post-handshake
	 * pin proves we're talking to the holder of the pinned key.
	 */
	if (err && p->skip_chain_check) return 0;
	return err;
}

static const br_x509_pkey *pin_get_pkey(const br_x509_class *const *ctx,
                                        unsigned *usages)
{
	pin_x509_ctx *p = (pin_x509_ctx *)ctx;
	return p->inner.vtable->get_pkey(&p->inner.vtable, usages);
}

static const br_x509_class pin_x509_vtable = {
	sizeof(pin_x509_ctx),
	pin_start_chain,
	pin_start_cert,
	pin_append,
	pin_end_cert,
	pin_end_chain,
	pin_get_pkey,
};

static inline br_ssl_engine_context *tls_engine(tls_conn_t *c)
{
	return c->is_server ? &c->ctx.server.eng : &c->ctx.client.sc.eng;
}

/* Ensure fd is non-blocking for async TLS I/O */
static int set_nonblocking(int fd)
{
	int flags = fcntl(fd, F_GETFL);
	if (flags < 0) return -1;
	if (flags & O_NONBLOCK) return 0;
	return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/* ---- QuickJS opaque classes ---- */

static JSClassID tls_conn_class_id;
static JSClassID tls_server_cred_class_id;

static void tls_conn_finalizer(JSRuntime *rt, JSValue val)
{
	tls_conn_t *conn = JS_GetOpaque(val, tls_conn_class_id);
	if (conn) {
		br_ssl_engine_close(tls_engine(conn));
		free(conn);
	}
}

static JSClassDef tls_conn_class = {
	"TLSConnection",
	.finalizer = tls_conn_finalizer,
};

/* ---- Server credential storage ---- */

typedef struct {
	br_x509_certificate *chain;
	unsigned char **cert_bufs;
	size_t chain_len;
	br_skey_decoder_context skey;
	int key_type;
} tls_server_cred_t;

static void free_server_cred(tls_server_cred_t *cred);

static void tls_server_cred_finalizer(JSRuntime *rt, JSValue val)
{
	free_server_cred(JS_GetOpaque(val, tls_server_cred_class_id));
}

static JSClassDef tls_server_cred_class = {
	"TLSServerCred",
	.finalizer = tls_server_cred_finalizer,
};


/* ---- JS functions ---- */

/*
 * tlsLoadCACerts(filePath) -> number of certs loaded from this file
 */
static JSValue js_tls_load_ca_certs(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path)
		return JS_EXCEPTION;
	int n = load_ca_pem(&g_ta_store, path);
	JS_FreeCString(ctx, path);
	return JS_NewInt32(ctx, n < 0 ? 0 : n);
}

/*
 * tlsLoadServerCert(certPemPath, keyPemPath) -> TLSServerCred object
 */
static void free_server_cred(tls_server_cred_t *cred) {
	if (!cred) return;
	for (size_t i = 0; i < cred->chain_len; i++)
		free(cred->cert_bufs[i]);
	free(cred->cert_bufs);
	free(cred->chain);
	free(cred);
}

static JSValue js_tls_load_server_cert(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
	const char *cert_path = JS_ToCString(ctx, argv[0]);
	if (!cert_path)
		return JS_EXCEPTION;
	const char *key_path = JS_ToCString(ctx, argv[1]);
	if (!key_path) {
		JS_FreeCString(ctx, cert_path);
		return JS_EXCEPTION;
	}

	tls_server_cred_t *cred = calloc(1, sizeof(tls_server_cred_t));
	if (!cred) {
		JS_FreeCString(ctx, cert_path);
		JS_FreeCString(ctx, key_path);
		return JS_ThrowOutOfMemory(ctx);
	}

	int ncerts = load_cert_chain_pem(cert_path, &cred->chain,
	                                  &cred->cert_bufs, &cred->chain_len);
	JS_FreeCString(ctx, cert_path);

	if (ncerts <= 0) {
		JS_FreeCString(ctx, key_path);
		free(cred);
		return JS_ThrowTypeError(ctx, "TLS: failed to load certificate chain");
	}

	int ret = load_private_key_pem(key_path, &cred->skey);
	JS_FreeCString(ctx, key_path);

	if (ret < 0) {
		free_server_cred(cred);
		return JS_ThrowTypeError(ctx, "TLS: failed to load private key");
	}

	cred->key_type = br_skey_decoder_key_type(&cred->skey);
	if (cred->key_type == 0) {
		free_server_cred(cred);
		return JS_ThrowTypeError(ctx, "TLS: unsupported key type");
	}

	JSValue obj = JS_NewObjectClass(ctx, tls_server_cred_class_id);
	if (JS_IsException(obj)) {
		free_server_cred(cred);
		return obj;
	}
	JS_SetOpaque(obj, cred);
	return obj;
}

/*
 * tlsConnect(fd, hostname) -> TLSConnection object
 *
 * Initializes a TLS client context on the given socket fd.
 * Does NOT perform the handshake — the JS side drives the engine
 * via tlsPumpRead/tlsPumpWrite until SENDAPP is available.
 */
static JSValue js_tls_connect(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
	int fd;
	const char *hostname;
	int skip_chain_check = 0;

	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;
	hostname = JS_ToCString(ctx, argv[1]);
	if (!hostname)
		return JS_EXCEPTION;
	if (argc > 2 && !JS_IsUndefined(argv[2])) {
		int v;
		if (JS_ToInt32(ctx, &v, argv[2])) {
			JS_FreeCString(ctx, hostname);
			return JS_EXCEPTION;
		}
		skip_chain_check = v ? 1 : 0;
	}

	if (g_ta_store.num_anchors == 0 && !skip_chain_check) {
		JS_FreeCString(ctx, hostname);
		return JS_ThrowTypeError(ctx, "TLS: no CA certificates loaded. "
			"Call tlsLoadCACerts() first.");
	}

	if (fd >= 0 && set_nonblocking(fd) < 0) {
		JS_FreeCString(ctx, hostname);
		return JS_ThrowTypeError(ctx, "TLS: failed to set non-blocking: %s",
			strerror(errno));
	}

	tls_conn_t *conn = calloc(1, sizeof(tls_conn_t));
	if (!conn) {
		JS_FreeCString(ctx, hostname);
		return JS_ThrowOutOfMemory(ctx);
	}

	conn->is_server = 0;
	conn->fd = fd;

	/*
	 * Initialise br_x509_minimal inside the wrapper, then point the SSL
	 * engine at the wrapper's vtable. The wrapper forwards every method
	 * to the inner minimal context, so chain validation (signatures,
	 * trust anchors, hostname matching, expiry) is unchanged. Its only
	 * extra job is to capture the leaf cert's DER bytes for pinning.
	 */
	br_ssl_client_init_full(&conn->ctx.client.sc, &conn->ctx.client.xw.inner,
		g_ta_store.anchors, g_ta_store.num_anchors);
	conn->ctx.client.xw.vtable = &pin_x509_vtable;
	conn->ctx.client.xw.skip_chain_check = skip_chain_check;
	br_ssl_engine_set_x509(tls_engine(conn), &conn->ctx.client.xw.vtable);

	/* TLS 1.2 only (TLS 1.0/1.1 deprecated per RFC 8996) */
	br_ssl_engine_set_versions(tls_engine(conn), BR_TLS12, BR_TLS12);

	br_ssl_engine_set_buffer(tls_engine(conn), conn->iobuf,
		sizeof(conn->iobuf), 1);

	br_ssl_client_reset(&conn->ctx.client.sc, hostname, 0);
	JS_FreeCString(ctx, hostname);

	JSValue obj = JS_NewObjectClass(ctx, tls_conn_class_id);
	if (JS_IsException(obj)) {
		free(conn);
		return obj;
	}
	JS_SetOpaque(obj, conn);
	return obj;
}

/*
 * tlsAccept(fd, cred) -> TLSConnection object
 *
 * Initializes a TLS server context on the given socket fd.
 * Does NOT perform the handshake — the JS side drives the engine.
 */
static JSValue js_tls_accept(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	tls_server_cred_t *cred = JS_GetOpaque2(ctx, argv[1], tls_server_cred_class_id);
	if (!cred)
		return JS_EXCEPTION;

	if (fd >= 0 && set_nonblocking(fd) < 0)
		return JS_ThrowTypeError(ctx, "TLS: failed to set non-blocking: %s",
			strerror(errno));

	tls_conn_t *conn = calloc(1, sizeof(tls_conn_t));
	if (!conn)
		return JS_ThrowOutOfMemory(ctx);

	conn->is_server = 1;
	conn->fd = fd;

	if (cred->key_type == BR_KEYTYPE_RSA) {
		const br_rsa_private_key *sk = br_skey_decoder_get_rsa(&cred->skey);
		br_ssl_server_init_full_rsa(&conn->ctx.server,
			cred->chain, cred->chain_len, sk);
	} else {
		const br_ec_private_key *sk = br_skey_decoder_get_ec(&cred->skey);
		br_ssl_server_init_full_ec(&conn->ctx.server,
			cred->chain, cred->chain_len, cred->key_type, sk);
	}

	/* TLS 1.2 only */
	br_ssl_engine_set_versions(tls_engine(conn), BR_TLS12, BR_TLS12);

	/* ECDHE-only cipher suites (forward secrecy, no 3DES) */
	{
		static const uint16_t suites[] = {
			BR_TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			BR_TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			BR_TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			BR_TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256,
			BR_TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA384,
			BR_TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			BR_TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			BR_TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			BR_TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256,
			BR_TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA384,
		};
		br_ssl_engine_set_suites(tls_engine(conn), suites,
			sizeof(suites) / sizeof(suites[0]));
	}

	br_ssl_engine_set_buffer(tls_engine(conn),
		conn->iobuf, sizeof(conn->iobuf), 1);

	if (!br_ssl_server_reset(&conn->ctx.server)) {
		free(conn);
		return JS_ThrowTypeError(ctx, "TLS: server reset failed");
	}

	JSValue obj = JS_NewObjectClass(ctx, tls_conn_class_id);
	if (JS_IsException(obj)) {
		free(conn);
		return obj;
	}
	JS_SetOpaque(obj, conn);

	/* Prevent credential from being GC'd while connection is alive */
	JS_DefinePropertyValueStr(ctx, obj, "_cred",
		JS_DupValue(ctx, argv[1]), 0);

	return obj;
}

/*
 * tlsState(conn) -> engine state flags (bitmask)
 */
static JSValue js_tls_state(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;
	return JS_NewInt32(ctx, br_ssl_engine_current_state(tls_engine(conn)));
}

/*
 * tlsError(conn) -> engine error code (0 = no error)
 */
static JSValue js_tls_error(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;
	return JS_NewInt32(ctx, br_ssl_engine_last_error(tls_engine(conn)));
}

/*
 * tlsPeerLeafDer(conn) -> Uint8Array of the leaf cert's DER bytes,
 * or null if no leaf was captured (server connection, leaf exceeded
 * PIN_LEAF_MAX, or handshake hasn't started). Only meaningful after
 * a successful handshake on a client connection.
 */
static JSValue js_tls_peer_leaf_der(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;
	if (conn->is_server) return JS_NULL;

	pin_x509_ctx *p = &conn->ctx.client.xw;
	if (p->leaf_truncated || p->leaf_len == 0) return JS_NULL;
	return JS_NewArrayBufferCopy(ctx, p->leaf, p->leaf_len);
}

/*
 * tlsSendApp(conn, buffer, offset, length) -> bytes copied into engine
 *
 * Copies plaintext data from a JS buffer into the engine's sendapp buffer.
 * Returns bytes actually copied (may be less than requested).
 */
static JSValue js_tls_send_app(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;

	size_t buf_size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &buf_size, argv[1]);
	if (!buf) return JS_EXCEPTION;

	uint64_t off, len;
	if (JS_ToIndex(ctx, &off, argv[2])) return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[3])) return JS_EXCEPTION;
	if (off + len > buf_size) return JS_ThrowRangeError(ctx, "buffer overflow");

	br_ssl_engine_context *eng = tls_engine(conn);
	size_t avail;
	unsigned char *app_buf = br_ssl_engine_sendapp_buf(eng, &avail);
	if (!app_buf || avail == 0) return JS_NewInt32(ctx, 0);

	size_t to_copy = len < avail ? len : avail;
	memcpy(app_buf, buf + off, to_copy);
	br_ssl_engine_sendapp_ack(eng, to_copy);
	return JS_NewInt32(ctx, to_copy);
}

/*
 * tlsRecvApp(conn, buffer, offset, length) -> bytes copied from engine
 *
 * Copies decrypted plaintext from the engine's recvapp buffer into a JS buffer.
 * Returns bytes actually copied (may be less than requested).
 */
static JSValue js_tls_recv_app(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;

	size_t buf_size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &buf_size, argv[1]);
	if (!buf) return JS_EXCEPTION;

	uint64_t off, len;
	if (JS_ToIndex(ctx, &off, argv[2])) return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[3])) return JS_EXCEPTION;
	if (off + len > buf_size) return JS_ThrowRangeError(ctx, "buffer overflow");

	br_ssl_engine_context *eng = tls_engine(conn);
	size_t avail;
	unsigned char *app_buf = br_ssl_engine_recvapp_buf(eng, &avail);
	if (!app_buf || avail == 0) return JS_NewInt32(ctx, 0);

	size_t to_copy = len < avail ? len : avail;
	memcpy(buf + off, app_buf, to_copy);
	br_ssl_engine_recvapp_ack(eng, to_copy);
	return JS_NewInt32(ctx, to_copy);
}

/*
 * tlsFlush(conn, force) -> undefined
 *
 * Flushes buffered sendapp data into a TLS record for sending.
 */
static JSValue js_tls_flush(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;
	int force = 0;
	if (argc > 1 && !JS_IsUndefined(argv[1]))
		JS_ToInt32(ctx, &force, argv[1]);
	br_ssl_engine_flush(tls_engine(conn), force);
	return JS_UNDEFINED;
}

/*
 * tlsClose(conn) -> undefined
 *
 * Initiates TLS closure by assembling a close_notify alert.
 * The JS side must pump the engine to actually send it.
 */
static JSValue js_tls_close(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;
	br_ssl_engine_close(tls_engine(conn));
	return JS_UNDEFINED;
}

/*
 * tlsGetSendRec(conn) -> ArrayBuffer | null
 *
 * Returns a copy of the pending sendrec data (TLS records to be transmitted)
 * without acknowledging it. Returns null if no data is pending.
 * Call tlsSendRecAck after the data has been transmitted.
 */
static JSValue js_tls_get_sendrec(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;

	br_ssl_engine_context *eng = tls_engine(conn);
	size_t len;
	unsigned char *buf = br_ssl_engine_sendrec_buf(eng, &len);
	if (!buf || len == 0) return JS_NULL;

	return JS_NewArrayBufferCopy(ctx, buf, len);
}

/*
 * tlsSendRecAck(conn, n) -> undefined
 *
 * Acknowledges that n bytes of sendrec data have been transmitted.
 */
static JSValue js_tls_sendrec_ack(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;

	uint32_t n;
	if (JS_ToUint32(ctx, &n, argv[1])) return JS_EXCEPTION;

	br_ssl_engine_sendrec_ack(tls_engine(conn), n);
	return JS_UNDEFINED;
}

/*
 * tlsRecvRecPush(conn, buffer, offset, length) -> bytes copied
 *
 * Copies network data from a JS buffer into the engine's recvrec buffer
 * (incoming TLS records) and acknowledges it. Returns the number of bytes
 * actually copied, which may be less than requested if the engine's buffer
 * is smaller.
 */
static JSValue js_tls_recvrec_push(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;

	size_t buf_size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &buf_size, argv[1]);
	if (!buf) return JS_EXCEPTION;

	uint64_t off, len;
	if (JS_ToIndex(ctx, &off, argv[2])) return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[3])) return JS_EXCEPTION;
	if (off + len > buf_size) return JS_ThrowRangeError(ctx, "buffer overflow");

	br_ssl_engine_context *eng = tls_engine(conn);
	size_t avail;
	unsigned char *rec_buf = br_ssl_engine_recvrec_buf(eng, &avail);
	if (!rec_buf || avail == 0) return JS_NewInt32(ctx, 0);

	size_t to_copy = len < avail ? len : avail;
	memcpy(rec_buf, buf + off, to_copy);
	br_ssl_engine_recvrec_ack(eng, to_copy);
	return JS_NewInt32(ctx, to_copy);
}

/*
 * tlsCaCertCount() -> number of loaded CA certs
 */
static JSValue js_tls_ca_cert_count(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
	return JS_NewInt32(ctx, (int)g_ta_store.num_anchors);
}

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
#define NUM_HASH_ALGOS countof(hash_algos)

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

/* Helper: extract bytes from a JS value (ArrayBuffer, TypedArray, or string).
 * Returns pointer + length. For strings, caller must JS_FreeCString.
 * Sets *is_string=1 if data came from a string. */
static const uint8_t *js_get_bytes(JSContext *ctx, JSValueConst val,
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
	const uint8_t *data = js_get_bytes(ctx, argv[1], &len, &is_string, &tmp);
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
	const uint8_t *key = js_get_bytes(ctx, argv[1], &key_len, &is_string, &tmp);
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
	const uint8_t *data = js_get_bytes(ctx, argv[1], &len, &is_string, &tmp);
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
			byte_vec_t aad;
			byte_vec_t data;
		} chapoly;
	} u;
} cipher_ctx_t;

static JSClassID cipher_class_id;

static void cipher_finalizer(JSRuntime *rt, JSValue val) {
	cipher_ctx_t *cc = JS_GetOpaque(val, cipher_class_id);
	if (cc) {
		if (cc->type == CIPHER_CHACHA20_POLY1305) {
			bv_clear(&cc->u.chapoly.aad);
			bv_clear(&cc->u.chapoly.data);
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
	const uint8_t *key = js_get_bytes(ctx, argv[2], &key_len, &ks, &ktmp);
	if (!key) { JS_FreeCString(ctx, algo); return JS_EXCEPTION; }

	size_t iv_len; int ivs; JSValue ivtmp;
	const uint8_t *iv = js_get_bytes(ctx, argv[3], &iv_len, &ivs, &ivtmp);
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
		bv_init(&cc->u.chapoly.aad);
		bv_init(&cc->u.chapoly.data);
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
	const uint8_t *data = js_get_bytes(ctx, argv[1], &len, &is_string, &tmp);
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
		bv_append(&cc->u.chapoly.data, data, len);
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
	const uint8_t *data = js_get_bytes(ctx, argv[1], &len, &is_string, &tmp);
	if (!data) return JS_EXCEPTION;

	if (cc->type == CIPHER_AES_GCM) {
		br_gcm_aad_inject(&cc->u.aes_gcm.gcm, data, len);
	} else if (cc->type == CIPHER_CHACHA20_POLY1305) {
		bv_append(&cc->u.chapoly.aad, data, len);
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
		bv_clear(&cc->u.chapoly.aad);
		bv_clear(&cc->u.chapoly.data);
		bv_append(&cc->u.chapoly.aad, tag, 16);

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
	const uint8_t *tag = js_get_bytes(ctx, argv[1], &len, &is_string, &tmp);
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
	} else if (cc->type == CIPHER_CHACHA20_POLY1305 && len == 16 &&
	           cc->u.chapoly.aad.len == 16) {
		/* Constant-time compare */
		uint32_t diff = 0;
		for (size_t i = 0; i < 16; i++)
			diff |= cc->u.chapoly.aad.data[i] ^ tag[i];
		ok = (diff == 0);
	}

	if (is_string) JS_FreeCString(ctx, (const char *)tag);
	JS_FreeValue(ctx, tmp);
	return JS_NewBool(ctx, ok);
}

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

	/* Seed with system randomness */
	uint8_t seed[32];
	br_hmac_drbg_generate(&rng, seed, 0); /* init */
	/* Use libuv random via the C standard lib for seeding */
	{
		FILE *f = fopen("/dev/urandom", "rb");
		if (f) { fread(seed, 1, sizeof(seed), f); fclose(f); }
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

/* --------------------------------------------------------------------------
 * RSA sign/verify via BearSSL (PKCS#1 v1.5)
 *
 * rsaSign(hashAlgo, hash, privKeyDer)     → ArrayBuffer (signature)
 * rsaVerify(hashAlgo, hash, sig, pubKeyN, pubKeyE) → boolean
 * -------------------------------------------------------------------------- */

/* Map hash algorithm name to BearSSL OID + hash class */
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

static const JSCFunctionListEntry js_crypto_funcs[] = {
	/* TLS engine */
	JS_CFUNC_DEF("tlsLoadCACerts", 1, js_tls_load_ca_certs),
	JS_CFUNC_DEF("tlsLoadServerCert", 2, js_tls_load_server_cert),
	JS_CFUNC_DEF("tlsConnect", 3, js_tls_connect),
	JS_CFUNC_DEF("tlsAccept", 2, js_tls_accept),
	JS_CFUNC_DEF("tlsState", 1, js_tls_state),
	JS_CFUNC_DEF("tlsError", 1, js_tls_error),
	JS_CFUNC_DEF("tlsPeerLeafDer", 1, js_tls_peer_leaf_der),
	JS_CFUNC_DEF("tlsSendApp", 4, js_tls_send_app),
	JS_CFUNC_DEF("tlsRecvApp", 4, js_tls_recv_app),
	JS_CFUNC_DEF("tlsFlush", 1, js_tls_flush),
	JS_CFUNC_DEF("tlsClose", 1, js_tls_close),
	JS_CFUNC_DEF("tlsGetSendRec", 1, js_tls_get_sendrec),
	JS_CFUNC_DEF("tlsSendRecAck", 2, js_tls_sendrec_ack),
	JS_CFUNC_DEF("tlsRecvRecPush", 4, js_tls_recvrec_push),
	JS_CFUNC_DEF("tlsCaCertCount", 0, js_tls_ca_cert_count),
	JS_PROP_INT32_DEF("TLS_CLOSED", BR_SSL_CLOSED, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("TLS_SENDREC", BR_SSL_SENDREC, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("TLS_RECVREC", BR_SSL_RECVREC, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("TLS_SENDAPP", BR_SSL_SENDAPP, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("TLS_RECVAPP", BR_SSL_RECVAPP, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("EAGAIN", EAGAIN, JS_PROP_CONFIGURABLE),
	/* Backward-compatible hash aliases */
	JS_CFUNC_DEF("sha256Init", 0, js_sha256Init),
	JS_CFUNC_DEF("sha256Update", 2, js_hashUpdate),
	JS_CFUNC_DEF("sha256Out", 1, js_hashOut),
	JS_CFUNC_DEF("sha1Init", 0, js_sha1Init),
	JS_CFUNC_DEF("sha1Update", 2, js_hashUpdate),
	JS_CFUNC_DEF("sha1Out", 1, js_hashOut),
	/* Generic hash */
	JS_CFUNC_DEF("hashInit", 1, js_hashInit),
	JS_CFUNC_DEF("hashUpdate", 2, js_hashUpdate),
	JS_CFUNC_DEF("hashOut", 1, js_hashOut),
	/* HMAC */
	JS_CFUNC_DEF("hmacInit", 2, js_hmacInit),
	JS_CFUNC_DEF("hmacUpdate", 2, js_hmacUpdate),
	JS_CFUNC_DEF("hmacOut", 1, js_hmacOut),
	/* Ciphers */
	JS_CFUNC_DEF("cipherInit", 4, js_cipherInit),
	JS_CFUNC_DEF("cipherUpdate", 2, js_cipherUpdate),
	JS_CFUNC_DEF("cipherSetAAD", 2, js_cipherSetAAD),
	JS_CFUNC_DEF("cipherFinal", 1, js_cipherFinal),
	JS_CFUNC_DEF("cipherGetAuthTag", 1, js_cipherGetAuthTag),
	JS_CFUNC_DEF("cipherSetAuthTag", 2, js_cipherSetAuthTag),
	/* ECDH */
	JS_CFUNC_DEF("ecdhGenerateKeys", 1, js_ecdhGenerateKeys),
	JS_CFUNC_DEF("ecdhComputeSecret", 3, js_ecdhComputeSecret),
	/* ECDSA */
	JS_CFUNC_DEF("ecdsaSign", 4, js_ecdsaSign),
	JS_CFUNC_DEF("ecdsaVerify", 5, js_ecdsaVerify),
};

static int js_crypto_init(JSContext *ctx, JSModuleDef *m)
{
	JSRuntime *rt = JS_GetRuntime(ctx);

	JS_NewClassID(&tls_conn_class_id);
	JS_NewClass(rt, tls_conn_class_id, &tls_conn_class);

	JS_NewClassID(&tls_server_cred_class_id);
	JS_NewClass(rt, tls_server_cred_class_id, &tls_server_cred_class);

	JS_NewClassID(&hash_class_id);
	JS_NewClass(rt, hash_class_id, &hash_class);

	JS_NewClassID(&hmac_class_id);
	JS_NewClass(rt, hmac_class_id, &hmac_class);

	JS_NewClassID(&cipher_class_id);
	JS_NewClass(rt, cipher_class_id, &cipher_class);

	return JS_SetModuleExportList(ctx, m, js_crypto_funcs,
	                              countof(js_crypto_funcs));
}

JSModuleDef *js_init_module_qn_crypto(JSContext *ctx, const char *module_name)
{
	JSModuleDef *m;
	m = JS_NewCModule(ctx, module_name, js_crypto_init);
	if (!m)
		return NULL;
	JS_AddModuleExportList(ctx, m, js_crypto_funcs,
	                       countof(js_crypto_funcs));
	return m;
}
