/*
 * QuickJS SQLite bindings
 *
 * Exposes low-level SQLite API for use by node/node/sqlite/index.js
 */

#include <string.h>
#include "quickjs.h"
#include "sqlite3.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

/* Database class */
typedef struct {
    sqlite3 *db;
} JSQLiteDB;

static JSClassID js_sqlite_db_class_id;

/* Statement class */
typedef struct {
    sqlite3_stmt *stmt;
} JSQLiteStmt;

static JSClassID js_sqlite_stmt_class_id;

/* Forward declarations */
static JSValue js_sqlite_stmt_new(JSContext *ctx, sqlite3_stmt *stmt);

/* Statement finalizer */
static void js_sqlite_stmt_finalizer(JSRuntime *rt, JSValue val) {
    JSQLiteStmt *s = JS_GetOpaque(val, js_sqlite_stmt_class_id);
    if (s) {
        if (s->stmt)
            sqlite3_finalize(s->stmt);
        js_free_rt(rt, s);
    }
}

/* Database finalizer */
static void js_sqlite_db_finalizer(JSRuntime *rt, JSValue val) {
    JSQLiteDB *db = JS_GetOpaque(val, js_sqlite_db_class_id);
    if (db) {
        if (db->db)
            sqlite3_close_v2(db->db);
        js_free_rt(rt, db);
    }
}

/* Database constructor: new sqlite_db(path, flags?) */
static JSValue js_sqlite_db_ctor(JSContext *ctx, JSValueConst new_target,
                                  int argc, JSValueConst *argv) {
    JSQLiteDB *db;
    JSValue obj = JS_UNDEFINED;
    JSValue proto;
    const char *path;
    int rc;
    int32_t flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI;

    db = js_mallocz(ctx, sizeof(*db));
    if (!db)
        return JS_EXCEPTION;

    path = JS_ToCString(ctx, argv[0]);
    if (!path) {
        js_free(ctx, db);
        return JS_EXCEPTION;
    }

    if (argc > 1 && !JS_IsUndefined(argv[1])) {
        if (JS_ToInt32(ctx, &flags, argv[1])) {
            JS_FreeCString(ctx, path);
            js_free(ctx, db);
            return JS_EXCEPTION;
        }
    }

    proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    if (JS_IsException(proto)) {
        JS_FreeCString(ctx, path);
        js_free(ctx, db);
        return JS_EXCEPTION;
    }

    obj = JS_NewObjectProtoClass(ctx, proto, js_sqlite_db_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        JS_FreeCString(ctx, path);
        js_free(ctx, db);
        return JS_EXCEPTION;
    }

    rc = sqlite3_open_v2(path, &db->db, flags, NULL);
    JS_FreeCString(ctx, path);

    if (rc != SQLITE_OK) {
        const char *errmsg = db->db ? sqlite3_errmsg(db->db) : "Failed to open database";
        if (db->db)
            sqlite3_close_v2(db->db);
        js_free(ctx, db);
        JS_FreeValue(ctx, obj);
        return JS_ThrowInternalError(ctx, "%s", errmsg);
    }

    JS_SetOpaque(obj, db);
    return obj;
}

/* db.exec(sql) */
static JSValue js_sqlite_db_exec(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    JSQLiteDB *db = JS_GetOpaque2(ctx, this_val, js_sqlite_db_class_id);
    const char *sql;
    char *errmsg = NULL;
    int rc;

    if (!db || !db->db)
        return JS_ThrowInternalError(ctx, "Database is closed");

    sql = JS_ToCString(ctx, argv[0]);
    if (!sql)
        return JS_EXCEPTION;

    rc = sqlite3_exec(db->db, sql, NULL, NULL, &errmsg);
    JS_FreeCString(ctx, sql);

    if (rc != SQLITE_OK) {
        JSValue err = JS_ThrowInternalError(ctx, "%s", errmsg ? errmsg : sqlite3_errmsg(db->db));
        sqlite3_free(errmsg);
        return err;
    }

    return JS_UNDEFINED;
}

/* db.prepare(sql) -> statement */
static JSValue js_sqlite_db_prepare(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
    JSQLiteDB *db = JS_GetOpaque2(ctx, this_val, js_sqlite_db_class_id);
    const char *sql;
    sqlite3_stmt *stmt;
    int rc;

    if (!db || !db->db)
        return JS_ThrowInternalError(ctx, "Database is closed");

    sql = JS_ToCString(ctx, argv[0]);
    if (!sql)
        return JS_EXCEPTION;

    rc = sqlite3_prepare_v2(db->db, sql, -1, &stmt, NULL);
    JS_FreeCString(ctx, sql);

    if (rc != SQLITE_OK)
        return JS_ThrowInternalError(ctx, "%s", sqlite3_errmsg(db->db));

    if (!stmt)
        return JS_ThrowInternalError(ctx, "Empty SQL statement");

    return js_sqlite_stmt_new(ctx, stmt);
}

