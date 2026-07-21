/*
 * qn-vm.h - Event loop ownership, eval, and core async primitives
 *
 * Owns the libuv event loop and provides setTimeout/clearTimeout and
 * setReadHandler/setWriteHandler backed by uv_timer_t and uv_poll_t.
 * Also provides qn_vm_eval_binary/qn_vm_loop as replacements for
 * js_std_eval_binary/js_std_loop, using the three-handle pattern
 * (uv_prepare + uv_idle + uv_check) for microtask draining.
 */

#ifndef QN_VM_H
#define QN_VM_H

#include "quickjs/quickjs.h"

/*
 * Initialize the event loop. Must be called after JS_NewContext()
 * and before qn_vm_eval_binary().
 *
 * - Allocates the uv_loop_t
 * - Initializes the three-handle pattern (prepare/idle/check)
 * - Sets up promise rejection tracking
 */
void qn_vm_init(JSContext *ctx);

/*
 * Initialize libuv's argv-dependent process state, including process title
 * storage. Returns the argv array to pass to js_std_add_helpers().
 */
char **qn_vm_setup_args(int argc, char **argv);

/*
 * Clean up the event loop. Must be called before JS_FreeContext().
 *
 * - Frees all timers and poll handles
 * - Closes three-handle pattern handles
 * - Closes and frees the uv_loop_t
 */
void qn_vm_free(JSRuntime *rt);

/*
 * Evaluate pre-compiled bytecode. Replacement for js_std_eval_binary().
 *
 * If load_only is true, registers the module but doesn't execute it.
 * If load_only is false, evaluates the module/script.
 *
 * Unlike js_std_eval_binary, does NOT call js_std_await — promise
 * resolution happens in qn_vm_loop via the three-handle pattern.
 */
void qn_vm_eval_binary(JSContext *ctx, const uint8_t *buf, size_t buf_len,
                        int load_only);

/*
 * Evaluate a pre-compiled JSON module. Replacement for js_std_eval_binary_json_module().
 */
void qn_vm_eval_binary_json_module(JSContext *ctx,
                                    const uint8_t *buf, size_t buf_len,
                                    const char *module_name);

/*
 * Run the event loop until all handles are closed and no jobs remain.
 * Replacement for js_std_loop().
 *
 * Uses uv_run(UV_RUN_DEFAULT) with the three-handle pattern to drain
 * JS microtasks between I/O polls.
 */
void qn_vm_loop(JSContext *ctx);

/*
 * Register a cleanup callback to be called during qn_vm_free().
 * Used by modules (stream, process) that need to release prevent-GC
 * refs before runtime shutdown.
 */
typedef void (*qn_cleanup_fn)(JSRuntime *rt);
void qn_vm_register_cleanup(qn_cleanup_fn fn);

/*
 * Module init function for the qn_vm native module.
 * Exports: setTimeout, clearTimeout, setReadHandler, setWriteHandler
 */
JSModuleDef *js_init_module_qn_vm(JSContext *ctx, const char *module_name);

/*
 * Source transform hook (per-thread).
 * Used for TypeScript stripping in the module loader and worker entry scripts.
 */
void qn_set_source_transform(JSContext *ctx, JSValue fn);
void qn_free_source_transform(JSRuntime *rt);
uint8_t *qn_apply_source_transform(JSContext *ctx, uint8_t *buf,
                                    size_t buf_len, const char *filename,
                                    size_t *out_len);
/* JS-callable: globalThis.__qn_setSourceTransform(fn) */
JSValue js_qn_set_source_transform(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv);

/*
 * Module resolver fallback hook (per-thread).
 * Consulted when the runtime fails to resolve a bare import through NODE_PATH
 * or node_modules. Signature: fn(specifier, baseName) -> absPath | null.
 * Used to apply TypeScript `compilerOptions.paths` / `baseUrl` at runtime.
 * Returned string is js_malloc'd and must be js_free'd by the caller.
 */
void qn_set_module_resolver_fallback(JSContext *ctx, JSValue fn);
void qn_free_module_resolver_fallback(JSRuntime *rt);
char *qn_apply_module_resolver_fallback(
	JSContext *ctx, const char *specifier, const char *base_name, void *opaque);
/* JS-callable: globalThis.__qn_setModuleResolverFallback(fn) */
JSValue js_qn_set_module_resolver_fallback(JSContext *ctx, JSValueConst this_val,
                                             int argc, JSValueConst *argv);

/*
 * Evaluate a string as an ES module. Returns the module's evaluation
 * promise (resolves after top-level await completes).
 * JS-callable: globalThis.__qn_evalModule(code)
 */
JSValue js_qn_eval_module(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv);

#endif /* QN_VM_H */
