/*
 * qn-vm.c - Event loop ownership, eval, and core async primitives
 *
 * Owns the libuv event loop and provides:
 * - Timer/poll primitives (setTimeout, setReadHandler, etc.)
 * - qn_vm_eval_binary / qn_vm_loop to replace js_std_eval_binary / js_std_loop
 * - Promise rejection tracking
 *
 * Uses the three-handle pattern from txiki.js (uv_prepare + uv_idle + uv_check)
 * to integrate microtask draining into uv_run. No patches to quickjs-libc.c needed.
 *
 * Adapted from txiki.js by Saul Ibarra Corretge (MIT License).
 */

#include "qn-vm.h"
#include "qn-uv-utils.h"
#include "quickjs/quickjs-libc.h"

/* --------------------------------------------------------------------------
 * Source transform hook (per-thread)
 *
 * Stores a JS function fn(source, filename) -> source for TypeScript
 * stripping etc. Each thread registers its own via qn_set_source_transform().
 * -------------------------------------------------------------------------- */

static _Thread_local int g_source_transform_set = 0;
static _Thread_local JSValue g_source_transform_fn;
static _Thread_local JSContext *g_source_transform_ctx = NULL;

void qn_set_source_transform(JSContext *ctx, JSValue fn) {
	if (g_source_transform_set && g_source_transform_ctx) {
		JS_FreeValue(g_source_transform_ctx, g_source_transform_fn);
	}
	g_source_transform_fn = JS_DupValue(ctx, fn);
	g_source_transform_ctx = ctx;
	g_source_transform_set = 1;
}

void qn_free_source_transform(JSRuntime *rt) {
	if (g_source_transform_set) {
		JS_FreeValueRT(rt, g_source_transform_fn);
		g_source_transform_set = 0;
		g_source_transform_ctx = NULL;
	}
}

uint8_t *qn_apply_source_transform(JSContext *ctx, uint8_t *buf,
                                    size_t buf_len, const char *filename,
                                    size_t *out_len) {
	*out_len = buf_len;
	if (!g_source_transform_set)
		return buf;
	JSValue args[2];
	args[0] = JS_NewStringLen(ctx, (char *)buf, buf_len);
	args[1] = JS_NewString(ctx, filename);
	js_free(ctx, buf);
	JSValue result = JS_Call(ctx, g_source_transform_fn, JS_UNDEFINED, 2, args);
	JS_FreeValue(ctx, args[0]);
	JS_FreeValue(ctx, args[1]);
	if (JS_IsException(result))
		return NULL;
	size_t new_len;
	const char *str = JS_ToCStringLen(ctx, &new_len, result);
	JS_FreeValue(ctx, result);
	if (!str)
		return NULL;
	uint8_t *new_buf = js_malloc(ctx, new_len + 1);
	if (!new_buf) {
		JS_FreeCString(ctx, str);
		return NULL;
	}
	memcpy(new_buf, str, new_len + 1);
	*out_len = new_len;
	JS_FreeCString(ctx, str);
	return new_buf;
}

JSValue js_qn_set_source_transform(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
	qn_set_source_transform(ctx, argv[0]);
	return JS_UNDEFINED;
}

/* --------------------------------------------------------------------------
 * Module resolver fallback hook (per-thread)
 *
 * Consulted when the C resolver has exhausted its normal bare-import search
 * (NODE_PATH, node_modules) and would otherwise return an unresolved name.
 * Registered from JS via globalThis.__qn_setModuleResolverFallback(fn). Used
 * to apply TypeScript tsconfig.json `compilerOptions.paths` at runtime.
 * -------------------------------------------------------------------------- */

static _Thread_local int g_resolver_fallback_set = 0;
static _Thread_local JSValue g_resolver_fallback_fn;
static _Thread_local JSContext *g_resolver_fallback_ctx = NULL;

void qn_set_module_resolver_fallback(JSContext *ctx, JSValue fn) {
	if (g_resolver_fallback_set && g_resolver_fallback_ctx) {
		JS_FreeValue(g_resolver_fallback_ctx, g_resolver_fallback_fn);
	}
	g_resolver_fallback_fn = JS_DupValue(ctx, fn);
	g_resolver_fallback_ctx = ctx;
	g_resolver_fallback_set = 1;
}

void qn_free_module_resolver_fallback(JSRuntime *rt) {
	if (g_resolver_fallback_set) {
		JS_FreeValueRT(rt, g_resolver_fallback_fn);
		g_resolver_fallback_set = 0;
		g_resolver_fallback_ctx = NULL;
	}
}

char *qn_apply_module_resolver_fallback(JSContext *ctx, const char *specifier,
                                          const char *base_name) {
	if (!g_resolver_fallback_set)
		return NULL;
	JSValue args[2];
	args[0] = JS_NewString(ctx, specifier ? specifier : "");
	args[1] = JS_NewString(ctx, base_name ? base_name : "");
	JSValue result = JS_Call(ctx, g_resolver_fallback_fn, JS_UNDEFINED, 2, args);
	JS_FreeValue(ctx, args[0]);
	JS_FreeValue(ctx, args[1]);
	if (JS_IsException(result)) {
		JS_FreeValue(ctx, result);
		return NULL;
	}
	if (!JS_IsString(result)) {
		JS_FreeValue(ctx, result);
		return NULL;
	}
	size_t len;
	const char *s = JS_ToCStringLen(ctx, &len, result);
	JS_FreeValue(ctx, result);
	if (!s || len == 0) {
		if (s) JS_FreeCString(ctx, s);
		return NULL;
	}
	char *out = js_malloc(ctx, len + 1);
	if (!out) {
		JS_FreeCString(ctx, s);
		return NULL;
	}
	memcpy(out, s, len + 1);
	JS_FreeCString(ctx, s);
	return out;
}

