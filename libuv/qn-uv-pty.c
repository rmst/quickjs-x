/*
 * qn-uv-pty — Pseudo-terminal support for qn
 *
 * Provides forkpty-based PTY allocation with libuv async I/O on the master fd.
 * The master side is wrapped in a uv_pipe_t for non-blocking reads/writes.
 * Child exit is detected via SIGCHLD + waitpid.
 *
 * Single-dispatch design following qn-uv-stream.c / qn-uv-process.c pattern.
 */

#if defined(__APPLE__)
#include <util.h>
#elif defined(__linux__)
#define _XOPEN_SOURCE 600
#include <pty.h>
#endif

#include "qn-uv-utils.h"
#include "qn-vm.h"
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <signal.h>
#include <string.h>
#include <errno.h>
#include <termios.h>

/* ---- PTY handle ---- */

typedef struct QNPty {
	JSContext *ctx;
	int closed;
	int finalized;
	int master_fd;
	pid_t pid;
	uv_pipe_t pipe;       /* wraps master_fd for async I/O */
	uv_signal_t sigchld;  /* watches SIGCHLD for this child */
	JSValue on_data;      /* function(Uint8Array) */
	JSValue on_exit;      /* function(code, signal) */
	JSValue this_val;     /* prevent-GC self-reference */
	int exited;
	int exit_code;
	int exit_signal;
	int pipe_closed;
	int sigchld_closed;
	struct QNPty *next;
} QNPty;

static JSClassID qn_pty_class_id;
static QNPty *pty_head = NULL;

static void pty_link(QNPty *p) { p->next = pty_head; pty_head = p; }
static void pty_unlink(QNPty *p) {
	QNPty **pp = &pty_head;
	while (*pp) {
		if (*pp == p) { *pp = p->next; return; }
		pp = &(*pp)->next;
	}
}

static void pty_maybe_free(QNPty *p) {
	if (p->pipe_closed && p->sigchld_closed && p->finalized) {
		pty_unlink(p);
		free(p);
	}
}

static void pty_release_prevent_gc(QNPty *p) {
	if (!JS_IsUndefined(p->this_val)) {
		JSValue tmp = p->this_val;
		p->this_val = JS_UNDEFINED;
		JS_FreeValue(p->ctx, tmp);
	}
}

/* ---- Close callbacks ---- */

static void pty_pipe_close_cb(uv_handle_t *handle) {
	QNPty *p = handle->data;
	p->pipe_closed = 1;
	if (p->sigchld_closed) {
		p->closed = 1;
		pty_maybe_free(p);
	}
}

static void pty_sigchld_close_cb(uv_handle_t *handle) {
	QNPty *p = handle->data;
	p->sigchld_closed = 1;
	if (p->pipe_closed) {
		p->closed = 1;
		pty_maybe_free(p);
	}
}

static void pty_close_handles(QNPty *p) {
	if (!p->pipe_closed && !uv_is_closing((uv_handle_t *)&p->pipe))
		uv_close((uv_handle_t *)&p->pipe, pty_pipe_close_cb);
	if (!p->sigchld_closed && !uv_is_closing((uv_handle_t *)&p->sigchld))
		uv_close((uv_handle_t *)&p->sigchld, pty_sigchld_close_cb);
}

/* ---- Exit detection ---- */

/* Try to reap the child and fire onExit. Called from both SIGCHLD and
 * pipe EOF (the latter is needed on macOS where libuv's internal SIGCHLD
 * handler may reap the child before our uv_signal_t fires). */
static void pty_try_reap(QNPty *p) {
	if (p->exited) return;

	int status;
	pid_t r = waitpid(p->pid, &status, WNOHANG);
	if (r <= 0) return;

	p->exited = 1;
	if (WIFEXITED(status)) {
		p->exit_code = WEXITSTATUS(status);
		p->exit_signal = 0;
	} else if (WIFSIGNALED(status)) {
		p->exit_code = -1;
		p->exit_signal = WTERMSIG(status);
	}

	uv_signal_stop(&p->sigchld);

	if (!JS_IsUndefined(p->on_exit)) {
		JSValue args[2];
		args[0] = JS_NewInt32(p->ctx, p->exit_code);
		args[1] = JS_NewInt32(p->ctx, p->exit_signal);
		qn_call_handler(p->ctx, p->on_exit, 2, args);
		JS_FreeValue(p->ctx, args[0]);
		JS_FreeValue(p->ctx, args[1]);
	}

	pty_release_prevent_gc(p);
	pty_close_handles(p);
}

static void pty_sigchld_cb(uv_signal_t *handle, int signum) {
	(void)signum;
	pty_try_reap(handle->data);
}

