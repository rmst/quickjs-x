/*
 * TLS engine and QuickJS bindings for qn:crypto.
 */

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include "bearssl.h"
#include "quickjs.h"

#include "qn-crypto.h"
#include "qn-crypto-pem.h"

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
	qn_crypto_cert_chain_t chain;
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
	int n = qn_crypto_load_trust_anchors_file(path);
	JS_FreeCString(ctx, path);
	return JS_NewInt32(ctx, n < 0 ? 0 : n);
}

/*
 * tlsLoadServerCert(certPemPath, keyPemPath) -> TLSServerCred object
 */
static void free_server_cred(tls_server_cred_t *cred) {
	if (!cred) return;
	qn_crypto_cert_chain_clear(&cred->chain);
	free(cred);
}

static JSValue server_cred_to_js(JSContext *ctx, tls_server_cred_t *cred)
{
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

	int ncerts = qn_crypto_load_cert_chain_file(cert_path, &cred->chain);
	JS_FreeCString(ctx, cert_path);

	if (ncerts <= 0) {
		JS_FreeCString(ctx, key_path);
		free(cred);
		return JS_ThrowTypeError(ctx, "TLS: failed to load certificate chain");
	}

	int ret = qn_crypto_load_private_key_file(key_path, &cred->skey);
	JS_FreeCString(ctx, key_path);

	if (ret < 0) {
		free_server_cred(cred);
		return JS_ThrowTypeError(ctx, "TLS: failed to load private key");
	}

	return server_cred_to_js(ctx, cred);
}

/*
 * tlsLoadServerCertPem(certPem, keyPem) -> TLSServerCred object
 */
static JSValue js_tls_load_server_cert_pem(JSContext *ctx, JSValueConst this_val,
                                           int argc, JSValueConst *argv)
{
	size_t cert_len = 0;
	const char *cert_pem = JS_ToCStringLen(ctx, &cert_len, argv[0]);
	if (!cert_pem)
		return JS_EXCEPTION;
	size_t key_len = 0;
	const char *key_pem = JS_ToCStringLen(ctx, &key_len, argv[1]);
	if (!key_pem) {
		JS_FreeCString(ctx, cert_pem);
		return JS_EXCEPTION;
	}

	tls_server_cred_t *cred = calloc(1, sizeof(tls_server_cred_t));
	if (!cred) {
		JS_FreeCString(ctx, cert_pem);
		JS_FreeCString(ctx, key_pem);
		return JS_ThrowOutOfMemory(ctx);
	}

	int ncerts = qn_crypto_load_cert_chain_pem(
		(const unsigned char *)cert_pem, cert_len, &cred->chain);
	JS_FreeCString(ctx, cert_pem);

	if (ncerts <= 0) {
		JS_FreeCString(ctx, key_pem);
		free(cred);
		return JS_ThrowTypeError(ctx, "TLS: failed to load certificate chain");
	}

	int ret = qn_crypto_load_private_key_pem(
		(const unsigned char *)key_pem, key_len, &cred->skey);
	JS_FreeCString(ctx, key_pem);

	if (ret < 0) {
		free_server_cred(cred);
		return JS_ThrowTypeError(ctx, "TLS: failed to load private key");
	}

	return server_cred_to_js(ctx, cred);
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

	size_t trust_anchor_count;
	const br_x509_trust_anchor *trust_anchors =
		qn_crypto_get_trust_anchors(&trust_anchor_count);
	if (trust_anchor_count == 0 && !skip_chain_check) {
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
		trust_anchors, trust_anchor_count);
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
			cred->chain.certificates, cred->chain.length, sk);
	} else {
		const br_ec_private_key *sk = br_skey_decoder_get_ec(&cred->skey);
		br_ssl_server_init_full_ec(&conn->ctx.server,
			cred->chain.certificates, cred->chain.length, cred->key_type, sk);
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
	size_t count;
	qn_crypto_get_trust_anchors(&count);
	return JS_NewInt32(ctx, (int)count);
}

static const JSCFunctionListEntry tls_exports[] = {
	JS_CFUNC_DEF("tlsLoadCACerts", 1, js_tls_load_ca_certs),
	JS_CFUNC_DEF("tlsLoadServerCert", 2, js_tls_load_server_cert),
	JS_CFUNC_DEF("tlsLoadServerCertPem", 2, js_tls_load_server_cert_pem),
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
};

static int init_tls_classes(JSContext *ctx)
{
	JSRuntime *rt = JS_GetRuntime(ctx);

	JS_NewClassID(&tls_conn_class_id);
	if (JS_NewClass(rt, tls_conn_class_id, &tls_conn_class) < 0)
		return -1;

	JS_NewClassID(&tls_server_cred_class_id);
	return JS_NewClass(rt, tls_server_cred_class_id, &tls_server_cred_class);
}

const qn_crypto_component_t qn_crypto_tls_component = {
	.exports = tls_exports,
	.export_count = QN_CRYPTO_COUNT_OF(tls_exports),
	.init_classes = init_tls_classes,
};
