/*
 * qnc engine — QuickJS native module exposing bytecode compilation to JS.
 *
 * Provides a Compiler class that wraps a separate QuickJS runtime for
 * compilation. Module resolution is shared with qn; policy fallback, import
 * map recording, and file loading are delegated to JS callbacks.
 *
 * Loaded by vanilla qjs: import { Compiler } from './qnc-engine.so'
 */
#include "quickjs.h"
#include "quickjs-libc.h"
#include "cutils.h"
#include "module_resolution/module-resolution.h"

#include <string.h>
#include <stdlib.h>

/* ---- Compiler class ---- */

typedef struct {
	/* Host context (where JS callbacks live) */
	JSContext *host_ctx;
	JSValue resolver_fallback_fn; /* (specifier, base) → string|null */
	JSValue import_handler_fn;    /* (base, specifier, resolved) → void */
	JSValue load_fn;        /* (name) → { source, type, cname?, regName? } | null */
	JSValue bytecode_fn;    /* (cname, bytecodeU8, type, moduleName?) → void */
	int callback_failed;

	/* Compile context (separate runtime for compilation) */
	JSRuntime *compile_rt;
	JSContext *compile_ctx;
	QNModuleResolverContext resolver_ctx;

	/* C name tracking (avoid collisions) */
	char **cnames;
	int cname_count;
	int cname_cap;

	/* Options */
	int strip_flags;
	int byte_swap;
	char *c_ident_prefix;
	char *module_path;
} QNCCompiler;

static JSClassID compiler_class_id;

/* Forward decls */
static char *qnc_module_normalizer(JSContext *ctx, const char *base,
                                   const char *name, void *opaque);
static char *qnc_resolver_fallback(JSContext *ctx, const char *specifier,
									   const char *base, void *opaque);
static void qnc_record_import(const char *base, const char *specifier,
							  const char *resolved, void *opaque);
static JSModuleDef *qnc_module_loader(JSContext *ctx, const char *name,
                                      void *opaque, JSValueConst attributes);
static int qnc_dummy_init(JSContext *ctx, JSModuleDef *m);

/* ---- C name generation (mirrors qnc/main.c logic) ---- */

static void get_c_name(char *buf, size_t buf_size, const char *prefix,
                       const char *file)
{
	const char *p, *r;
	size_t len, i;
	int c;
	char *q;

	p = strrchr(file, '/');
	if (!p) p = file; else p++;
	r = strrchr(p, '.');
	if (!r) len = strlen(p); else len = r - p;
	pstrcpy(buf, buf_size, prefix);
	q = buf + strlen(buf);
	for (i = 0; i < len; i++) {
		c = p[i];
		if (!((c >= '0' && c <= '9') ||
		      (c >= 'A' && c <= 'Z') ||
		      (c >= 'a' && c <= 'z')))
			c = '_';
		if ((q - buf) < (int)buf_size - 1)
			*q++ = c;
	}
	*q = '\0';
}

static int cname_exists(QNCCompiler *comp, const char *name)
{
	for (int i = 0; i < comp->cname_count; i++)
		if (strcmp(comp->cnames[i], name) == 0) return 1;
	return 0;
}

static void cname_add(QNCCompiler *comp, const char *name)
{
	if (comp->cname_count >= comp->cname_cap) {
		int new_cap = comp->cname_cap ? comp->cname_cap * 2 : 32;
		comp->cnames = realloc(comp->cnames, new_cap * sizeof(char *));
		comp->cname_cap = new_cap;
	}
	comp->cnames[comp->cname_count++] = strdup(name);
}

static void find_unique_cname(QNCCompiler *comp, char *cname, size_t cname_size)
{
	char cname1[1024];
	int suffix = 1;
	size_t len = strlen(cname);
	if (len > cname_size - 16) cname[cname_size - 16] = '\0';
	for (;;) {
		snprintf(cname1, sizeof(cname1), "%s_%d", cname, suffix);
		if (!cname_exists(comp, cname1)) break;
		suffix++;
	}
	pstrcpy(cname, cname_size, cname1);
}

/* Make a unique C name for a module, register it, return it.
   Caller must free the returned string. */
static char *make_cname(QNCCompiler *comp, const char *disk_name)
{
	char cname[1024];
	get_c_name(cname, sizeof(cname), comp->c_ident_prefix, disk_name);
	if (cname_exists(comp, cname))
		find_unique_cname(comp, cname, sizeof(cname));
	cname_add(comp, cname);
	return strdup(cname);
}