JSValue js_qn_set_module_resolver_fallback(JSContext *ctx, JSValueConst this_val,
                                             int argc, JSValueConst *argv) {
	qn_set_module_resolver_fallback(ctx, argv[0]);
	return JS_UNDEFINED;
}

/* --------------------------------------------------------------------------
 * evalModule: evaluate a string as an ES module
 *
 * Compiles and runs the source as JS_EVAL_TYPE_MODULE, sets import.meta,
 * and returns the resulting promise (which resolves once the module is
 * fully evaluated, including any top-level await).
 *
 * Exposed as globalThis.__qn_evalModule(code) so that `qn -e` and `qx -e`
 * can support top-level import/export without patching quickjs-libc.c.
 * -------------------------------------------------------------------------- */
JSValue js_qn_eval_module(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
	if (argc < 1)
		return JS_ThrowTypeError(ctx, "evalModule: missing code argument");
	size_t len;
	const char *str = JS_ToCStringLen(ctx, &len, argv[0]);
	if (!str)
		return JS_EXCEPTION;
	JSValue obj = JS_Eval(ctx, str, len, "<evalModule>",
	                      JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
	JS_FreeCString(ctx, str);
	if (JS_IsException(obj))
		return obj;
	js_module_set_import_meta(ctx, obj, FALSE, TRUE);
	return JS_EvalFunction(ctx, obj);
}

#include <string.h>
#if !defined(_WIN32)
#include <termios.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <signal.h>
#include <pwd.h>
#include <grp.h>
#endif

/* --------------------------------------------------------------------------
 * Cleanup callback registry
 *
 * All static state is _Thread_local so each thread (main + workers) gets
 * its own event loop, timers, polls, and rejection tracking.
 * -------------------------------------------------------------------------- */

#define MAX_CLEANUP_FNS 8
static _Thread_local qn_cleanup_fn g_cleanup_fns[MAX_CLEANUP_FNS];
static _Thread_local int g_cleanup_count = 0;

void qn_vm_register_cleanup(qn_cleanup_fn fn) {
	if (g_cleanup_count < MAX_CLEANUP_FNS)
		g_cleanup_fns[g_cleanup_count++] = fn;
}

/* --------------------------------------------------------------------------
 * Loop ownership
 * -------------------------------------------------------------------------- */

static _Thread_local uv_loop_t *g_loop = NULL;
static _Thread_local JSContext *g_ctx = NULL;

/* Three-handle pattern for microtask draining during uv_run */
static _Thread_local uv_prepare_t g_prepare;
static _Thread_local uv_idle_t g_idle;
static _Thread_local uv_check_t g_check;

uv_loop_t *js_uv_loop(JSContext *ctx) {
	(void)ctx;
	return g_loop;
}

/* --------------------------------------------------------------------------
 * Promise rejection tracking
 *
 * We track unhandled rejections ourselves via JS_SetHostPromiseRejectionTracker.
 * If any remain unhandled when the loop is about to sleep, we report and exit.
 * -------------------------------------------------------------------------- */

typedef struct QNRejection {
	struct QNRejection *next;
	JSValue promise;
	JSValue reason;
} QNRejection;

static _Thread_local QNRejection *rejection_head = NULL;

static void rejection_tracker(JSContext *ctx, JSValueConst promise,
                               JSValueConst reason, JS_BOOL is_handled,
                               void *opaque) {
	(void)opaque;

	if (!is_handled) {
		/* Add new unhandled rejection */
		QNRejection *r = malloc(sizeof(QNRejection));
		if (!r) return;
		r->promise = JS_DupValue(ctx, promise);
		r->reason = JS_DupValue(ctx, reason);
		r->next = rejection_head;
		rejection_head = r;
	} else {
		/* Rejection was handled — remove from list */
		QNRejection **pp = &rejection_head;
		while (*pp) {
			if (JS_SameValue(ctx, (*pp)->promise, promise)) {
				QNRejection *r = *pp;
				*pp = r->next;
				JS_FreeValue(ctx, r->promise);
				JS_FreeValue(ctx, r->reason);
				free(r);
				return;
			}
			pp = &(*pp)->next;
		}
	}
}

static void rejection_check(JSContext *ctx) {
	if (!rejection_head) return;

	for (QNRejection *r = rejection_head; r; r = r->next) {
		fprintf(stderr, "Possibly unhandled promise rejection: ");
		JSValue err_str = JS_ToString(ctx, r->reason);
		const char *s = JS_ToCString(ctx, err_str);
		if (s) {
			fprintf(stderr, "%s\n", s);
			JS_FreeCString(ctx, s);
		}
		JS_FreeValue(ctx, err_str);

		/* Also print stack if available */
		if (JS_IsObject(r->reason)) {
			JSValue stack = JS_GetPropertyStr(ctx, r->reason, "stack");
			if (!JS_IsUndefined(stack)) {
				const char *stack_str = JS_ToCString(ctx, stack);
				if (stack_str) {
					fprintf(stderr, "%s\n", stack_str);
					JS_FreeCString(ctx, stack_str);
				}
			}
			JS_FreeValue(ctx, stack);
		}
	}
	exit(1);
}

static void rejection_free_all(JSRuntime *rt) {
	while (rejection_head) {
		QNRejection *r = rejection_head;
		rejection_head = r->next;
		JS_FreeValueRT(rt, r->promise);
		JS_FreeValueRT(rt, r->reason);
		free(r);
	}
}

/* --------------------------------------------------------------------------
 * Timer system — setTimeout / clearTimeout backed by uv_timer_t
 * -------------------------------------------------------------------------- */

typedef struct QNTimer {
	struct QNTimer *next;
	uv_timer_t handle;
	JSContext *ctx;
	JSValue func;
	int id;
	bool closed;
} QNTimer;

static _Thread_local QNTimer *timer_head = NULL;
static _Thread_local int next_timer_id = 1;  /* wraps to 1 on overflow, skipping 0 */

static void timer_unlink(QNTimer *t) {
	QNTimer **pp = &timer_head;
	while (*pp) {
		if (*pp == t) { *pp = t->next; return; }
		pp = &(*pp)->next;
	}
}

static void timer_close_cb(uv_handle_t *h) {
	QNTimer *t = h->data;
	timer_unlink(t);
	js_free_rt(JS_GetRuntime(t->ctx), t);
}

static void timer_cb(uv_timer_t *h) {
	QNTimer *t = h->data;
	JSContext *ctx = t->ctx;

	/* Take ownership of the callback, then destroy the timer */
	JSValue func = t->func;
	t->func = JS_UNDEFINED;
	t->closed = true;
	uv_timer_stop(&t->handle);
	uv_close((uv_handle_t *)&t->handle, timer_close_cb);

	/* Call the handler (may re-enter) */
	qn_call_handler(ctx, func, 0, NULL);
	JS_FreeValue(ctx, func);
}

static QNTimer *timer_find(int id) {
	for (QNTimer *t = timer_head; t; t = t->next) {
		if (t->id == id && !t->closed) return t;
	}
	return NULL;
}

/* JS: setTimeout(func, delay) → timer_id */
static JSValue js_vm_setTimeout(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	JSValue func = argv[0];
	if (!JS_IsFunction(ctx, func))
		return JS_ThrowTypeError(ctx, "setTimeout: first argument must be a function");

	int64_t delay = 0;
	if (argc > 1) JS_ToInt64(ctx, &delay, argv[1]);
	if (delay < 0) delay = 0;

	QNTimer *t = js_malloc(ctx, sizeof(QNTimer));
	if (!t) return JS_EXCEPTION;

	t->id = next_timer_id++;
	if (next_timer_id <= 0) next_timer_id = 1;
	t->ctx = ctx;
	t->func = JS_DupValue(ctx, func);
	t->closed = false;
	t->next = timer_head;
	timer_head = t;

	uv_timer_init(g_loop, &t->handle);
	t->handle.data = t;
	/* Refresh the loop's cached "now" so the timer deadline is based on
	   current wall-clock time, not the (possibly stale) value from the
	   start of this loop iteration.  Without this, timers started from
	   JS callbacks can fire early by the amount of time spent in JS
	   since the last uv_run poll.  See libuv/libuv#1105. */
	uv_update_time(g_loop);
	uv_timer_start(&t->handle, timer_cb, (uint64_t)delay, 0);

	return JS_NewInt32(ctx, t->id);
}

/* JS: timerUnref(timer_id) — stop timer from keeping event loop alive */
static JSValue js_vm_timerUnref(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	int id;
	if (JS_ToInt32(ctx, &id, argv[0]))
		return JS_EXCEPTION;
	QNTimer *t = timer_find(id);
	if (t)
		uv_unref((uv_handle_t *)&t->handle);
	return JS_UNDEFINED;
}

/* JS: timerRef(timer_id) — re-ref timer so it keeps event loop alive */
static JSValue js_vm_timerRef(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	int id;
	if (JS_ToInt32(ctx, &id, argv[0]))
		return JS_EXCEPTION;
	QNTimer *t = timer_find(id);
	if (t)
		uv_ref((uv_handle_t *)&t->handle);
	return JS_UNDEFINED;
}

/* JS: clearTimeout(timer_id) */
static JSValue js_vm_clearTimeout(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
	int id;
	if (JS_ToInt32(ctx, &id, argv[0]))
		return JS_EXCEPTION;

	QNTimer *t = timer_find(id);
	if (t) {
		JS_FreeValue(ctx, t->func);
		t->func = JS_UNDEFINED;
		t->closed = true;
		uv_timer_stop(&t->handle);
		uv_close((uv_handle_t *)&t->handle, timer_close_cb);
	}
	return JS_UNDEFINED;
}

/* --------------------------------------------------------------------------
 * Poll system — setReadHandler / setWriteHandler backed by uv_poll_t
 * -------------------------------------------------------------------------- */

typedef struct QNPoll {
	struct QNPoll *next;
	uv_poll_t handle;
	JSContext *ctx;
	JSValue rw_func[2]; /* [0]=read, [1]=write */
	int fd;
	bool handle_inited;
} QNPoll;

static _Thread_local QNPoll *poll_head = NULL;

static QNPoll *poll_find(int fd) {
	for (QNPoll *p = poll_head; p; p = p->next) {
		if (p->fd == fd) return p;
	}
	return NULL;
}

static void poll_unlink(QNPoll *p) {
	QNPoll **pp = &poll_head;
	while (*pp) {
		if (*pp == p) { *pp = p->next; return; }
		pp = &(*pp)->next;
	}
}

static void poll_close_cb(uv_handle_t *h) {
	QNPoll *p = h->data;
	/* Entry was already unlinked in poll_free_entry; just free */
	js_free_rt(JS_GetRuntime(p->ctx), p);
}

static void poll_cb(uv_poll_t *h, int status, int events) {
	QNPoll *p = h->data;
	JSContext *ctx = p->ctx;
	if (status < 0) return;

	if ((events & UV_READABLE) && !JS_IsNull(p->rw_func[0]))
		qn_call_handler(ctx, p->rw_func[0], 0, NULL);
	if ((events & UV_WRITABLE) && !JS_IsNull(p->rw_func[1]))
		qn_call_handler(ctx, p->rw_func[1], 0, NULL);
}

static void poll_update(QNPoll *p) {
	int events = 0;
	if (!JS_IsNull(p->rw_func[0])) events |= UV_READABLE;
	if (!JS_IsNull(p->rw_func[1])) events |= UV_WRITABLE;

	if (events == 0) {
		if (p->handle_inited) {
			uv_poll_stop(&p->handle);
		}
		return;
	}
	if (!p->handle_inited) {
		uv_poll_init(g_loop, &p->handle, p->fd);
		p->handle.data = p;
		p->handle_inited = true;
	}
	uv_poll_start(&p->handle, events, poll_cb);
}

static void poll_free_entry(JSRuntime *rt, QNPoll *p) {
	JS_FreeValueRT(rt, p->rw_func[0]);
	JS_FreeValueRT(rt, p->rw_func[1]);
	/* Unlink immediately so poll_find() won't return a stale/closing entry */
	poll_unlink(p);
	if (p->handle_inited) {
		uv_poll_stop(&p->handle);
		uv_close((uv_handle_t *)&p->handle, poll_close_cb);
	} else {
		js_free_rt(rt, p);
	}
}

/* JS: setReadHandler(fd, func|null)  — magic=0
 * JS: setWriteHandler(fd, func|null) — magic=1 */
static JSValue js_vm_setRWHandler(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv, int magic) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	JSValue func = (argc > 1) ? argv[1] : JS_NULL;
	if (JS_IsUndefined(func)) func = JS_NULL;
	if (!JS_IsNull(func) && !JS_IsFunction(ctx, func))
		return JS_ThrowTypeError(ctx, "handler must be a function or null");

	QNPoll *p = poll_find(fd);

	if (JS_IsNull(func)) {
		/* Clearing a handler */
		if (p) {
			JS_FreeValue(ctx, p->rw_func[magic]);
			p->rw_func[magic] = JS_NULL;
			if (JS_IsNull(p->rw_func[0]) && JS_IsNull(p->rw_func[1])) {
				/* Both handlers cleared — remove entry */
				poll_free_entry(JS_GetRuntime(ctx), p);
			} else {
				poll_update(p);
			}
		}
	} else {
		/* Setting a handler */
		if (!p) {
			p = js_malloc(ctx, sizeof(QNPoll));
			if (!p) return JS_EXCEPTION;
			p->fd = fd;
			p->ctx = ctx;
			p->rw_func[0] = JS_NULL;
			p->rw_func[1] = JS_NULL;
			p->handle_inited = false;
			p->next = poll_head;
			poll_head = p;
		}
		JS_FreeValue(ctx, p->rw_func[magic]);
		p->rw_func[magic] = JS_DupValue(ctx, func);
		poll_update(p);
	}

	return JS_UNDEFINED;
}

