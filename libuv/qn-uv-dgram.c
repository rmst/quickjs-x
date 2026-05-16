/*
 * qn_uv_dgram - UDP datagram sockets via libuv
 *
 * Single-dispatch design following qn-uv-stream.c pattern.
 * Two-phase destruction (closed + finalized) to prevent use-after-free.
 */

#include "qn-uv-dgram.h"
#include "qn-vm.h"
#include <string.h>

static JSClassID qn_dgram_class_id;

/* Linked list of all QNDgram objects, for shutdown cleanup */
static QNDgram *dgram_head = NULL;

static void dgram_link(QNDgram *d) {
	d->next = dgram_head;
	dgram_head = d;
}

static void dgram_unlink(QNDgram *d) {
	QNDgram **pp = &dgram_head;
	while (*pp) {
		if (*pp == d) { *pp = d->next; return; }
		pp = &(*pp)->next;
	}
}

static void qn_dgram_maybe_free(QNDgram *d) {
	if (d->closed && d->finalized) {
		dgram_unlink(d);
		free(d);
	}
}

static void qn_dgram_close_cb(uv_handle_t *handle) {
	QNDgram *d = handle->data;
	d->closed = 1;
	if (!d->finalized && !JS_IsUndefined(d->this_val)) {
		JSValue tmp = d->this_val;
		d->this_val = JS_UNDEFINED;
		JS_FreeValue(d->ctx, tmp);
		return;
	}
	qn_dgram_maybe_free(d);
}

static void qn_dgram_finalizer(JSRuntime *rt, JSValue val) {
	QNDgram *d = JS_GetOpaque(val, qn_dgram_class_id);
	if (!d) return;

	JS_FreeValueRT(rt, d->on_message);
	JS_FreeValueRT(rt, d->this_val);
	d->on_message = JS_UNDEFINED;
	d->this_val = JS_UNDEFINED;

	d->finalized = 1;
	if (!d->closed) {
		if (!uv_is_closing((uv_handle_t *)&d->handle))
			uv_close((uv_handle_t *)&d->handle, qn_dgram_close_cb);
	} else {
		qn_dgram_maybe_free(d);
	}
}

static void qn_dgram_gc_mark(JSRuntime *rt, JSValueConst val,
                              JS_MarkFunc *mark_func) {
	QNDgram *d = JS_GetOpaque(val, qn_dgram_class_id);
	if (!d) return;
	JS_MarkValue(rt, d->on_message, mark_func);
	/* this_val intentionally NOT marked — prevent-GC pattern */
}

static JSClassDef qn_dgram_class = {
	"Dgram",
	.finalizer = qn_dgram_finalizer,
	.gc_mark = qn_dgram_gc_mark,
};

static QNDgram *qn_dgram_get(JSContext *ctx, JSValueConst obj) {
	return JS_GetOpaque2(ctx, obj, qn_dgram_class_id);
}

/* ---- Alloc / init helpers ---- */

static QNDgram *qn_dgram_new(JSContext *ctx) {
	QNDgram *d = calloc(1, sizeof(*d));
	if (!d) return NULL;
	d->ctx = ctx;
	d->on_message = JS_UNDEFINED;
	d->this_val = JS_UNDEFINED;
	d->handle.data = d;
	dgram_link(d);
	return d;
}

static JSValue qn_dgram_wrap(JSContext *ctx, QNDgram *d) {
	JSValue obj = JS_NewObjectClass(ctx, qn_dgram_class_id);
	if (JS_IsException(obj)) {
		if (!uv_is_closing((uv_handle_t *)&d->handle))
			uv_close((uv_handle_t *)&d->handle, qn_dgram_close_cb);
		return JS_EXCEPTION;
	}
	JS_SetOpaque(obj, d);
	d->this_val = JS_DupValue(ctx, obj);
	return obj;
}

/* ---- libuv callbacks ---- */

static void qn_dgram_alloc_cb(uv_handle_t *handle, size_t suggested,
                               uv_buf_t *buf) {
	QNDgram *d = handle->data;
	buf->base = js_malloc(d->ctx, suggested);
	buf->len = buf->base ? suggested : 0;
}

