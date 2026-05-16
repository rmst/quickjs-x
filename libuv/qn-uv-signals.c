/*
 * qn_uv_signals - Signal handling via libuv uv_signal_t
 *
 * Replaces QuickJS's os.signal() with libuv's native signal handling.
 * Each signal registration creates a uv_signal_t handle that is unref'd
 * (so signal handlers alone don't keep the event loop alive).
 *
 * Adapted from txiki.js signals.c by Saul Ibarra Corretge (MIT).
 */

#include "qn-uv-utils.h"
#include "qn-vm.h"

#include <string.h>

/* ---- SignalHandler opaque class ---- */

typedef struct QNSignalHandler {
	struct QNSignalHandler *next;
	JSContext *ctx;
	int closed;
	int finalized;
	uv_signal_t handle;
	int sig_num;
	JSValue func;
} QNSignalHandler;

static JSClassID qn_signal_handler_class_id;

/* Linked list of all live signal handlers, for shutdown cleanup. */
static QNSignalHandler *signal_head = NULL;

static void signal_link(QNSignalHandler *sh) {
	sh->next = signal_head;
	signal_head = sh;
}

static void signal_unlink(QNSignalHandler *sh) {
	QNSignalHandler **pp = &signal_head;
	while (*pp) {
		if (*pp == sh) { *pp = sh->next; return; }
		pp = &(*pp)->next;
	}
}

static void uv__signal_close_cb(uv_handle_t *handle) {
	QNSignalHandler *sh = handle->data;
	if (sh) {
		sh->closed = 1;
		if (sh->finalized) {
			signal_unlink(sh);
			js_free(sh->ctx, sh);
		}
	}
}

static void maybe_close(QNSignalHandler *sh) {
	if (!uv_is_closing((uv_handle_t *)&sh->handle))
		uv_close((uv_handle_t *)&sh->handle, uv__signal_close_cb);
}

static void qn_signal_handler_finalizer(JSRuntime *rt, JSValue val) {
	QNSignalHandler *sh = JS_GetOpaque(val, qn_signal_handler_class_id);
	if (sh) {
		JS_FreeValueRT(rt, sh->func);
		sh->finalized = 1;
		if (sh->closed) {
			signal_unlink(sh);
			js_free(sh->ctx, sh);
		} else {
			maybe_close(sh);
		}
	}
}

static void qn_signal_handler_mark(JSRuntime *rt, JSValue val, JS_MarkFunc *mark_func) {
	QNSignalHandler *sh = JS_GetOpaque(val, qn_signal_handler_class_id);
	if (sh)
		JS_MarkValue(rt, sh->func, mark_func);
}

static JSClassDef qn_signal_handler_class = {
	"SignalHandler",
	.finalizer = qn_signal_handler_finalizer,
	.gc_mark = qn_signal_handler_mark,
};

static void uv__signal_cb(uv_signal_t *handle, int sig_num) {
	QNSignalHandler *sh = handle->data;
	if (!sh) return;
	qn_call_handler(sh->ctx, sh->func, 0, NULL);
}

/* signal(signum, func) → SignalHandler object
 * The returned object has .close() to deregister and .signal getter. */
static JSValue js_uv_signal(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	int32_t sig_num;
	if (JS_ToInt32(ctx, &sig_num, argv[0]))
		return JS_EXCEPTION;

	JSValue func = argv[1];
	if (!JS_IsFunction(ctx, func))
		return JS_ThrowTypeError(ctx, "not a function");

	JSValue obj = JS_NewObjectClass(ctx, qn_signal_handler_class_id);
	if (JS_IsException(obj))
		return obj;

	QNSignalHandler *sh = js_mallocz(ctx, sizeof(*sh));
	if (!sh) {
		JS_FreeValue(ctx, obj);
		return JS_EXCEPTION;
	}

	int r = uv_signal_init(js_uv_loop(ctx), &sh->handle);
	if (r != 0) {
		JS_FreeValue(ctx, obj);
		js_free(ctx, sh);
		return JS_ThrowInternalError(ctx, "couldn't initialize Signal handle");
	}

	sh->ctx = ctx;
	sh->sig_num = sig_num;
	sh->handle.data = sh;

	r = uv_signal_start(&sh->handle, uv__signal_cb, sig_num);
	if (r != 0) {
		JS_FreeValue(ctx, obj);
		/* Handle was uv_signal_init'd — must close via uv_close */
		uv_close((uv_handle_t *)&sh->handle, uv__signal_close_cb);
		return qn_throw_errno(ctx, r);
	}

	/* Unref so signal handlers don't keep the event loop alive */
	uv_unref((uv_handle_t *)&sh->handle);

	sh->func = JS_DupValue(ctx, func);

	JS_SetOpaque(obj, sh);
	signal_link(sh);
	return obj;
}