/* --------------------------------------------------------------------------
 * Three-handle pattern for microtask draining
 *
 * Like txiki.js: uv_prepare + uv_idle + uv_check integrate JS job execution
 * into libuv's event loop. The idle handle prevents libuv from blocking in
 * I/O poll when there are pending JS jobs.
 * -------------------------------------------------------------------------- */

static void execute_jobs(JSContext *ctx) {
	int err;
	for (;;) {
		err = JS_ExecutePendingJob(JS_GetRuntime(ctx), NULL);
		if (err <= 0) {
			if (err < 0)
				js_std_dump_error(ctx);
			break;
		}
	}
}

static void idle_cb(uv_idle_t *handle) {
	/* noop — just prevents uv_run from blocking */
}

static void maybe_idle(void) {
	JSRuntime *rt = JS_GetRuntime(g_ctx);
	if (JS_IsJobPending(rt))
		uv_idle_start(&g_idle, idle_cb);
	else
		uv_idle_stop(&g_idle);
}

static void prepare_cb(uv_prepare_t *handle) {
	maybe_idle();
}

static void check_cb(uv_check_t *handle) {
	execute_jobs(g_ctx);
	rejection_check(g_ctx);
	maybe_idle();
}

/* --------------------------------------------------------------------------
 * randomFill(size) → Uint8Array
 *
 * Fills a new buffer with cryptographically strong random bytes via uv_random()
 * (getrandom(2) on Linux, getentropy() on macOS, BCryptGenRandom on Windows).
 * Replaces the /dev/urandom approach in node:crypto.
 *
 * Uses NULL loop for synchronous operation (same as txiki.js).
 * Node.js uses OpenSSL's RAND_bytes instead since it already bundles OpenSSL.
 * -------------------------------------------------------------------------- */