static void qn_dgram_recv_cb(uv_udp_t *handle, ssize_t nread,
                              const uv_buf_t *buf,
                              const struct sockaddr *addr, unsigned flags) {
	QNDgram *d = handle->data;
	JSContext *ctx = d->ctx;

	if (JS_IsUndefined(d->on_message)) {
		if (buf->base) js_free(ctx, buf->base);
		return;
	}

	if (nread < 0) {
		/* Error */
		if (buf->base) js_free(ctx, buf->base);
		JSValue err = qn_new_error(ctx, nread);
		JSValue args[3] = { JS_NULL, JS_NULL, err };
		qn_call_handler(ctx, d->on_message, 3, args);
		JS_FreeValue(ctx, err);
		return;
	}

	if (nread == 0) {
		/* Empty read (addr==NULL means nothing received) */
		if (buf->base) js_free(ctx, buf->base);
		return;
	}

	/* Zero-copy: buf->base was allocated with js_malloc */
	JSValue arr = qn_new_uint8array(ctx, (uint8_t *)buf->base, nread);
	JSValue rinfo = JS_NewObject(ctx);
	if (addr) qn_addr2obj(ctx, rinfo, addr, false);
	JSValue args[3] = { arr, rinfo, JS_NULL };
	qn_call_handler(ctx, d->on_message, 3, args);
	JS_FreeValue(ctx, arr);
	JS_FreeValue(ctx, rinfo);
}

typedef struct {
	uv_udp_send_t req;
	JSContext *ctx;
	QNPromise result;
	JSValue tarray; /* pinned buffer */
} QNSendReq;

static void qn_dgram_send_cb(uv_udp_send_t *req, int status) {
	QNSendReq *sr = req->data;
	JSContext *ctx = sr->ctx;
	JSValue arg;
	bool is_reject = false;

	if (status < 0) {
		arg = qn_new_error(ctx, status);
		is_reject = true;
	} else {
		arg = JS_UNDEFINED;
	}

	qn_promise_settle(ctx, &sr->result, is_reject, 1, &arg);
	JS_FreeValue(ctx, sr->tarray);
	js_free(ctx, sr);
}

/* ---- Opcodes ---- */

enum {
	DGRAM_NEW = 0,
	DGRAM_BIND,
	DGRAM_SEND,
	DGRAM_RECV_START,
	DGRAM_RECV_STOP,
	DGRAM_CLOSE,
	DGRAM_GETSOCKNAME,
	DGRAM_SET_BROADCAST,
	DGRAM_SET_TTL,
	DGRAM_SET_MULTICAST_TTL,
	DGRAM_SET_MULTICAST_LOOPBACK,
	DGRAM_SET_ON_MESSAGE,
};

/* ---- Single dispatch ---- */