/* db.close() */
static JSValue js_sqlite_db_close(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    JSQLiteDB *db = JS_GetOpaque2(ctx, this_val, js_sqlite_db_class_id);

    if (!db)
        return JS_EXCEPTION;

    if (db->db) {
        sqlite3_close_v2(db->db);
        db->db = NULL;
    }

    return JS_UNDEFINED;
}

/* db.last_insert_rowid() -> number */
static JSValue js_sqlite_db_last_insert_rowid(JSContext *ctx, JSValueConst this_val,
                                               int argc, JSValueConst *argv) {
    JSQLiteDB *db = JS_GetOpaque2(ctx, this_val, js_sqlite_db_class_id);

    if (!db || !db->db)
        return JS_ThrowInternalError(ctx, "Database is closed");

    return JS_NewInt64(ctx, sqlite3_last_insert_rowid(db->db));
}

/* db.changes() -> number */
static JSValue js_sqlite_db_changes(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
    JSQLiteDB *db = JS_GetOpaque2(ctx, this_val, js_sqlite_db_class_id);

    if (!db || !db->db)
        return JS_ThrowInternalError(ctx, "Database is closed");

    return JS_NewInt64(ctx, sqlite3_changes64(db->db));
}

/* db.errmsg() -> string */
static JSValue js_sqlite_db_errmsg(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    JSQLiteDB *db = JS_GetOpaque2(ctx, this_val, js_sqlite_db_class_id);

    if (!db || !db->db)
        return JS_ThrowInternalError(ctx, "Database is closed");

    return JS_NewString(ctx, sqlite3_errmsg(db->db));
}

/* Statement: create new statement object */
static JSValue js_sqlite_stmt_new(JSContext *ctx, sqlite3_stmt *stmt) {
    JSQLiteStmt *s;
    JSValue obj;

    obj = JS_NewObjectClass(ctx, js_sqlite_stmt_class_id);
    if (JS_IsException(obj))
        return obj;

    s = js_mallocz(ctx, sizeof(*s));
    if (!s) {
        JS_FreeValue(ctx, obj);
        return JS_EXCEPTION;
    }

    s->stmt = stmt;
    JS_SetOpaque(obj, s);
    return obj;
}

/* stmt.step() -> "row" | "done" | null (on error) */
static JSValue js_sqlite_stmt_step(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    JSQLiteStmt *s = JS_GetOpaque2(ctx, this_val, js_sqlite_stmt_class_id);
    int rc;

    if (!s || !s->stmt)
        return JS_ThrowInternalError(ctx, "Statement is finalized");

    rc = sqlite3_step(s->stmt);

    switch (rc) {
    case SQLITE_ROW:
        return JS_NewString(ctx, "row");
    case SQLITE_DONE:
        return JS_NewString(ctx, "done");
    case SQLITE_BUSY:
        return JS_ThrowInternalError(ctx, "Database is busy");
    default:
        return JS_ThrowInternalError(ctx, "%s", sqlite3_errmsg(sqlite3_db_handle(s->stmt)));
    }
}

/* stmt.reset() */
static JSValue js_sqlite_stmt_reset(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
    JSQLiteStmt *s = JS_GetOpaque2(ctx, this_val, js_sqlite_stmt_class_id);

    if (!s || !s->stmt)
        return JS_ThrowInternalError(ctx, "Statement is finalized");

    sqlite3_reset(s->stmt);
    return JS_UNDEFINED;
}

/* stmt.finalize() */
static JSValue js_sqlite_stmt_finalize(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv) {
    JSQLiteStmt *s = JS_GetOpaque2(ctx, this_val, js_sqlite_stmt_class_id);

    if (!s)
        return JS_EXCEPTION;

    if (s->stmt) {
        sqlite3_finalize(s->stmt);
        s->stmt = NULL;
    }

    return JS_UNDEFINED;
}