static JSValue js_vm_randomFill(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
	int64_t size;
	if (JS_ToInt64(ctx, &size, argv[0]))
		return JS_EXCEPTION;
	if (size < 0 || size > 256 * 1024)
		return JS_ThrowRangeError(ctx, "size must be 0..262144");

	uint8_t *buf = js_malloc(ctx, size ? size : 1);
	if (!buf) return JS_EXCEPTION;

	if (size > 0) {
		int r = uv_random(NULL, NULL, buf, (size_t)size, 0, NULL);
		if (r != 0) {
			js_free(ctx, buf);
			return qn_throw_errno(ctx, r);
		}
	}

	return qn_new_uint8array(ctx, buf, (size_t)size);
}

/* --------------------------------------------------------------------------
 * Process / TTY utilities
 *
 * Simple POSIX + libuv wrappers for process and terminal operations.
 * isatty uses uv_guess_handle (portable).
 * ttyGetWinSize/ttySetRaw use POSIX directly (libuv requires uv_tty_t handle).
 * cwd/chdir/kill/pid/hrtime use libuv utility functions.
 * -------------------------------------------------------------------------- */

/* JS: isatty(fd) → boolean */
static JSValue js_vm_isatty(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;
	return JS_NewBool(ctx, uv_guess_handle(fd) == UV_TTY);
}