/* ---- Bytecode serialization helper ---- */

/* Serialize a compiled JS value to bytecode Uint8Array on host context */
static JSValue serialize_bytecode(QNCCompiler *comp, JSValue obj, int json_mode)
{
	int flags = json_mode ? 0 : JS_WRITE_OBJ_BYTECODE;
	if (comp->byte_swap) flags |= JS_WRITE_OBJ_BSWAP;

	size_t len;
	uint8_t *buf = JS_WriteObject(comp->compile_ctx, &len, obj, flags);
	if (!buf) return JS_EXCEPTION;

	/* Create Uint8Array on host context.
	   JS_NewTypedArray(ctx, 1, [arrayBuffer], UINT8) is equivalent to
	   new Uint8Array(arrayBuffer). */
	JSValue ab = JS_NewArrayBufferCopy(comp->host_ctx, buf, len);
	js_free(comp->compile_ctx, buf);
	if (JS_IsException(ab)) return ab;

	/* Pass 3 args to JS_NewTypedArray: the constructor reads argv[1] (offset)
	   and argv[2] (length) unconditionally, so pad with JS_UNDEFINED. */
	JSValue ta_args[3] = { ab, JS_UNDEFINED, JS_UNDEFINED };
	JSValue u8 = JS_NewTypedArray(comp->host_ctx, 3, ta_args, JS_TYPED_ARRAY_UINT8);
	JS_FreeValue(comp->host_ctx, ab);
	return u8;
}

/* ---- Module callbacks (compile runtime → JS host) ---- */

static void qnc_dump_host_exception(QNCCompiler *comp, const char *operation)
{
	JSValue exc = JS_GetException(comp->host_ctx);
	const char *str = JS_ToCString(comp->host_ctx, exc);
	if (str) {
		fprintf(stderr, "qnc: %s error: %s\n", operation, str);
		JS_FreeCString(comp->host_ctx, str);
	}
	JS_FreeValue(comp->host_ctx, exc);
	comp->callback_failed = 1;
}

static char *qnc_resolver_fallback(JSContext *ctx, const char *specifier,
									   const char *base, void *opaque)
{
	QNCCompiler *comp = opaque;
	if (JS_IsUndefined(comp->resolver_fallback_fn)) return NULL;

	JSValue args[2] = {
		JS_NewString(comp->host_ctx, specifier),
		JS_NewString(comp->host_ctx, base),
	};
	JSValue result = JS_Call(comp->host_ctx, comp->resolver_fallback_fn,
							 JS_UNDEFINED, 2, args);
	JS_FreeValue(comp->host_ctx, args[0]);
	JS_FreeValue(comp->host_ctx, args[1]);

	if (JS_IsException(result)) {
		qnc_dump_host_exception(comp, "resolver fallback");
		return NULL;
	}
	if (!JS_IsString(result)) {
		JS_FreeValue(comp->host_ctx, result);
		return NULL;
	}

	size_t len;
	const char *str = JS_ToCStringLen(comp->host_ctx, &len, result);
	JS_FreeValue(comp->host_ctx, result);
	if (!str) {
		comp->callback_failed = 1;
		return NULL;
	}
	char *resolved = js_strndup(ctx, str, len);
	JS_FreeCString(comp->host_ctx, str);
	if (!resolved) comp->callback_failed = 1;
	return resolved;
}

static void qnc_record_import(const char *base, const char *specifier,
							  const char *resolved, void *opaque)
{
	QNCCompiler *comp = opaque;
	if (JS_IsUndefined(comp->import_handler_fn)) return;

	JSValue args[3] = {
		JS_NewString(comp->host_ctx, base),
		JS_NewString(comp->host_ctx, specifier),
		JS_NewString(comp->host_ctx, resolved),
	};
	JSValue result = JS_Call(comp->host_ctx, comp->import_handler_fn,
							 JS_UNDEFINED, 3, args);
	for (int i = 0; i < 3; i++) JS_FreeValue(comp->host_ctx, args[i]);
	if (JS_IsException(result)) {
		qnc_dump_host_exception(comp, "import-map handler");
		return;
	}
	JS_FreeValue(comp->host_ctx, result);
}

static char *qnc_module_normalizer(JSContext *ctx, const char *base,
                                   const char *name, void *opaque)
{
	QNCCompiler *comp = opaque;
	comp->callback_failed = 0;
	char *resolved = qn_module_normalizer(ctx, base, name,
									  &comp->resolver_ctx);
	if (!comp->callback_failed) return resolved;
	if (resolved) js_free(ctx, resolved);
	JS_ThrowInternalError(ctx, "module resolver callback failed");
	return NULL;
}