/* stmt.bind(index, value) - index is 1-based */
static JSValue js_sqlite_stmt_bind(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    JSQLiteStmt *s = JS_GetOpaque2(ctx, this_val, js_sqlite_stmt_class_id);
    int idx, rc;
    JSValueConst val;

    if (!s || !s->stmt)
        return JS_ThrowInternalError(ctx, "Statement is finalized");

    if (JS_ToInt32(ctx, &idx, argv[0]))
        return JS_EXCEPTION;

    val = argv[1];

    if (JS_IsNull(val) || JS_IsUndefined(val)) {
        rc = sqlite3_bind_null(s->stmt, idx);
    } else if (JS_IsBool(val)) {
        rc = sqlite3_bind_int(s->stmt, idx, JS_ToBool(ctx, val));
    } else if (JS_VALUE_GET_TAG(val) == JS_TAG_INT) {
        int32_t i;
        JS_ToInt32(ctx, &i, val);
        rc = sqlite3_bind_int(s->stmt, idx, i);
    } else if (JS_VALUE_GET_TAG(val) == JS_TAG_BIG_INT) {
        int64_t i64;
        if (JS_ToInt64(ctx, &i64, val))
            return JS_EXCEPTION;
        rc = sqlite3_bind_int64(s->stmt, idx, i64);
    } else if (JS_IsNumber(val)) {
        double d;
        if (JS_ToFloat64(ctx, &d, val))
            return JS_EXCEPTION;
        rc = sqlite3_bind_double(s->stmt, idx, d);
    } else if (JS_IsString(val)) {
        const char *str = JS_ToCString(ctx, val);
        if (!str)
            return JS_EXCEPTION;
        rc = sqlite3_bind_text(s->stmt, idx, str, strlen(str), SQLITE_TRANSIENT);
        JS_FreeCString(ctx, str);
    } else {
        /* Try ArrayBuffer first */
        size_t size;
        uint8_t *buf = JS_GetArrayBuffer(ctx, &size, val);
        if (buf) {
            rc = sqlite3_bind_blob(s->stmt, idx, buf, size, SQLITE_TRANSIENT);
        } else {
            /* Try TypedArray (Uint8Array, etc.) */
            size_t offset, length, elem_size;
            JSValue ab = JS_GetTypedArrayBuffer(ctx, val, &offset, &length, &elem_size);
            if (!JS_IsException(ab)) {
                buf = JS_GetArrayBuffer(ctx, &size, ab);
                JS_FreeValue(ctx, ab);
                if (buf) {
                    rc = sqlite3_bind_blob(s->stmt, idx, buf + offset, length, SQLITE_TRANSIENT);
                } else {
                    return JS_ThrowTypeError(ctx, "Unsupported bind value type");
                }
            } else {
                return JS_ThrowTypeError(ctx, "Unsupported bind value type");
            }
        }
    }

    if (rc != SQLITE_OK)
        return JS_ThrowInternalError(ctx, "%s", sqlite3_errmsg(sqlite3_db_handle(s->stmt)));

    return JS_UNDEFINED;
}

/* stmt.column_count() -> number */
static JSValue js_sqlite_stmt_column_count(JSContext *ctx, JSValueConst this_val,
                                            int argc, JSValueConst *argv) {
    JSQLiteStmt *s = JS_GetOpaque2(ctx, this_val, js_sqlite_stmt_class_id);

    if (!s || !s->stmt)
        return JS_ThrowInternalError(ctx, "Statement is finalized");

    return JS_NewInt32(ctx, sqlite3_column_count(s->stmt));
}

/* stmt.column_name(index) -> string */
static JSValue js_sqlite_stmt_column_name(JSContext *ctx, JSValueConst this_val,
                                           int argc, JSValueConst *argv) {
    JSQLiteStmt *s = JS_GetOpaque2(ctx, this_val, js_sqlite_stmt_class_id);
    int idx;
    const char *name;

    if (!s || !s->stmt)
        return JS_ThrowInternalError(ctx, "Statement is finalized");

    if (JS_ToInt32(ctx, &idx, argv[0]))
        return JS_EXCEPTION;

    name = sqlite3_column_name(s->stmt, idx);
    if (!name)
        return JS_NULL;

    return JS_NewString(ctx, name);
}