#if !defined(_WIN32)
/* JS: ttyGetWinSize(fd) → [cols, rows] or null */
static JSValue js_vm_ttyGetWinSize(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;
	struct winsize ws;
	if (ioctl(fd, TIOCGWINSZ, &ws) < 0)
		return JS_NULL;
	JSValue arr = JS_NewArray(ctx);
	JS_DefinePropertyValueUint32(ctx, arr, 0,
		JS_NewInt32(ctx, ws.ws_col), JS_PROP_C_W_E);
	JS_DefinePropertyValueUint32(ctx, arr, 1,
		JS_NewInt32(ctx, ws.ws_row), JS_PROP_C_W_E);
	return arr;
}

/* JS: ttySetRaw(fd) → undefined
 * Sets terminal to raw mode, matching QuickJS os.ttySetRaw behavior. */
static JSValue js_vm_ttySetRaw(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;
	struct termios tty;
	if (tcgetattr(fd, &tty) < 0)
		return qn_throw_errno(ctx, -errno);
	tty.c_iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP |
	                  INLCR | IGNCR | ICRNL | IXON);
	tty.c_oflag |= OPOST;
	tty.c_cflag &= ~(CSIZE | PARENB);
	tty.c_cflag |= CS8;
	tty.c_lflag &= ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
	tty.c_cc[VMIN] = 1;
	tty.c_cc[VTIME] = 0;
	if (tcsetattr(fd, TCSANOW, &tty) < 0)
		return qn_throw_errno(ctx, -errno);
	return JS_UNDEFINED;
}
#endif

/* JS: getCwd() → string */
static JSValue js_vm_getCwd(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	char buf[4096];
	size_t size = sizeof(buf);
	int r = uv_cwd(buf, &size);
	if (r != 0)
		return qn_throw_errno(ctx, r);
	return JS_NewStringLen(ctx, buf, size);
}

/* JS: chdir(path) → undefined */
static JSValue js_vm_chdir(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	int r = uv_chdir(path);
	JS_FreeCString(ctx, path);
	if (r != 0)
		return qn_throw_errno(ctx, r);
	return JS_UNDEFINED;
}

/* JS: kill(pid, sig) → undefined */
static JSValue js_vm_kill(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	int pid, sig;
	if (JS_ToInt32(ctx, &pid, argv[0])) return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &sig, argv[1])) return JS_EXCEPTION;
	int r = uv_kill(pid, sig);
	if (r != 0)
		return qn_throw_errno(ctx, r);
	return JS_UNDEFINED;
}

/* JS: getPid() → number */
static JSValue js_vm_getPid(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	return JS_NewInt32(ctx, uv_os_getpid());
}

/* JS: hrtime() → number (milliseconds, high resolution)
 * Uses uv_hrtime() which returns nanoseconds. */
static JSValue js_vm_hrtime(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	return JS_NewFloat64(ctx, (double)uv_hrtime() / 1e6);
}

/* JS: hrtimeBigInt() → bigint (nanoseconds, high resolution)
 * Returns the raw uv_hrtime() value as a BigInt for full precision. */
static JSValue js_vm_hrtimeBigInt(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
	return JS_NewBigUint64(ctx, uv_hrtime());
}

/* JS: getPlatform() → string ("linux", "darwin", etc.) */
static JSValue js_vm_getPlatform(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
	uv_utsname_t info;
	int r = uv_os_uname(&info);
	if (r != 0)
		return qn_throw_errno(ctx, r);
	/* Lowercase the sysname to match Node.js convention */
	for (char *p = info.sysname; *p; p++)
		*p = (*p >= 'A' && *p <= 'Z') ? *p + 32 : *p;
	return JS_NewString(ctx, info.sysname);
}