static JSModuleDef *qnc_module_loader(JSContext *ctx, const char *name,
                                      void *opaque, JSValueConst attributes)
{
	QNCCompiler *comp = opaque;
	if (JS_IsUndefined(comp->load_fn)) {
		JS_ThrowReferenceError(ctx, "no loader for module '%s'", name);
		return NULL;
	}

	/* Call JS load callback */
	JSValue arg = JS_NewString(comp->host_ctx, name);
	JSValue result = JS_Call(comp->host_ctx, comp->load_fn, JS_UNDEFINED,
	                         1, &arg);
	JS_FreeValue(comp->host_ctx, arg);

	if (JS_IsException(result)) {
		JSValue exc = JS_GetException(comp->host_ctx);
		const char *str = JS_ToCString(comp->host_ctx, exc);
		if (str) {
			fprintf(stderr, "qnc: load error: %s\n", str);
			JS_FreeCString(comp->host_ctx, str);
		}
		JS_FreeValue(comp->host_ctx, exc);
		return NULL;
	}
	if (JS_IsNull(result) || JS_IsUndefined(result)) {
		JS_FreeValue(comp->host_ctx, result);
		JS_ThrowReferenceError(ctx, "could not load module '%s'", name);
		return NULL;
	}

	/* Parse result object: { type, source?, cname?, diskName?, regName? } */
	JSValue type_val = JS_GetPropertyStr(comp->host_ctx, result, "type");
	const char *type_str = JS_ToCString(comp->host_ctx, type_val);
	JS_FreeValue(comp->host_ctx, type_val);

	if (!type_str) {
		JS_FreeValue(comp->host_ctx, result);
		JS_ThrowReferenceError(ctx, "loader returned invalid result for '%s'", name);
		return NULL;
	}

	JSModuleDef *m = NULL;

	if (strcmp(type_str, "cmodule") == 0) {
		/* C module — create dummy module */
		JSValue cname_val = JS_GetPropertyStr(comp->host_ctx, result, "cname");
		const char *cname_str = JS_ToCString(comp->host_ctx, cname_val);
		JS_FreeValue(comp->host_ctx, cname_val);

		m = JS_NewCModule(ctx, name, qnc_dummy_init);

		/* Emit init module info via bytecode callback */
		if (!JS_IsUndefined(comp->bytecode_fn) && cname_str) {
			JSValue cb_args[4];
			cb_args[0] = JS_NewString(comp->host_ctx, name);
			cb_args[1] = JS_NewString(comp->host_ctx, cname_str);
			cb_args[2] = JS_NewString(comp->host_ctx, "cmodule");
			cb_args[3] = JS_UNDEFINED;
			JSValue cb_ret = JS_Call(comp->host_ctx, comp->bytecode_fn,
			                        JS_UNDEFINED, 4, cb_args);
			JS_FreeValue(comp->host_ctx, cb_args[0]);
			JS_FreeValue(comp->host_ctx, cb_args[1]);
			JS_FreeValue(comp->host_ctx, cb_args[2]);
			JS_FreeValue(comp->host_ctx, cb_ret);
		}

		if (cname_str) JS_FreeCString(comp->host_ctx, cname_str);
	} else if (strcmp(type_str, "json") == 0) {
		/* JSON module */
		JSValue source_val = JS_GetPropertyStr(comp->host_ctx, result, "source");
		const char *source = JS_ToCString(comp->host_ctx, source_val);
		JS_FreeValue(comp->host_ctx, source_val);

		JSValue disk_val = JS_GetPropertyStr(comp->host_ctx, result, "diskName");
		const char *disk_name = JS_ToCString(comp->host_ctx, disk_val);
		JS_FreeValue(comp->host_ctx, disk_val);

		if (!source) {
			if (disk_name) JS_FreeCString(comp->host_ctx, disk_name);
			JS_FreeCString(comp->host_ctx, type_str);
			JS_FreeValue(comp->host_ctx, result);
			JS_ThrowReferenceError(ctx, "no source for JSON module '%s'", name);
			return NULL;
		}

		/* Check if json5 via attributes */
		int json_flags = 0;
		int res = js_module_test_json(ctx, attributes);
		if (res == 2) json_flags = JS_PARSE_JSON_EXT;

		JSValue val = JS_ParseJSON2(ctx, source, strlen(source), name, json_flags);
		if (JS_IsException(val)) {
			JS_FreeCString(comp->host_ctx, source);
			if (disk_name) JS_FreeCString(comp->host_ctx, disk_name);
			JS_FreeCString(comp->host_ctx, type_str);
			JS_FreeValue(comp->host_ctx, result);
			return NULL;
		}

		m = JS_NewCModule(ctx, name, qnc_dummy_init);

		/* Serialize and emit */
		char *cname = make_cname(comp, disk_name ? disk_name : name);
		JSValue bytecode = serialize_bytecode(comp, val, 1);
		JS_FreeValue(ctx, val);

		if (!JS_IsException(bytecode) && !JS_IsUndefined(comp->bytecode_fn)) {
			JSValue cb_args[4];
			cb_args[0] = JS_NewString(comp->host_ctx, cname);
			cb_args[1] = bytecode;
			cb_args[2] = JS_NewString(comp->host_ctx, "json");
			cb_args[3] = JS_NewString(comp->host_ctx, name);
			JSValue cb_ret = JS_Call(comp->host_ctx, comp->bytecode_fn,
			                        JS_UNDEFINED, 4, cb_args);
			JS_FreeValue(comp->host_ctx, cb_args[0]);
			JS_FreeValue(comp->host_ctx, cb_args[1]);
			JS_FreeValue(comp->host_ctx, cb_args[2]);
			JS_FreeValue(comp->host_ctx, cb_args[3]);
			JS_FreeValue(comp->host_ctx, cb_ret);
		} else {
			JS_FreeValue(comp->host_ctx, bytecode);
		}

		free(cname);
		JS_FreeCString(comp->host_ctx, source);
		if (disk_name) JS_FreeCString(comp->host_ctx, disk_name);
	} else {
		/* JS module — compile to bytecode */
		JSValue source_val = JS_GetPropertyStr(comp->host_ctx, result, "source");
		const char *source = JS_ToCString(comp->host_ctx, source_val);
		JS_FreeValue(comp->host_ctx, source_val);

		JSValue disk_val = JS_GetPropertyStr(comp->host_ctx, result, "diskName");
		const char *disk_name = JS_ToCString(comp->host_ctx, disk_val);
		JS_FreeValue(comp->host_ctx, disk_val);

		if (!source) {
			if (disk_name) JS_FreeCString(comp->host_ctx, disk_name);
			JS_FreeCString(comp->host_ctx, type_str);
			JS_FreeValue(comp->host_ctx, result);
			JS_ThrowReferenceError(ctx, "no source for module '%s'", name);
			return NULL;
		}

		JSValue func_val = JS_Eval(ctx, source, strlen(source), name,
		                           JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
		if (JS_IsException(func_val)) {
			JS_FreeCString(comp->host_ctx, source);
			if (disk_name) JS_FreeCString(comp->host_ctx, disk_name);
			JS_FreeCString(comp->host_ctx, type_str);
			JS_FreeValue(comp->host_ctx, result);
			return NULL;
		}

		/* Serialize and emit */
		char *cname = make_cname(comp, disk_name ? disk_name : name);
		JSValue bytecode = serialize_bytecode(comp, func_val, 0);

		if (!JS_IsException(bytecode) && !JS_IsUndefined(comp->bytecode_fn)) {
			JSValue cb_args[4];
			cb_args[0] = JS_NewString(comp->host_ctx, cname);
			cb_args[1] = bytecode;
			cb_args[2] = JS_NewString(comp->host_ctx, "module");
			cb_args[3] = JS_UNDEFINED;
			JSValue cb_ret = JS_Call(comp->host_ctx, comp->bytecode_fn,
			                        JS_UNDEFINED, 4, cb_args);
			JS_FreeValue(comp->host_ctx, cb_args[0]);
			JS_FreeValue(comp->host_ctx, cb_args[1]);
			JS_FreeValue(comp->host_ctx, cb_args[2]);
			JS_FreeValue(comp->host_ctx, cb_ret);
		} else {
			JS_FreeValue(comp->host_ctx, bytecode);
		}

		m = JS_VALUE_GET_PTR(func_val);
		JS_FreeValue(ctx, func_val);

		free(cname);
		JS_FreeCString(comp->host_ctx, source);
		if (disk_name) JS_FreeCString(comp->host_ctx, disk_name);
	}

	JS_FreeCString(comp->host_ctx, type_str);
	JS_FreeValue(comp->host_ctx, result);
	return m;
}

static int qnc_dummy_init(JSContext *ctx, JSModuleDef *m)
{
	abort(); /* should never be called during compilation */
}

/* ---- Compiler constructor / destructor ---- */

static void compiler_free(JSRuntime *host_rt, QNCCompiler *comp)
{
	if (!comp) return;

	JS_FreeValueRT(host_rt, comp->resolver_fallback_fn);
	JS_FreeValueRT(host_rt, comp->import_handler_fn);
	JS_FreeValueRT(host_rt, comp->load_fn);
	JS_FreeValueRT(host_rt, comp->bytecode_fn);

	if (comp->compile_ctx) JS_FreeContext(comp->compile_ctx);
	if (comp->compile_rt) {
		js_std_free_handlers(comp->compile_rt);
		JS_FreeRuntime(comp->compile_rt);
	}

	for (int i = 0; i < comp->cname_count; i++) free(comp->cnames[i]);
	free(comp->cnames);
	free(comp->c_ident_prefix);
	free(comp->module_path);
	js_free_rt(host_rt, comp);
}

static void compiler_finalizer(JSRuntime *rt, JSValue val)
{
	QNCCompiler *comp = JS_GetOpaque(val, compiler_class_id);
	compiler_free(rt, comp);
}

static JSValue compiler_constructor(JSContext *ctx, JSValueConst new_target,
                                    int argc, JSValueConst *argv)
{
	JSRuntime *host_rt = JS_GetRuntime(ctx);
	QNCCompiler *comp = js_mallocz(ctx, sizeof(QNCCompiler));
	if (!comp) return JS_EXCEPTION;

	comp->host_ctx = ctx;
	comp->resolver_fallback_fn = JS_UNDEFINED;
	comp->import_handler_fn = JS_UNDEFINED;
	comp->load_fn = JS_UNDEFINED;
	comp->bytecode_fn = JS_UNDEFINED;
	comp->strip_flags = JS_STRIP_SOURCE;
	comp->byte_swap = 0;
	comp->c_ident_prefix = strdup("qjsc_");
	if (!comp->c_ident_prefix) {
		compiler_free(host_rt, comp);
		return JS_ThrowOutOfMemory(ctx);
	}
	comp->resolver_ctx.compile_mode = 1;
	comp->resolver_ctx.record_import = qnc_record_import;
	comp->resolver_ctx.resolve_fallback = qnc_resolver_fallback;
	comp->resolver_ctx.callback_opaque = comp;

	/* Parse options */
	if (argc > 0 && JS_IsObject(argv[0])) {
		JSValue v;
		v = JS_GetPropertyStr(ctx, argv[0], "stripFlags");
		if (!JS_IsUndefined(v)) { int32_t i; JS_ToInt32(ctx, &i, v); comp->strip_flags = i; }
		JS_FreeValue(ctx, v);

		v = JS_GetPropertyStr(ctx, argv[0], "byteSwap");
		if (JS_ToBool(ctx, v)) comp->byte_swap = 1;
		JS_FreeValue(ctx, v);

		v = JS_GetPropertyStr(ctx, argv[0], "prefix");
		if (!JS_IsUndefined(v)) {
			const char *s = JS_ToCString(ctx, v);
			if (!s) {
				JS_FreeValue(ctx, v);
				compiler_free(host_rt, comp);
				return JS_EXCEPTION;
			}
			char *prefix = strdup(s);
			JS_FreeCString(ctx, s);
			if (!prefix) {
				JS_FreeValue(ctx, v);
				compiler_free(host_rt, comp);
				return JS_ThrowOutOfMemory(ctx);
			}
			free(comp->c_ident_prefix);
			comp->c_ident_prefix = prefix;
		}
		JS_FreeValue(ctx, v);

		v = JS_GetPropertyStr(ctx, argv[0], "modulePath");
		if (JS_IsString(v)) {
			const char *s = JS_ToCString(ctx, v);
			if (!s) {
				JS_FreeValue(ctx, v);
				compiler_free(host_rt, comp);
				return JS_EXCEPTION;
			}
			comp->module_path = strdup(s);
			JS_FreeCString(ctx, s);
			if (!comp->module_path) {
				JS_FreeValue(ctx, v);
				compiler_free(host_rt, comp);
				return JS_ThrowOutOfMemory(ctx);
			}
		}
		JS_FreeValue(ctx, v);
	}
	comp->resolver_ctx.module_path = comp->module_path;

	/* Create compile runtime */
	comp->compile_rt = JS_NewRuntime();
	if (!comp->compile_rt) {
		compiler_free(host_rt, comp);
		return JS_ThrowInternalError(ctx, "failed to create compile runtime");
	}
	js_std_init_handlers(comp->compile_rt);
	JS_SetStripInfo(comp->compile_rt, comp->strip_flags);

	comp->compile_ctx = JS_NewContext(comp->compile_rt);
	if (!comp->compile_ctx) {
		compiler_free(host_rt, comp);
		return JS_ThrowInternalError(ctx, "failed to create compile context");
	}

	/* Register normalizer and loader with opaque pointing to compiler */
	JS_SetModuleLoaderFunc2(comp->compile_rt, qnc_module_normalizer,
	                        qnc_module_loader, NULL, comp);

	/* Create JS object */
	JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
	if (JS_IsException(proto)) {
		compiler_free(host_rt, comp);
		return JS_EXCEPTION;
	}
	JSValue obj = JS_NewObjectProtoClass(ctx, proto, compiler_class_id);
	JS_FreeValue(ctx, proto);
	if (JS_IsException(obj)) {
		compiler_free(host_rt, comp);
		return obj;
	}
	JS_SetOpaque(obj, comp);
	return obj;
}

/* ---- Compiler methods ---- */

/* addCModule(name, cname?) — register a C module in the compile context */
static JSValue compiler_add_cmodule(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
	QNCCompiler *comp = JS_GetOpaque2(ctx, this_val, compiler_class_id);
	if (!comp) return JS_EXCEPTION;

	const char *name = JS_ToCString(ctx, argv[0]);
	if (!name) return JS_EXCEPTION;

	JS_NewCModule(comp->compile_ctx, name, qnc_dummy_init);
	JS_FreeCString(ctx, name);
	return JS_UNDEFINED;
}

/* setResolverFallback(fn) — set the policy fallback after normal resolution */
static JSValue compiler_set_resolver_fallback(JSContext *ctx,
										  JSValueConst this_val,
										  int argc, JSValueConst *argv)
{
	QNCCompiler *comp = JS_GetOpaque2(ctx, this_val, compiler_class_id);
	if (!comp) return JS_EXCEPTION;
	JS_FreeValue(ctx, comp->resolver_fallback_fn);
	comp->resolver_fallback_fn = JS_DupValue(ctx, argv[0]);
	return JS_UNDEFINED;
}

/* setImportHandler(fn) — receive compile-time import-map entries */
static JSValue compiler_set_import_handler(JSContext *ctx,
									   JSValueConst this_val,
									   int argc, JSValueConst *argv)
{
	QNCCompiler *comp = JS_GetOpaque2(ctx, this_val, compiler_class_id);
	if (!comp) return JS_EXCEPTION;
	JS_FreeValue(ctx, comp->import_handler_fn);
	comp->import_handler_fn = JS_DupValue(ctx, argv[0]);
	return JS_UNDEFINED;
}

/* setLoader(fn) — set the module loader callback */
static JSValue compiler_set_loader(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
	QNCCompiler *comp = JS_GetOpaque2(ctx, this_val, compiler_class_id);
	if (!comp) return JS_EXCEPTION;
	JS_FreeValue(ctx, comp->load_fn);
	comp->load_fn = JS_DupValue(ctx, argv[0]);
	return JS_UNDEFINED;
}

/* resolve(base, specifier) — resolve through the same compile-time path used
   for imports encountered by QuickJS. */
static JSValue compiler_resolve(JSContext *ctx, JSValueConst this_val,
								int argc, JSValueConst *argv)
{
	QNCCompiler *comp = JS_GetOpaque2(ctx, this_val, compiler_class_id);
	if (!comp) return JS_EXCEPTION;
	if (argc < 2)
		return JS_ThrowTypeError(ctx, "resolve requires base and specifier");

	const char *base = JS_ToCString(ctx, argv[0]);
	const char *specifier = JS_ToCString(ctx, argv[1]);
	if (!base || !specifier) {
		if (base) JS_FreeCString(ctx, base);
		if (specifier) JS_FreeCString(ctx, specifier);
		return JS_EXCEPTION;
	}

	char *resolved = qnc_module_normalizer(comp->compile_ctx, base,
										specifier, comp);
	JS_FreeCString(ctx, base);
	JS_FreeCString(ctx, specifier);
	if (!resolved) {
		if (JS_HasException(comp->compile_ctx)) {
			JSValue exc = JS_GetException(comp->compile_ctx);
			JS_FreeValue(comp->compile_ctx, exc);
		}
		return JS_ThrowInternalError(ctx, "module resolution failed");
	}

	JSValue result = JS_NewString(ctx, resolved);
	js_free(comp->compile_ctx, resolved);
	return result;
}

/* setBytecodeHandler(fn) — set the bytecode output callback */
static JSValue compiler_set_bytecode_handler(JSContext *ctx, JSValueConst this_val,
                                             int argc, JSValueConst *argv)
{
	QNCCompiler *comp = JS_GetOpaque2(ctx, this_val, compiler_class_id);
	if (!comp) return JS_EXCEPTION;
	JS_FreeValue(ctx, comp->bytecode_fn);
	comp->bytecode_fn = JS_DupValue(ctx, argv[0]);
	return JS_UNDEFINED;
}

/* compile(source, name, options?) — compile entry point or -D module.
   Options: { module: bool, script: bool, cname: string? }
   Returns the c_name used for the entry bytecode. */
static JSValue compiler_compile(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
	QNCCompiler *comp = JS_GetOpaque2(ctx, this_val, compiler_class_id);
	if (!comp) return JS_EXCEPTION;

	const char *source = JS_ToCString(ctx, argv[0]);
	const char *name = JS_ToCString(ctx, argv[1]);
	if (!source || !name) {
		if (source) JS_FreeCString(ctx, source);
		if (name) JS_FreeCString(ctx, name);
		return JS_EXCEPTION;
	}

	int is_module = 1;
	const char *cname_override = NULL;

	if (argc > 2 && JS_IsObject(argv[2])) {
		JSValue v = JS_GetPropertyStr(ctx, argv[2], "script");
		if (JS_ToBool(ctx, v)) is_module = 0;
		JS_FreeValue(ctx, v);

		v = JS_GetPropertyStr(ctx, argv[2], "module");
		if (!JS_IsUndefined(v) && JS_ToBool(ctx, v)) is_module = 1;
		JS_FreeValue(ctx, v);

		v = JS_GetPropertyStr(ctx, argv[2], "autoDetect");
		if (JS_ToBool(ctx, v)) {
			is_module = (has_suffix(name, ".mjs") ||
			             has_suffix(name, ".ts") ||
			             JS_DetectModule(source, strlen(source)));
		}
		JS_FreeValue(ctx, v);

		v = JS_GetPropertyStr(ctx, argv[2], "cname");
		if (JS_IsString(v)) cname_override = JS_ToCString(ctx, v);
		JS_FreeValue(ctx, v);
	}

	int eval_flags = JS_EVAL_FLAG_COMPILE_ONLY;
	eval_flags |= is_module ? JS_EVAL_TYPE_MODULE : JS_EVAL_TYPE_GLOBAL;

	JSValue obj = JS_Eval(comp->compile_ctx, source, strlen(source),
	                      name, eval_flags);
	if (JS_IsException(obj)) {
		js_std_dump_error(comp->compile_ctx);
		JSValue error = JS_ThrowInternalError(ctx,
			"compilation failed for '%s'", name);
		JS_FreeCString(ctx, source);
		JS_FreeCString(ctx, name);
		if (cname_override) JS_FreeCString(ctx, cname_override);
		return error;
	}

	/* Generate C name */
	char *cname;
	if (cname_override) {
		cname = strdup(cname_override);
		cname_add(comp, cname);
		JS_FreeCString(ctx, cname_override);
	} else {
		cname = make_cname(comp, name);
	}

	/* Serialize bytecode */
	JSValue bytecode = serialize_bytecode(comp, obj, 0);
	/* Emit via callback */
	if (!JS_IsException(bytecode) && !JS_IsUndefined(comp->bytecode_fn)) {
		JSValue cb_args[4];
		cb_args[0] = JS_NewString(ctx, cname);
		cb_args[1] = bytecode;
		cb_args[2] = JS_NewString(ctx, is_module ? "module" : "script");
		cb_args[3] = JS_UNDEFINED;
		JSValue cb_ret = JS_Call(ctx, comp->bytecode_fn, JS_UNDEFINED, 4, cb_args);
		JS_FreeValue(ctx, cb_args[0]);
		JS_FreeValue(ctx, cb_args[1]);
		JS_FreeValue(ctx, cb_args[2]);
		JS_FreeValue(ctx, cb_ret);
	} else {
		JS_FreeValue(ctx, bytecode);
	}

	JSValue ret = JS_NewString(ctx, cname);

	JS_FreeValue(comp->compile_ctx, obj);
	JS_FreeCString(ctx, source);
	JS_FreeCString(ctx, name);
	free(cname);
	return ret;
}

/* detectModule(source) → boolean */
static JSValue compiler_detect_module(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
	const char *source = JS_ToCString(ctx, argv[0]);
	if (!source) return JS_EXCEPTION;
	int is_module = JS_DetectModule(source, strlen(source));
	JS_FreeCString(ctx, source);
	return JS_NewBool(ctx, is_module);
}

/* close() — free compile runtime early */
static JSValue compiler_close(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
	QNCCompiler *comp = JS_GetOpaque2(ctx, this_val, compiler_class_id);
	if (!comp) return JS_EXCEPTION;

	if (comp->compile_ctx) {
		JS_FreeContext(comp->compile_ctx);
		comp->compile_ctx = NULL;
	}
	if (comp->compile_rt) {
		js_std_free_handlers(comp->compile_rt);
		JS_FreeRuntime(comp->compile_rt);
		comp->compile_rt = NULL;
	}
	return JS_UNDEFINED;
}

/* ---- GC mark ---- */

static void compiler_gc_mark(JSRuntime *rt, JSValueConst val,
                             JS_MarkFunc *mark_func)
{
	QNCCompiler *comp = JS_GetOpaque(val, compiler_class_id);
	if (!comp) return;
	JS_MarkValue(rt, comp->resolver_fallback_fn, mark_func);
	JS_MarkValue(rt, comp->import_handler_fn, mark_func);
	JS_MarkValue(rt, comp->load_fn, mark_func);
	JS_MarkValue(rt, comp->bytecode_fn, mark_func);
}

/* ---- Module init ---- */

static JSClassDef compiler_class_def = {
	"Compiler",
	.finalizer = compiler_finalizer,
	.gc_mark = compiler_gc_mark,
};

static const JSCFunctionListEntry compiler_proto_funcs[] = {
	JS_CFUNC_DEF("addCModule", 1, compiler_add_cmodule),
	JS_CFUNC_DEF("setResolverFallback", 1, compiler_set_resolver_fallback),
	JS_CFUNC_DEF("setImportHandler", 1, compiler_set_import_handler),
	JS_CFUNC_DEF("setLoader", 1, compiler_set_loader),
	JS_CFUNC_DEF("setBytecodeHandler", 1, compiler_set_bytecode_handler),
	JS_CFUNC_DEF("resolve", 2, compiler_resolve),
	JS_CFUNC_DEF("compile", 2, compiler_compile),
	JS_CFUNC_DEF("detectModule", 1, compiler_detect_module),
	JS_CFUNC_DEF("close", 0, compiler_close),
};

static int js_qnc_engine_init(JSContext *ctx, JSModuleDef *m)
{
	/* Register Compiler class */
	JS_NewClassID(&compiler_class_id);
	JS_NewClass(JS_GetRuntime(ctx), compiler_class_id, &compiler_class_def);

	JSValue proto = JS_NewObject(ctx);
	JS_SetPropertyFunctionList(ctx, proto, compiler_proto_funcs,
	                           countof(compiler_proto_funcs));
	JS_SetClassProto(ctx, compiler_class_id, proto);

	JSValue ctor = JS_NewCFunction2(ctx, compiler_constructor, "Compiler",
	                                1, JS_CFUNC_constructor, 0);
	JS_SetConstructor(ctx, ctor, proto);

	JS_SetModuleExport(ctx, m, "Compiler", ctor);

	/* Export constants */
	JS_SetModuleExport(ctx, m, "JS_STRIP_SOURCE",
	                   JS_NewInt32(ctx, JS_STRIP_SOURCE));
	JS_SetModuleExport(ctx, m, "JS_STRIP_DEBUG",
	                   JS_NewInt32(ctx, JS_STRIP_DEBUG));

	return 0;
}

JSModuleDef *js_init_module(JSContext *ctx, const char *module_name)
{
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_qnc_engine_init);
	if (!m) return NULL;
	JS_AddModuleExport(ctx, m, "Compiler");
	JS_AddModuleExport(ctx, m, "JS_STRIP_SOURCE");
	JS_AddModuleExport(ctx, m, "JS_STRIP_DEBUG");
	return m;
}