/* stmt.column_value(index) -> value */
static JSValue js_sqlite_stmt_column_value(JSContext *ctx, JSValueConst this_val,
                                            int argc, JSValueConst *argv) {
    JSQLiteStmt *s = JS_GetOpaque2(ctx, this_val, js_sqlite_stmt_class_id);
    int idx;

    if (!s || !s->stmt)
        return JS_ThrowInternalError(ctx, "Statement is finalized");

    if (JS_ToInt32(ctx, &idx, argv[0]))
        return JS_EXCEPTION;

    switch (sqlite3_column_type(s->stmt, idx)) {
    case SQLITE_INTEGER:
        return JS_NewInt64(ctx, sqlite3_column_int64(s->stmt, idx));
    case SQLITE_FLOAT:
        return JS_NewFloat64(ctx, sqlite3_column_double(s->stmt, idx));
    case SQLITE_BLOB: {
        const void *blob = sqlite3_column_blob(s->stmt, idx);
        int size = sqlite3_column_bytes(s->stmt, idx);
        return JS_NewArrayBufferCopy(ctx, blob, size);
    }
    case SQLITE_NULL:
        return JS_NULL;
    case SQLITE_TEXT:
    default:
        return JS_NewString(ctx, (const char *)sqlite3_column_text(s->stmt, idx));
    }
}

/* stmt.bind_parameter_count() -> number */
static JSValue js_sqlite_stmt_bind_parameter_count(JSContext *ctx, JSValueConst this_val,
                                                    int argc, JSValueConst *argv) {
    JSQLiteStmt *s = JS_GetOpaque2(ctx, this_val, js_sqlite_stmt_class_id);

    if (!s || !s->stmt)
        return JS_ThrowInternalError(ctx, "Statement is finalized");

    return JS_NewInt32(ctx, sqlite3_bind_parameter_count(s->stmt));
}

/* Class definitions */
static JSClassDef js_sqlite_db_class = {
    "sqlite_db",
    .finalizer = js_sqlite_db_finalizer,
};

static JSClassDef js_sqlite_stmt_class = {
    "sqlite_stmt",
    .finalizer = js_sqlite_stmt_finalizer,
};

static const JSCFunctionListEntry js_sqlite_db_proto_funcs[] = {
    JS_CFUNC_DEF("exec", 1, js_sqlite_db_exec),
    JS_CFUNC_DEF("prepare", 1, js_sqlite_db_prepare),
    JS_CFUNC_DEF("close", 0, js_sqlite_db_close),
    JS_CFUNC_DEF("last_insert_rowid", 0, js_sqlite_db_last_insert_rowid),
    JS_CFUNC_DEF("changes", 0, js_sqlite_db_changes),
    JS_CFUNC_DEF("errmsg", 0, js_sqlite_db_errmsg),
};

static const JSCFunctionListEntry js_sqlite_stmt_proto_funcs[] = {
    JS_CFUNC_DEF("step", 0, js_sqlite_stmt_step),
    JS_CFUNC_DEF("reset", 0, js_sqlite_stmt_reset),
    JS_CFUNC_DEF("finalize", 0, js_sqlite_stmt_finalize),
    JS_CFUNC_DEF("bind", 2, js_sqlite_stmt_bind),
    JS_CFUNC_DEF("column_count", 0, js_sqlite_stmt_column_count),
    JS_CFUNC_DEF("column_name", 1, js_sqlite_stmt_column_name),
    JS_CFUNC_DEF("column_value", 1, js_sqlite_stmt_column_value),
    JS_CFUNC_DEF("bind_parameter_count", 0, js_sqlite_stmt_bind_parameter_count),
};

static int js_sqlite_init(JSContext *ctx, JSModuleDef *m) {
    JSValue proto, class;

    /* Initialize statement class first (used by db.prepare) */
    JS_NewClassID(&js_sqlite_stmt_class_id);
    JS_NewClass(JS_GetRuntime(ctx), js_sqlite_stmt_class_id, &js_sqlite_stmt_class);
    proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, js_sqlite_stmt_proto_funcs,
                               countof(js_sqlite_stmt_proto_funcs));
    JS_SetClassProto(ctx, js_sqlite_stmt_class_id, proto);

    /* Initialize database class */
    JS_NewClassID(&js_sqlite_db_class_id);
    JS_NewClass(JS_GetRuntime(ctx), js_sqlite_db_class_id, &js_sqlite_db_class);
    proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, js_sqlite_db_proto_funcs,
                               countof(js_sqlite_db_proto_funcs));
    JS_SetClassProto(ctx, js_sqlite_db_class_id, proto);

    class = JS_NewCFunction2(ctx, js_sqlite_db_ctor, "sqlite_db", 2,
                             JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, class, proto);
    JS_SetModuleExport(ctx, m, "sqlite_db", class);

    return 0;
}

JSModuleDef *js_init_module(JSContext *ctx, const char *module_name) {
    JSModuleDef *m;
    m = JS_NewCModule(ctx, module_name, js_sqlite_init);
    if (!m)
        return NULL;
    JS_AddModuleExport(ctx, m, "sqlite_db");
    return m;
}