/* JS: getExecPath() → string (absolute path to the current executable) */
static JSValue js_vm_getExecPath(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
	char buf[4096];
	size_t size = sizeof(buf);
	int r = uv_exepath(buf, &size);
	if (r != 0)
		return qn_throw_errno(ctx, r);
	return JS_NewStringLen(ctx, buf, size);
}

/* JS: getArch() → string ("x64", "arm64", etc.) */
static JSValue js_vm_getArch(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	uv_utsname_t info;
	int r = uv_os_uname(&info);
	if (r != 0)
		return qn_throw_errno(ctx, r);
	const char *machine = info.machine;
	const char *arch;
	if (strcmp(machine, "x86_64") == 0 || strcmp(machine, "amd64") == 0)
		arch = "x64";
	else if (strcmp(machine, "aarch64") == 0 || strcmp(machine, "arm64") == 0)
		arch = "arm64";
	else if (strcmp(machine, "armv7l") == 0)
		arch = "arm";
	else if (strcmp(machine, "i686") == 0 || strcmp(machine, "i386") == 0)
		arch = "ia32";
	else
		arch = machine;
	return JS_NewString(ctx, arch);
}

/* --------------------------------------------------------------------------
 * UID / GID helpers (POSIX only)
 * -------------------------------------------------------------------------- */

#if !defined(_WIN32)

/* Resolve a JS value to a uid_t: accepts number or username string */
static int resolve_uid(JSContext *ctx, JSValueConst val, uid_t *out) {
	if (JS_IsNumber(val)) {
		uint32_t n;
		if (JS_ToUint32(ctx, &n, val)) return -1;
		*out = (uid_t)n;
		return 0;
	}
	const char *name = JS_ToCString(ctx, val);
	if (!name) return -1;
	struct passwd *pw = getpwnam(name);
	JS_FreeCString(ctx, name);
	if (!pw) {
		JS_ThrowRangeError(ctx, "Unknown user");
		return -1;
	}
	*out = pw->pw_uid;
	return 0;
}

/* Resolve a JS value to a gid_t: accepts number or group name string */
static int resolve_gid(JSContext *ctx, JSValueConst val, gid_t *out) {
	if (JS_IsNumber(val)) {
		uint32_t n;
		if (JS_ToUint32(ctx, &n, val)) return -1;
		*out = (gid_t)n;
		return 0;
	}
	const char *name = JS_ToCString(ctx, val);
	if (!name) return -1;
	struct group *gr = getgrnam(name);
	JS_FreeCString(ctx, name);
	if (!gr) {
		JS_ThrowRangeError(ctx, "Unknown group");
		return -1;
	}
	*out = gr->gr_gid;
	return 0;
}

static JSValue js_vm_getuid(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	return JS_NewInt32(ctx, getuid());
}

static JSValue js_vm_getgid(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	return JS_NewInt32(ctx, getgid());
}

static JSValue js_vm_getgroups(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	int n = getgroups(0, NULL);
	if (n < 0)
		return JS_ThrowInternalError(ctx, "getgroups failed");
	gid_t *gids = js_malloc(ctx, n * sizeof(gid_t));
	if (!gids) return JS_EXCEPTION;
	if (getgroups(n, gids) < 0) {
		js_free(ctx, gids);
		return JS_ThrowInternalError(ctx, "getgroups failed");
	}
	JSValue arr = JS_NewArray(ctx);
	for (int i = 0; i < n; i++)
		JS_SetPropertyUint32(ctx, arr, i, JS_NewUint32(ctx, gids[i]));
	js_free(ctx, gids);
	return arr;
}

static JSValue js_vm_setuid(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	uid_t uid;
	if (resolve_uid(ctx, argv[0], &uid)) return JS_EXCEPTION;
	if (setuid(uid) != 0)
		return JS_ThrowInternalError(ctx, "setuid failed: %s", strerror(errno));
	return JS_UNDEFINED;
}

static JSValue js_vm_setgid(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	gid_t gid;
	if (resolve_gid(ctx, argv[0], &gid)) return JS_EXCEPTION;
	if (setgid(gid) != 0)
		return JS_ThrowInternalError(ctx, "setgid failed: %s", strerror(errno));
	return JS_UNDEFINED;
}

static JSValue js_vm_setgroups(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	JSValue len_val = JS_GetPropertyStr(ctx, argv[0], "length");
	uint32_t len;
	if (JS_ToUint32(ctx, &len, len_val)) {
		JS_FreeValue(ctx, len_val);
		return JS_EXCEPTION;
	}
	JS_FreeValue(ctx, len_val);
	gid_t *gids = js_malloc(ctx, (len ? len : 1) * sizeof(gid_t));
	if (!gids) return JS_EXCEPTION;
	for (uint32_t i = 0; i < len; i++) {
		JSValue v = JS_GetPropertyUint32(ctx, argv[0], i);
		int r = resolve_gid(ctx, v, &gids[i]);
		JS_FreeValue(ctx, v);
		if (r) { js_free(ctx, gids); return JS_EXCEPTION; }
	}
	if (setgroups(len, gids) != 0) {
		js_free(ctx, gids);
		return JS_ThrowInternalError(ctx, "setgroups failed: %s", strerror(errno));
	}
	js_free(ctx, gids);
	return JS_UNDEFINED;
}