/* ---- Read callback ---- */

static void pty_alloc_cb(uv_handle_t *handle, size_t suggested, uv_buf_t *buf) {
	(void)handle;
	buf->base = malloc(suggested);
	buf->len = buf->base ? suggested : 0;
}

static void pty_read_cb(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf) {
	QNPty *p = stream->data;

	if (nread > 0 && !JS_IsUndefined(p->on_data)) {
		uint8_t *data = js_malloc(p->ctx, nread);
		if (data) {
			memcpy(data, buf->base, nread);
			JSValue u8 = qn_new_uint8array(p->ctx, data, nread);
			qn_call_handler(p->ctx, p->on_data, 1, &u8);
			JS_FreeValue(p->ctx, u8);
		}
	}

	free(buf->base);

	if (nread < 0) {
		/* EIO/EOF is normal when the slave side closes */
		uv_read_stop(stream);
		pty_try_reap(p);
	}
}

/* ---- GC ---- */

static void qn_pty_finalizer(JSRuntime *rt, JSValue val) {
	QNPty *p = JS_GetOpaque(val, qn_pty_class_id);
	if (!p) return;

	JS_FreeValueRT(rt, p->on_data);
	JS_FreeValueRT(rt, p->on_exit);
	JS_FreeValueRT(rt, p->this_val);
	p->on_data = JS_UNDEFINED;
	p->on_exit = JS_UNDEFINED;
	p->this_val = JS_UNDEFINED;

	p->finalized = 1;
	if (!p->closed)
		pty_close_handles(p);
	else
		pty_maybe_free(p);
}

static void qn_pty_gc_mark(JSRuntime *rt, JSValueConst val,
                            JS_MarkFunc *mark_func) {
	QNPty *p = JS_GetOpaque(val, qn_pty_class_id);
	if (!p) return;
	JS_MarkValue(rt, p->on_data, mark_func);
	JS_MarkValue(rt, p->on_exit, mark_func);
	/* this_val intentionally NOT marked — prevent-GC pattern */
}

static JSClassDef qn_pty_class = {
	"Pty",
	.finalizer = qn_pty_finalizer,
	.gc_mark = qn_pty_gc_mark,
};

/* ---- Cleanup (runtime shutdown) ---- */

static void qn_pty_cleanup(JSRuntime *rt) {
	QNPty *p = pty_head;
	while (p) {
		if (!JS_IsUndefined(p->this_val)) {
			JS_FreeValueRT(rt, p->this_val);
			p->this_val = JS_UNDEFINED;
		}
		pty_close_handles(p);
		p = p->next;
	}
}

/* ---- Opcodes ---- */

enum {
	PTY_SPAWN = 0,
	PTY_WRITE,
	PTY_RESIZE,
	PTY_KILL,
	PTY_CLOSE,
	PTY_GET_PID,
	PTY_SET_ON_DATA,
	PTY_SET_ON_EXIT,
	PTY_PAUSE,
	PTY_RESUME,
};

/* ---- Write request ---- */

typedef struct {
	uv_write_t req;
	uint8_t *data;
} QNPtyWrite;

static void pty_write_cb(uv_write_t *req, int status) {
	(void)status;
	QNPtyWrite *wr = (QNPtyWrite *)req;
	free(wr->data);
	free(wr);
}

/* ---- Main dispatcher ---- */