static JSValue js_uv_dgram_op(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	int32_t op;
	if (JS_ToInt32(ctx, &op, argv[0]))
		return JS_EXCEPTION;

	int nargs = argc - 1;
	JSValueConst *args = argv + 1;
	uv_loop_t *loop = js_uv_loop(ctx);

	switch (op) {

	case DGRAM_NEW: {
		int32_t family = AF_INET;
		if (nargs > 0 && !JS_IsUndefined(args[0]))
			JS_ToInt32(ctx, &family, args[0]);
		QNDgram *d = qn_dgram_new(ctx);
		if (!d) return JS_ThrowOutOfMemory(ctx);
		int r = uv_udp_init(loop, &d->handle);
		if (r < 0) { free(d); return qn_throw_errno(ctx, r); }
		return qn_dgram_wrap(ctx, d);
	}

	case DGRAM_BIND: {
		QNDgram *d = qn_dgram_get(ctx, args[0]);
		if (!d) return JS_EXCEPTION;
		const char *host = JS_ToCString(ctx, args[1]);
		if (!host) return JS_EXCEPTION;
		int32_t port;
		if (JS_ToInt32(ctx, &port, args[2])) {
			JS_FreeCString(ctx, host);
			return JS_EXCEPTION;
		}
		int32_t flags = 0;
		if (nargs > 3 && !JS_IsUndefined(args[3]))
			JS_ToInt32(ctx, &flags, args[3]);
		struct sockaddr_storage addr;
		int r;
		if (strchr(host, ':')) {
			r = uv_ip6_addr(host, port, (struct sockaddr_in6 *)&addr);
		} else {
			r = uv_ip4_addr(host, port, (struct sockaddr_in *)&addr);
		}
		JS_FreeCString(ctx, host);
		if (r < 0) return qn_throw_errno(ctx, r);
		r = uv_udp_bind(&d->handle, (struct sockaddr *)&addr, flags);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	case DGRAM_SEND: {
		QNDgram *d = qn_dgram_get(ctx, args[0]);
		if (!d) return JS_EXCEPTION;

		/* Extract buffer data from TypedArray */
		size_t byte_offset, byte_length, elem_size;
		JSValue ab = JS_GetTypedArrayBuffer(ctx, args[1], &byte_offset, &byte_length, &elem_size);
		if (JS_IsException(ab)) return JS_EXCEPTION;
		size_t ab_size;
		uint8_t *buf = JS_GetArrayBuffer(ctx, &ab_size, ab);
		JS_FreeValue(ctx, ab);
		if (!buf) return JS_EXCEPTION;

		uint8_t *data = buf + byte_offset;
		size_t size = byte_length;

		/* Optional offset and length */
		if (nargs > 4 && !JS_IsUndefined(args[4])) {
			int32_t off;
			if (JS_ToInt32(ctx, &off, args[4])) return JS_EXCEPTION;
			if (off < 0 || (size_t)off > byte_length)
				return JS_ThrowRangeError(ctx, "offset out of range");
			data += off;
			size -= off;
		}
		if (nargs > 5 && !JS_IsUndefined(args[5])) {
			int32_t len;
			if (JS_ToInt32(ctx, &len, args[5])) return JS_EXCEPTION;
			if (len < 0 || (size_t)len > size)
				return JS_ThrowRangeError(ctx, "length out of range");
			size = len;
		}

		/* Destination address (optional — if connected, can omit) */
		struct sockaddr_storage dest;
		struct sockaddr *dest_ptr = NULL;
		if (nargs > 2 && !JS_IsUndefined(args[2]) && !JS_IsNull(args[2])) {
			const char *host = JS_ToCString(ctx, args[2]);
			if (!host) return JS_EXCEPTION;
			int32_t port;
			if (JS_ToInt32(ctx, &port, args[3])) {
				JS_FreeCString(ctx, host);
				return JS_EXCEPTION;
			}
			int r;
			if (strchr(host, ':')) {
				r = uv_ip6_addr(host, port, (struct sockaddr_in6 *)&dest);
			} else {
				r = uv_ip4_addr(host, port, (struct sockaddr_in *)&dest);
			}
			JS_FreeCString(ctx, host);
			if (r < 0) return qn_throw_errno(ctx, r);
			dest_ptr = (struct sockaddr *)&dest;
		}

		/* Try synchronous send first */
		uv_buf_t b = uv_buf_init((char *)data, size);
		int n = uv_udp_try_send(&d->handle, &b, 1, dest_ptr);
		if (n == (int)size) {
			return qn_new_resolved_promise(ctx, 0, NULL);
		}
		/* Unlike streams, UDP is all-or-nothing — no partial writes.
		 * If try_send fails with EAGAIN, do async send. */
		if (n >= 0) {
			/* Shouldn't happen for UDP but handle it */
			return qn_new_resolved_promise(ctx, 0, NULL);
		}
		if (n != UV_EAGAIN && n != UV_ENOSYS) {
			return qn_throw_errno(ctx, n);
		}

		/* Async send */
		QNSendReq *sr = js_malloc(ctx, sizeof(*sr));
		if (!sr) return JS_EXCEPTION;
		sr->ctx = ctx;
		sr->req.data = sr;
		sr->tarray = JS_DupValue(ctx, args[1]);
		b = uv_buf_init((char *)data, size);
		int r = uv_udp_send(&sr->req, &d->handle, &b, 1, dest_ptr,
		                     qn_dgram_send_cb);
		if (r < 0) {
			JS_FreeValue(ctx, sr->tarray);
			js_free(ctx, sr);
			return qn_throw_errno(ctx, r);
		}
		return qn_promise_init(ctx, &sr->result);
	}

	case DGRAM_RECV_START: {
		QNDgram *d = qn_dgram_get(ctx, args[0]);
		if (!d) return JS_EXCEPTION;
		int r = uv_udp_recv_start(&d->handle, qn_dgram_alloc_cb,
		                          qn_dgram_recv_cb);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	case DGRAM_RECV_STOP: {
		QNDgram *d = qn_dgram_get(ctx, args[0]);
		if (!d) return JS_EXCEPTION;
		uv_udp_recv_stop(&d->handle);
		return JS_UNDEFINED;
	}

	case DGRAM_CLOSE: {
		QNDgram *d = qn_dgram_get(ctx, args[0]);
		if (!d) return JS_EXCEPTION;
		if (!uv_is_closing((uv_handle_t *)&d->handle)) {
			uv_udp_recv_stop(&d->handle);
			uv_close((uv_handle_t *)&d->handle, qn_dgram_close_cb);
		}
		return JS_UNDEFINED;
	}

	case DGRAM_GETSOCKNAME: {
		QNDgram *d = qn_dgram_get(ctx, args[0]);
		if (!d) return JS_EXCEPTION;
		struct sockaddr_storage addr;
		int namelen = sizeof(addr);
		int r = uv_udp_getsockname(&d->handle, (struct sockaddr *)&addr,
		                           &namelen);
		if (r < 0) return qn_throw_errno(ctx, r);
		JSValue obj = JS_NewObject(ctx);
		qn_addr2obj(ctx, obj, (struct sockaddr *)&addr, false);
		return obj;
	}

	case DGRAM_SET_BROADCAST: {
		QNDgram *d = qn_dgram_get(ctx, args[0]);
		if (!d) return JS_EXCEPTION;
		int enable = JS_ToBool(ctx, args[1]);
		int r = uv_udp_set_broadcast(&d->handle, enable);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	case DGRAM_SET_TTL: {
		QNDgram *d = qn_dgram_get(ctx, args[0]);
		if (!d) return JS_EXCEPTION;
		int32_t ttl;
		if (JS_ToInt32(ctx, &ttl, args[1])) return JS_EXCEPTION;
		int r = uv_udp_set_ttl(&d->handle, ttl);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	case DGRAM_SET_MULTICAST_TTL: {
		QNDgram *d = qn_dgram_get(ctx, args[0]);
		if (!d) return JS_EXCEPTION;
		int32_t ttl;
		if (JS_ToInt32(ctx, &ttl, args[1])) return JS_EXCEPTION;
		int r = uv_udp_set_multicast_ttl(&d->handle, ttl);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	case DGRAM_SET_MULTICAST_LOOPBACK: {
		QNDgram *d = qn_dgram_get(ctx, args[0]);
		if (!d) return JS_EXCEPTION;
		int enable = JS_ToBool(ctx, args[1]);
		int r = uv_udp_set_multicast_loop(&d->handle, enable);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	case DGRAM_SET_ON_MESSAGE: {
		QNDgram *d = qn_dgram_get(ctx, args[0]);
		if (!d) return JS_EXCEPTION;
		JS_FreeValue(ctx, d->on_message);
		d->on_message = JS_DupValue(ctx, args[1]);
		return JS_UNDEFINED;
	}

	default:
		return JS_ThrowRangeError(ctx, "unknown dgram opcode: %d", op);
	}
}

/* ==== module definition ==== */

static const JSCFunctionListEntry js_uv_dgram_funcs[] = {
	QN_CFUNC_DEF("_op", 8, js_uv_dgram_op),
	/* Opcodes */
	QN_CONST2("NEW", DGRAM_NEW),
	QN_CONST2("BIND", DGRAM_BIND),
	QN_CONST2("SEND", DGRAM_SEND),
	QN_CONST2("RECV_START", DGRAM_RECV_START),
	QN_CONST2("RECV_STOP", DGRAM_RECV_STOP),
	QN_CONST2("CLOSE", DGRAM_CLOSE),
	QN_CONST2("GETSOCKNAME", DGRAM_GETSOCKNAME),
	QN_CONST2("SET_BROADCAST", DGRAM_SET_BROADCAST),
	QN_CONST2("SET_TTL", DGRAM_SET_TTL),
	QN_CONST2("SET_MULTICAST_TTL", DGRAM_SET_MULTICAST_TTL),
	QN_CONST2("SET_MULTICAST_LOOPBACK", DGRAM_SET_MULTICAST_LOOPBACK),
	QN_CONST2("SET_ON_MESSAGE", DGRAM_SET_ON_MESSAGE),
	/* Address family constants */
	QN_CONST(AF_INET),
	QN_CONST(AF_INET6),
	/* Bind flags */
	JS_PROP_INT32_DEF("UV_UDP_REUSEADDR", UV_UDP_REUSEADDR, JS_PROP_ENUMERABLE),
};

static int js_uv_dgram_init(JSContext *ctx, JSModuleDef *m) {
	JS_NewClassID(&qn_dgram_class_id);
	JS_NewClass(JS_GetRuntime(ctx), qn_dgram_class_id, &qn_dgram_class);
	return JS_SetModuleExportList(ctx, m, js_uv_dgram_funcs,
	                              countof(js_uv_dgram_funcs));
}

JSModuleDef *js_init_module_qn_uv_dgram(JSContext *ctx,
                                         const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_uv_dgram_init);
	if (!m) return NULL;
	JS_AddModuleExportList(ctx, m, js_uv_dgram_funcs, countof(js_uv_dgram_funcs));
	qn_vm_register_cleanup(qn_dgram_cleanup);
	return m;
}

void qn_dgram_cleanup(JSRuntime *rt) {
	for (QNDgram *d = dgram_head; d; d = d->next) {
		if (!JS_IsUndefined(d->this_val)) {
			JS_FreeValueRT(rt, d->this_val);
			d->this_val = JS_UNDEFINED;
		}
		if (!d->closed && !uv_is_closing((uv_handle_t *)&d->handle)) {
			uv_close((uv_handle_t *)&d->handle, qn_dgram_close_cb);
		}
	}
}