#endif /* !_WIN32 */

/* JS: getUserInfo(user?) → { uid, gid, username, homedir, shell }
 * No args: current user. Number: lookup by uid. String: lookup by name (POSIX).
 * Uses libuv for cross-platform support; string lookup requires POSIX getpwnam. */
static JSValue js_vm_getUserInfo(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
	uv_passwd_t pwd;
	int r;
	if (argc >= 1 && JS_IsNumber(argv[0])) {
		uint32_t uid;
		if (JS_ToUint32(ctx, &uid, argv[0])) return JS_EXCEPTION;
		r = uv_os_get_passwd2(&pwd, uid);
#if !defined(_WIN32)
	} else if (argc >= 1 && JS_IsString(argv[0])) {
		const char *name = JS_ToCString(ctx, argv[0]);
		if (!name) return JS_EXCEPTION;
		struct passwd *pw = getpwnam(name);
		JS_FreeCString(ctx, name);
		if (!pw)
			return JS_ThrowRangeError(ctx, "Unknown user");
		r = uv_os_get_passwd2(&pwd, pw->pw_uid);
#endif
	} else {
		r = uv_os_get_passwd(&pwd);
	}
	if (r != 0)
		return qn_throw_errno(ctx, r);
	JSValue obj = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, obj, "uid", JS_NewUint32(ctx, pwd.uid));
	JS_SetPropertyStr(ctx, obj, "gid", JS_NewUint32(ctx, pwd.gid));
	JS_SetPropertyStr(ctx, obj, "username", JS_NewString(ctx, pwd.username));
	JS_SetPropertyStr(ctx, obj, "homedir", JS_NewString(ctx, pwd.homedir));
	JS_SetPropertyStr(ctx, obj, "shell", JS_NewString(ctx, pwd.shell ? pwd.shell : ""));
	uv_os_free_passwd(&pwd);
	return obj;
}

/* --------------------------------------------------------------------------
 * JS module: qn_vm
 * -------------------------------------------------------------------------- */

static const JSCFunctionListEntry vm_funcs[] = {
	QN_CFUNC_DEF("setTimeout", 2, js_vm_setTimeout),
	QN_CFUNC_DEF("clearTimeout", 1, js_vm_clearTimeout),
	QN_CFUNC_DEF("timerRef", 1, js_vm_timerRef),
	QN_CFUNC_DEF("timerUnref", 1, js_vm_timerUnref),
	QN_CFUNC_MAGIC_DEF("setReadHandler", 2, js_vm_setRWHandler, 0),
	QN_CFUNC_MAGIC_DEF("setWriteHandler", 2, js_vm_setRWHandler, 1),
	QN_CFUNC_DEF("randomFill", 1, js_vm_randomFill),
	QN_CFUNC_DEF("isatty", 1, js_vm_isatty),
#if !defined(_WIN32)
	QN_CFUNC_DEF("ttyGetWinSize", 1, js_vm_ttyGetWinSize),
	QN_CFUNC_DEF("ttySetRaw", 1, js_vm_ttySetRaw),
#endif
	QN_CFUNC_DEF("getCwd", 0, js_vm_getCwd),
	QN_CFUNC_DEF("chdir", 1, js_vm_chdir),
	QN_CFUNC_DEF("kill", 2, js_vm_kill),
	QN_CFUNC_DEF("getPid", 0, js_vm_getPid),
	QN_CFUNC_DEF("hrtime", 0, js_vm_hrtime),
	QN_CFUNC_DEF("hrtimeBigInt", 0, js_vm_hrtimeBigInt),
	QN_CFUNC_DEF("getPlatform", 0, js_vm_getPlatform),
	QN_CFUNC_DEF("getArch", 0, js_vm_getArch),
	QN_CFUNC_DEF("getExecPath", 0, js_vm_getExecPath),
	QN_CFUNC_DEF("getUserInfo", 1, js_vm_getUserInfo),
#if !defined(_WIN32)
	QN_CFUNC_DEF("getuid", 0, js_vm_getuid),
	QN_CFUNC_DEF("getgid", 0, js_vm_getgid),
	QN_CFUNC_DEF("getgroups", 0, js_vm_getgroups),
	QN_CFUNC_DEF("setuid", 1, js_vm_setuid),
	QN_CFUNC_DEF("setgid", 1, js_vm_setgid),
	QN_CFUNC_DEF("setgroups", 1, js_vm_setgroups),
#endif
};

static int js_vm_module_init(JSContext *ctx, JSModuleDef *m) {
	return JS_SetModuleExportList(ctx, m, vm_funcs, countof(vm_funcs));
}

JSModuleDef *js_init_module_qn_vm(JSContext *ctx, const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_vm_module_init);
	if (!m) return NULL;
	JS_AddModuleExportList(ctx, m, vm_funcs, countof(vm_funcs));
	return m;
}

/* --------------------------------------------------------------------------
 * Eval and loop — replacements for js_std_eval_binary / js_std_loop
 * -------------------------------------------------------------------------- */