static JSValue js_pty_op(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
	(void)this_val;
	int32_t op;
	if (JS_ToInt32(ctx, &op, argv[0]))
		return JS_EXCEPTION;

	int nargs = argc - 1;
	JSValueConst *args = argv + 1;

	switch (op) {

	case PTY_SPAWN: {
		/* spawn(file, args, cols, rows, cwd, env) → handle */
		const char *file = JS_ToCString(ctx, args[0]);
		if (!file) return JS_EXCEPTION;

		/* Build argv: [file, ...args, NULL] using shared helper */
		char **c_args = NULL;
		int args_count = 0;
		if (!JS_IsUndefined(args[1]) && !JS_IsNull(args[1])) {
			c_args = qn_js_strings(ctx, args[1], &args_count);
			if (!c_args) { JS_FreeCString(ctx, file); return JS_EXCEPTION; }
		}
		char **c_argv = js_malloc(ctx, sizeof(char *) * (args_count + 2));
		if (!c_argv) {
			if (c_args) qn_free_strings(ctx, c_args, args_count);
			JS_FreeCString(ctx, file);
			return JS_ThrowOutOfMemory(ctx);
		}
		c_argv[0] = (char *)file;
		for (int i = 0; i < args_count; i++) c_argv[i + 1] = c_args ? c_args[i] : NULL;
		c_argv[args_count + 1] = NULL;

		int32_t cols = 80, rows = 24;
		JS_ToInt32(ctx, &cols, args[2]);
		JS_ToInt32(ctx, &rows, args[3]);

		const char *cwd = NULL;
		if (nargs > 4 && !JS_IsUndefined(args[4]) && !JS_IsNull(args[4]))
			cwd = JS_ToCString(ctx, args[4]);

		char **env = NULL;
		int env_count = 0;
		if (nargs > 5 && !JS_IsUndefined(args[5]) && !JS_IsNull(args[5])) {
			env = qn_js_strings(ctx, args[5], &env_count);
		}

		struct winsize ws = { .ws_row = rows, .ws_col = cols };
		int master_fd;
		pid_t pid = forkpty(&master_fd, NULL, NULL, &ws);

		if (pid < 0) {
			int e = errno;
			JS_FreeCString(ctx, file);
			js_free(ctx, c_argv);
			if (c_args) qn_free_strings(ctx, c_args, args_count);
			if (cwd) JS_FreeCString(ctx, cwd);
			if (env) qn_free_strings(ctx, env, env_count);
			return JS_ThrowInternalError(ctx, "forkpty: %s", strerror(e));
		}

		if (pid == 0) {
			/* Child */
			if (cwd) chdir(cwd);
			if (env)
				execve(file, c_argv, env);
			else
				execvp(file, c_argv);
			_exit(127);
		}

		/* Parent — cleanup strings */
		JS_FreeCString(ctx, file);
		js_free(ctx, c_argv);
		if (c_args) qn_free_strings(ctx, c_args, args_count);
		if (cwd) JS_FreeCString(ctx, cwd);
		if (env) qn_free_strings(ctx, env, env_count);

		/* Create handle */
		QNPty *p = calloc(1, sizeof(QNPty));
		if (!p) { close(master_fd); kill(pid, SIGKILL); return JS_ThrowOutOfMemory(ctx); }

		p->ctx = ctx;
		p->master_fd = master_fd;
		p->pid = pid;
		p->on_data = JS_UNDEFINED;
		p->on_exit = JS_UNDEFINED;
		p->this_val = JS_UNDEFINED;

		uv_loop_t *loop = js_uv_loop(ctx);
		uv_pipe_init(loop, &p->pipe, 0);
		uv_pipe_open(&p->pipe, master_fd);
		p->pipe.data = p;

		uv_signal_init(loop, &p->sigchld);
		p->sigchld.data = p;
		uv_signal_start(&p->sigchld, pty_sigchld_cb, SIGCHLD);

		uv_read_start((uv_stream_t *)&p->pipe, pty_alloc_cb, pty_read_cb);

		JSValue proto = JS_GetClassProto(ctx, qn_pty_class_id);
		JSValue obj = JS_NewObjectProtoClass(ctx, proto, qn_pty_class_id);
		JS_FreeValue(ctx, proto);
		JS_SetOpaque(obj, p);
		p->this_val = JS_DupValue(ctx, obj);
		pty_link(p);

		return obj;
	}

	case PTY_WRITE: {
		QNPty *p = JS_GetOpaque2(ctx, args[0], qn_pty_class_id);
		if (!p) return JS_EXCEPTION;
		if (p->closed)
			return JS_ThrowInternalError(ctx, "pty: write on closed handle");

		QNPtyWrite *wr = malloc(sizeof(QNPtyWrite));
		if (!wr) return JS_ThrowOutOfMemory(ctx);

		if (JS_IsString(args[1])) {
			const char *str = JS_ToCString(ctx, args[1]);
			if (!str) { free(wr); return JS_EXCEPTION; }
			size_t len = strlen(str);
			wr->data = malloc(len);
			memcpy(wr->data, str, len);
			JS_FreeCString(ctx, str);
			uv_buf_t buf = uv_buf_init((char *)wr->data, len);
			uv_write(&wr->req, (uv_stream_t *)&p->pipe, &buf, 1, pty_write_cb);
		} else {
			size_t len;
			uint8_t *src = JS_GetArrayBuffer(ctx, &len, args[1]);
			if (!src) { free(wr); return JS_EXCEPTION; }
			wr->data = malloc(len);
			memcpy(wr->data, src, len);
			uv_buf_t buf = uv_buf_init((char *)wr->data, len);
			uv_write(&wr->req, (uv_stream_t *)&p->pipe, &buf, 1, pty_write_cb);
		}
		return JS_UNDEFINED;
	}

	case PTY_RESIZE: {
		QNPty *p = JS_GetOpaque2(ctx, args[0], qn_pty_class_id);
		if (!p) return JS_EXCEPTION;
		int32_t cols, rows;
		JS_ToInt32(ctx, &cols, args[1]);
		JS_ToInt32(ctx, &rows, args[2]);
		struct winsize ws = { .ws_row = rows, .ws_col = cols };
		if (ioctl(p->master_fd, TIOCSWINSZ, &ws) < 0)
			return JS_ThrowInternalError(ctx, "pty resize: %s", strerror(errno));
		return JS_UNDEFINED;
	}

	case PTY_KILL: {
		QNPty *p = JS_GetOpaque2(ctx, args[0], qn_pty_class_id);
		if (!p) return JS_EXCEPTION;
		int32_t sig = SIGTERM;
		if (nargs > 1 && !JS_IsUndefined(args[1]))
			JS_ToInt32(ctx, &sig, args[1]);
		if (!p->exited) kill(p->pid, sig);
		return JS_UNDEFINED;
	}

	case PTY_CLOSE: {
		QNPty *p = JS_GetOpaque2(ctx, args[0], qn_pty_class_id);
		if (!p) return JS_EXCEPTION;
		if (!p->closed) {
			pty_release_prevent_gc(p);
			pty_close_handles(p);
		}
		return JS_UNDEFINED;
	}

	case PTY_GET_PID: {
		QNPty *p = JS_GetOpaque2(ctx, args[0], qn_pty_class_id);
		if (!p) return JS_EXCEPTION;
		return JS_NewInt32(ctx, p->pid);
	}

	case PTY_SET_ON_DATA: {
		QNPty *p = JS_GetOpaque2(ctx, args[0], qn_pty_class_id);
		if (!p) return JS_EXCEPTION;
		JS_FreeValue(ctx, p->on_data);
		p->on_data = JS_DupValue(ctx, args[1]);
		return JS_UNDEFINED;
	}

	case PTY_SET_ON_EXIT: {
		QNPty *p = JS_GetOpaque2(ctx, args[0], qn_pty_class_id);
		if (!p) return JS_EXCEPTION;
		JS_FreeValue(ctx, p->on_exit);
		p->on_exit = JS_DupValue(ctx, args[1]);
		return JS_UNDEFINED;
	}

	case PTY_PAUSE: {
		QNPty *p = JS_GetOpaque2(ctx, args[0], qn_pty_class_id);
		if (!p) return JS_EXCEPTION;
		uv_read_stop((uv_stream_t *)&p->pipe);
		return JS_UNDEFINED;
	}

	case PTY_RESUME: {
		QNPty *p = JS_GetOpaque2(ctx, args[0], qn_pty_class_id);
		if (!p) return JS_EXCEPTION;
		int r = uv_read_start((uv_stream_t *)&p->pipe, pty_alloc_cb, pty_read_cb);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	default:
		return JS_ThrowRangeError(ctx, "pty: unknown op %d", op);
	}
}

/* ---- Module definition ---- */

static const JSCFunctionListEntry js_pty_funcs[] = {
	QN_CFUNC_DEF("_op", 8, js_pty_op),
	QN_CONST2("SPAWN", PTY_SPAWN),
	QN_CONST2("WRITE", PTY_WRITE),
	QN_CONST2("RESIZE", PTY_RESIZE),
	QN_CONST2("KILL", PTY_KILL),
	QN_CONST2("CLOSE", PTY_CLOSE),
	QN_CONST2("GET_PID", PTY_GET_PID),
	QN_CONST2("SET_ON_DATA", PTY_SET_ON_DATA),
	QN_CONST2("SET_ON_EXIT", PTY_SET_ON_EXIT),
	QN_CONST2("PAUSE", PTY_PAUSE),
	QN_CONST2("RESUME", PTY_RESUME),
};

static int js_pty_init(JSContext *ctx, JSModuleDef *m) {
	JS_NewClassID(&qn_pty_class_id);
	JS_NewClass(JS_GetRuntime(ctx), qn_pty_class_id, &qn_pty_class);
	JSValue proto = JS_NewObject(ctx);
	JS_SetClassProto(ctx, qn_pty_class_id, proto);
	return JS_SetModuleExportList(ctx, m, js_pty_funcs, countof(js_pty_funcs));
}

JSModuleDef *js_init_module_qn_uv_pty(JSContext *ctx, const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_pty_init);
	if (!m) return NULL;
	JS_AddModuleExportList(ctx, m, js_pty_funcs, countof(js_pty_funcs));
	qn_vm_register_cleanup(qn_pty_cleanup);
	return m;
}