static QNSignalHandler *qn_signal_handler_get(JSContext *ctx, JSValue obj) {
	return JS_GetOpaque2(ctx, obj, qn_signal_handler_class_id);
}

static JSValue js_uv_signal_close(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
	QNSignalHandler *sh = qn_signal_handler_get(ctx, this_val);
	if (!sh)
		return JS_EXCEPTION;
	maybe_close(sh);
	return JS_UNDEFINED;
}

static JSValue js_uv_signal_get(JSContext *ctx, JSValueConst this_val) {
	QNSignalHandler *sh = qn_signal_handler_get(ctx, this_val);
	if (!sh)
		return JS_EXCEPTION;
	const char *name = qn_getsig(sh->sig_num);
	return name ? JS_NewString(ctx, name) : JS_NULL;
}

static const JSCFunctionListEntry qn_signal_handler_proto_funcs[] = {
	QN_CFUNC_DEF("close", 0, js_uv_signal_close),
	QN_CGETSET_DEF("signal", js_uv_signal_get, NULL),
};

static const JSCFunctionListEntry js_uv_signal_funcs[] = {
	QN_CFUNC_DEF("signal", 2, js_uv_signal),
};

void qn_signals_cleanup(JSRuntime *rt) {
	/* Runtime shutdown: drop the JS callback ref and force-close any
	 * remaining handles so qn_vm_free's uv_loop_close doesn't see a busy
	 * loop. Signal handles are unref'd by default so a live one won't keep
	 * the event loop alive, which is exactly how they reach this path. */
	for (QNSignalHandler *sh = signal_head; sh; sh = sh->next) {
		if (!JS_IsUndefined(sh->func)) {
			JS_FreeValueRT(rt, sh->func);
			sh->func = JS_UNDEFINED;
		}
		if (!sh->closed && !uv_is_closing((uv_handle_t *)&sh->handle)) {
			uv_close((uv_handle_t *)&sh->handle, uv__signal_close_cb);
		}
	}
}

static int js_uv_signals_init(JSContext *ctx, JSModuleDef *m) {
	/* Register SignalHandler class */
	JS_NewClassID(&qn_signal_handler_class_id);
	JSRuntime *rt = JS_GetRuntime(ctx);
	JS_NewClass(rt, qn_signal_handler_class_id, &qn_signal_handler_class);
	JSValue proto = JS_NewObject(ctx);
	JS_SetPropertyFunctionList(ctx, proto, qn_signal_handler_proto_funcs,
		sizeof(qn_signal_handler_proto_funcs) / sizeof(qn_signal_handler_proto_funcs[0]));
	JS_SetClassProto(ctx, qn_signal_handler_class_id, proto);

	/* Export signal name → number map */
	JSValue signals = JS_NewObjectProto(ctx, JS_NULL);
	for (size_t i = 0; i < qn_signal_map_count; i++) {
		const char *name = qn_signal_map[i];
		if (name)
			JS_SetPropertyStr(ctx, signals, name, JS_NewInt32(ctx, i));
	}
	JS_SetModuleExport(ctx, m, "signals", signals);

	return JS_SetModuleExportList(ctx, m, js_uv_signal_funcs,
		sizeof(js_uv_signal_funcs) / sizeof(js_uv_signal_funcs[0]));
}

JSModuleDef *js_init_module_qn_uv_signals(JSContext *ctx, const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_uv_signals_init);
	if (!m)
		return NULL;
	JS_AddModuleExportList(ctx, m, js_uv_signal_funcs,
		sizeof(js_uv_signal_funcs) / sizeof(js_uv_signal_funcs[0]));
	JS_AddModuleExport(ctx, m, "signals");
	qn_vm_register_cleanup(qn_signals_cleanup);
	return m;
}