void qn_vm_eval_binary(JSContext *ctx, const uint8_t *buf, size_t buf_len,
                        int load_only) {
	JSValue obj, val;
	obj = JS_ReadObject(ctx, buf, buf_len, JS_READ_OBJ_BYTECODE);
	if (JS_IsException(obj))
		goto exception;
	if (load_only) {
		if (JS_VALUE_GET_TAG(obj) == JS_TAG_MODULE) {
			js_module_set_import_meta(ctx, obj, FALSE, FALSE);
		}
		JS_FreeValue(ctx, obj);
	} else {
		if (JS_VALUE_GET_TAG(obj) == JS_TAG_MODULE) {
			if (JS_ResolveModule(ctx, obj) < 0) {
				JS_FreeValue(ctx, obj);
				goto exception;
			}
			js_module_set_import_meta(ctx, obj, FALSE, TRUE);
		}
		val = JS_EvalFunction(ctx, obj);
		/* Don't call js_std_await — the three-handle pattern in qn_vm_loop
		   will drain jobs and resolve promises via uv_run. */
		if (JS_IsException(val)) {
		exception:
			js_std_dump_error(ctx);
			exit(1);
		}
		JS_FreeValue(ctx, val);
	}
}

void qn_vm_eval_binary_json_module(JSContext *ctx,
                                    const uint8_t *buf, size_t buf_len,
                                    const char *module_name) {
	JSValue obj = JS_ParseJSON2(ctx, (const char *)buf, buf_len, module_name,
	                             JS_PARSE_JSON_EXT);
	if (JS_IsException(obj))
		goto exception;
	JSModuleDef *m = JS_NewCModule(ctx, module_name, NULL);
	if (!m) {
		JS_FreeValue(ctx, obj);
		goto exception;
	}
	JS_AddModuleExport(ctx, m, "default");
	/* Note: JS_SetModuleExport steals the reference to obj */
	JS_SetModuleExport(ctx, m, "default", obj);
	return;
exception:
	js_std_dump_error(ctx);
	exit(1);
}

void qn_vm_loop(JSContext *ctx) {
	JSRuntime *rt = JS_GetRuntime(ctx);

	/* Start the three-handle pattern */
	uv_prepare_start(&g_prepare, prepare_cb);
	uv_unref((uv_handle_t *)&g_prepare);
	uv_check_start(&g_check, check_cb);
	uv_unref((uv_handle_t *)&g_check);

	/* Drain any jobs that were queued by eval_binary */
	execute_jobs(ctx);
	rejection_check(ctx);

	/* Main event loop */
	int r;
	do {
		maybe_idle();
		r = uv_run(g_loop, UV_RUN_DEFAULT);
	} while (r == 0 && JS_IsJobPending(rt));

	/* Final check for unhandled exceptions */
	if (JS_HasException(ctx)) {
		js_std_dump_error(ctx);
	}
}

/* --------------------------------------------------------------------------
 * Lifecycle
 * -------------------------------------------------------------------------- */

void qn_vm_init(JSContext *ctx) {
	g_ctx = ctx;

#if !defined(_WIN32)
	/* Ignore SIGPIPE so writev() on closed sockets returns EPIPE instead of
	   killing the process. Matches Node.js / Deno / txiki.js behavior. */
	signal(SIGPIPE, SIG_IGN);
#endif

	g_loop = malloc(sizeof(uv_loop_t));
	if (!g_loop) {
		fprintf(stderr, "qn_vm_init: could not allocate uv_loop_t\n");
		abort();
	}
	uv_loop_init(g_loop);

	/* Initialize three-handle pattern handles */
	uv_prepare_init(g_loop, &g_prepare);
	uv_idle_init(g_loop, &g_idle);
	uv_check_init(g_loop, &g_check);

	/* Set up promise rejection tracking */
	JS_SetHostPromiseRejectionTracker(JS_GetRuntime(ctx),
	                                  rejection_tracker, NULL);
}

void qn_vm_free(JSRuntime *rt) {
	/* Close three-handle pattern handles */
	uv_close((uv_handle_t *)&g_prepare, NULL);
	uv_close((uv_handle_t *)&g_idle, NULL);
	uv_close((uv_handle_t *)&g_check, NULL);

	/* Free all timers */
	while (timer_head) {
		QNTimer *t = timer_head;
		timer_head = t->next;
		JS_FreeValueRT(rt, t->func);
		if (!t->closed) {
			uv_timer_stop(&t->handle);
		}
		js_free_rt(rt, t);
	}

	/* Free all poll handles */
	while (poll_head) {
		QNPoll *p = poll_head;
		poll_head = p->next;
		JS_FreeValueRT(rt, p->rw_func[0]);
		JS_FreeValueRT(rt, p->rw_func[1]);
		if (p->handle_inited) {
			uv_poll_stop(&p->handle);
		}
		js_free_rt(rt, p);
	}

	/* Free rejection tracking entries */
	rejection_free_all(rt);

	/* Release prevent-GC refs on all handles so objects can be freed. */
	for (int i = 0; i < g_cleanup_count; i++)
		g_cleanup_fns[i](rt);
	g_cleanup_count = 0;

	if (g_loop) {
		/* Run to let pending close callbacks fire */
		uv_run(g_loop, UV_RUN_NOWAIT);
		uv_loop_close(g_loop);
		free(g_loop);
		g_loop = NULL;
	}

	g_ctx = NULL;
}
