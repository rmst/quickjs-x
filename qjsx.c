/*
 * QJSX - QuickJS with QJSXPATH module resolution
 * 
 * This is an ultra-lean version of the QuickJS interpreter that adds Node.js-style 
 * module resolution via the QJSXPATH environment variable.
 * 
 * Key Features:
 * - Supports bare module imports like 'import foo from "foo"'
 * - Resolves modules from QJSXPATH directories (e.g., ./my_modules:./lib)
 * - Falls back to standard QuickJS behavior for relative/absolute imports
 * - Maintains full QuickJS compatibility while adding minimal code
 */

#include <stdlib.h>          // Standard library functions (malloc, free, etc.)
#include <stdio.h>           // Input/output functions (printf, fprintf, etc.)
#include <string.h>          // String manipulation functions (strlen, strcmp, etc.)
#include "qjsx-module-resolution.h"  // Shared QJSXPATH module resolution

/* ========================================================================
 * MODULE LOADER WITH QJSXPATH SUPPORT
 *
 * The module resolution functions (file_exists, resolve_qjsxpath, etc.) are
 * implemented in qjsx-module-resolution.h and shared with qjsxc.
 * ======================================================================== */

/**
 * Custom module loader that implements QJSXPATH resolution and Node.js-style index.js resolution
 * 
 * @param ctx - QuickJS execution context
 * @param name - Module name from import statement
 * @param opaque - User data (unused in our case)
 * @param attributes - Import attributes (ES6 feature, unused in our case)
 * @return JSModuleDef pointer or NULL on failure
 * 
 * This function is called by QuickJS whenever it encounters an import statement.
 * It implements full Node.js-style module resolution:
 * 
 * Examples:
 *   import foo from "foo"        -> QJSXPATH resolution
 *   import bar from "./bar"      -> Try ./bar, ./bar.js, ./bar/index.js
 *   import baz from "/abs/baz"   -> Try /abs/baz, /abs/baz.js, /abs/baz/index.js
 *   import fs from "node:fs"     -> Translate to "node/fs" then QJSXPATH resolution
 */
static JSModuleDef *qjsx_loader(JSContext *ctx, const char *name, void *opaque, JSValueConst attributes) {
    // Debug: Print what module we're trying to load (disabled)
    // fprintf(stderr, "QJSX: Loading module '%s'\n", name);
    
    /*
     * First, check if we need to translate colons to slashes
     * 
     * This handles imports like "node:fs" -> "node/fs"
     * The translated name will be used for all subsequent resolution attempts
     */
    char *translated_name = translate_colons_to_slashes(ctx, name);
    const char *module_name = translated_name ? translated_name : name;
    
    /*
     * Handle bare imports with QJSXPATH resolution
     * 
     * Bare imports are any imports that don't start with './' or '../' or '/'
     * This includes:
     * - Simple names: "foo", "lodash"
     * - Scoped packages: "@babel/core"
     * - Nested paths: "lodash/debounce"
     * - Translated imports: "node/fs" (from "node:fs")
     * 
     * Node.js tries bare imports from node_modules FIRST, before checking relative paths
     */
    if (module_name[0] != '.' && module_name[0] != '/') {
        // This is likely a true bare import (no path separators) - try QJSXPATH resolution
        char *path = resolve_qjsxpath(ctx, module_name);
        if (path) {
            // Found it! Use the original QuickJS loader with the resolved path
            JSModuleDef *mod = js_module_loader(ctx, path, opaque, attributes);
            js_free(ctx, path);  // Clean up the resolved path
            if (translated_name) js_free(ctx, translated_name);  // Clean up translation
            return mod;
        }
    }
    
    /*
     * For all other cases (relative paths, absolute paths, or failed QJSXPATH resolution),
     * try Node.js-style index.js resolution
     * 
     * This handles:
     * - Original relative imports: "./foo" or "../foo"  
     * - Original absolute imports: "/path/to/foo"
     * - QuickJS-resolved paths: "examples/simple_module" (from "./simple_module")
     * - Translated paths: "node/fs" (from "node:fs")
     */
    char *resolved_path = resolve_with_index(ctx, module_name);
    if (resolved_path) {
        // Found it! Use the original QuickJS loader with the resolved path
        JSModuleDef *mod = js_module_loader(ctx, resolved_path, opaque, attributes);
        js_free(ctx, resolved_path);  // Clean up the resolved path
        if (translated_name) js_free(ctx, translated_name);  // Clean up translation
        return mod;
    }
    
    // Fallback to standard QuickJS module loading
    // This handles cases where our enhanced resolution didn't find anything
    // Use the translated name if available, otherwise the original name
    JSModuleDef *result = js_module_loader(ctx, module_name, opaque, attributes);
    if (translated_name) js_free(ctx, translated_name);  // Clean up translation
    return result;
}

/* ========================================================================
 * QUICKJS INTERPRETER IMPLEMENTATION
 * 
 * The rest of this file is a minimal QuickJS interpreter implementation.
 * We've copied only the essential functions from qjs.c and removed all
 * the debugging, tracing, and advanced features to keep it lean.
 * 
 * The key insight is that we don't need to duplicate ALL of qjs.c - 
 * just the core functionality needed to run JavaScript with our custom
 * module loader.
 * ======================================================================== */

/*
 * External symbols from QuickJS
 * 
 * These are compiled JavaScript files (REPL and calculator) that are
 * embedded as byte arrays in the QuickJS library. We reference them
 * but don't define them - they come from the linked QuickJS objects.
 */
extern const uint8_t qjsc_repl[];      // Interactive REPL implementation
extern const uint32_t qjsc_repl_size;  // Size of REPL bytecode

#ifdef CONFIG_BIGNUM
static int bignum_ext;                     // Flag: enable BigNum extensions (legacy)
#endif

/**
 * Evaluate JavaScript code from a buffer
 * 
 * @param ctx - QuickJS execution context
 * @param buf - Buffer containing JavaScript source code
 * @param buf_len - Length of the buffer
 * @param filename - Filename for error reporting
 * @param eval_flags - How to evaluate (module vs script, etc.)
 * @return 0 on success, -1 on error
 * 
 * This is the core function that actually runs JavaScript code.
 * It handles both regular scripts and ES6 modules.
 */
static int eval_buf(JSContext *ctx, const void *buf, int buf_len,
                    const char *filename, int eval_flags)
{
    JSValue val;  // QuickJS value (holds any JavaScript value)
    int ret;      // Return code
    
    /*
     * Check if we're evaluating an ES6 module
     * 
     * Modules need special handling because they support import/export
     * and have different scoping rules than regular scripts.
     */
    if ((eval_flags & JS_EVAL_TYPE_MASK) == JS_EVAL_TYPE_MODULE) {
        /*
         * For modules, we use a two-step process:
         * 1. Compile the module (but don't run it yet)
         * 2. Set up import.meta properties, then run it
         * 
         * This allows QuickJS to properly handle import statements
         * and set up the module's metadata.
         */
        val = JS_Eval(ctx, buf, buf_len, filename,
                      eval_flags | JS_EVAL_FLAG_COMPILE_ONLY);
        
        if (!JS_IsException(val)) {
            // Set up import.meta object (contains module metadata)
            js_module_set_import_meta(ctx, val, TRUE, TRUE);
            // Now actually execute the compiled module
            val = JS_EvalFunction(ctx, val);
        }
    } else {
        // For regular scripts, just evaluate directly
        val = JS_Eval(ctx, buf, buf_len, filename, eval_flags);
    }
    
    /*
     * Check if evaluation resulted in an exception
     * 
     * In QuickJS, exceptions are represented as special JSValue objects.
     * JS_IsException() checks if the value represents an exception.
     */
    if (JS_IsException(val)) {
        js_std_dump_error(ctx);  // Print the error to stderr
        ret = -1;                // Signal failure
    } else {
        ret = 0;                 // Signal success
    }
    
    // Always clean up the JSValue to prevent memory leaks
    JS_FreeValue(ctx, val);
    return ret;
}

/**
 * Load and evaluate a JavaScript file
 * 
 * @param ctx - QuickJS execution context  
 * @param filename - Path to the JavaScript file
 * @param module - How to treat the file (-1=autodetect, 0=script, 1=module)
 * @return 0 on success, -1 on error
 * 
 * This function loads a file from disk and evaluates it as JavaScript.
 * It can auto-detect whether the file should be treated as a module
 * based on file extension (.mjs) or content analysis.
 */
static int eval_file(JSContext *ctx, const char *filename, int module)
{
    uint8_t *buf;        // Buffer to hold file contents
    int ret, eval_flags; // Return code and evaluation flags
    size_t buf_len;      // Size of loaded file
    
    // Load the entire file into memory
    buf = js_load_file(ctx, &buf_len, filename);
    if (!buf) {
        perror(filename);  // Print system error message
        exit(1);           // Fatal error - can't continue
    }
    
    /*
     * Auto-detect module vs script if not explicitly specified
     * 
     * QuickJS uses two methods:
     * 1. File extension: .mjs files are always modules
     * 2. Content analysis: files with import/export are modules
     */
    if (module < 0) {
        module = (has_suffix(filename, ".mjs") ||           // .mjs extension
                  JS_DetectModule((const char *)buf, buf_len)); // or has import/export
    }
    
    // Set evaluation flags based on module detection
    if (module)
        eval_flags = JS_EVAL_TYPE_MODULE;  // ES6 module
    else
        eval_flags = JS_EVAL_TYPE_GLOBAL;  // Regular script
    
    // Evaluate the loaded code
    ret = eval_buf(ctx, buf, buf_len, filename, eval_flags);
    
    // Clean up the file buffer
    js_free(ctx, buf);
    return ret;
}

/**
 * Create a new QuickJS context with standard modules
 * 
 * @param rt - QuickJS runtime
 * @return New context, or NULL on failure
 * 
 * A "context" in QuickJS is an isolated JavaScript execution environment.
 * This function creates a context and initializes it with:
 * - BigNum support (if enabled)  
 * - Standard library (std module)
 * - OS interface (os module)
 */
static JSContext *JS_NewCustomContext(JSRuntime *rt)
{
    // Create a new execution context
    JSContext *ctx = JS_NewContext(rt);
    if (!ctx) return NULL;  // Out of memory
    
#ifdef CONFIG_BIGNUM
    /*
     * BigNum support is now integrated into the standard QuickJS build
     * No additional setup required - BigInt is available by default
     */
    (void)bignum_ext;  // Suppress unused variable warning
#endif
    
    /*
     * Initialize standard modules
     * 
     * These provide JavaScript APIs for:
     * - std: File I/O, formatting, utilities
     * - os: Operating system interface (processes, environment, etc.)
     */
    js_init_module_std(ctx, "std");  // Register 'std' module
    js_init_module_os(ctx, "os");    // Register 'os' module
    
    return ctx;
}

/**
 * Print help text and exit
 * 
 * This function displays all available command-line options and usage examples.
 * It's called when the user runs 'qjsx --help' or provides invalid arguments.
 */
void help(void)
{
    printf("QJSX (QuickJS with QJSXPATH) version " CONFIG_VERSION "\n"
           "usage: qjsx [options] [file [args]]\n"
           "-h  --help         list options\n"
           "-e  --eval EXPR    evaluate EXPR\n"
           "-i  --interactive  go to interactive mode\n"
           "-m  --module       load as ES6 module (default=autodetect)\n"
           "    --script       load as ES6 script (default=autodetect)\n"
           "-I  --include file include an additional file\n"
           "    --std          make 'std' and 'os' available to the loaded script\n"
#ifdef CONFIG_BIGNUM
           "    --bignum       enable the bignum extensions (BigFloat, BigDecimal)\n"
#endif
           "-T  --trace        trace memory allocation\n"
           "-d  --dump         dump the memory usage stats\n"
           "    --memory-limit n       limit the memory usage to 'n' bytes\n"
           "    --stack-size n         limit the stack size to 'n' bytes\n"
           "    --unhandled-rejection  dump unhandled promise rejections\n"
           "-q  --quit         just instantiate the interpreter and quit\n"
           "\n"
           "QJSXPATH module resolution:\n"
           "  Set QJSXPATH environment variable to enable Node.js-style module resolution.\n"
           "  Example: QJSXPATH=./my_modules:./lib ./qjsx script.js\n"
           "  This allows 'import foo from \"foo\"' to resolve to ./my_modules/foo/index.js\n");
    exit(1);
}

/**
 * Main entry point
 * 
 * This function:
 * 1. Parses command line arguments
 * 2. Sets up the JavaScript runtime and context  
 * 3. Installs our custom module loader (THE KEY CHANGE!)
 * 4. Runs the specified JavaScript code
 * 5. Cleans up and exits
 */
int main(int argc, char **argv)
{
    /*
     * Local variables for program state
     * 
     * These track various options and settings that can be controlled
     * via command-line arguments.
     */
    JSRuntime *rt;           // QuickJS runtime (the JavaScript engine)
    JSContext *ctx;          // QuickJS context (execution environment)
    int optind;              // Current position in argv[] during parsing
    char *expr = NULL;       // JavaScript expression to evaluate (-e option)
    int interactive = 0;     // Whether to start interactive REPL
    int dump_memory = 0;     // Whether to show memory usage stats
    int empty_run = 0;       // Whether to just start up and quit (testing)
    int module = -1;         // How to treat input (-1=auto, 0=script, 1=module)
    int load_std = 0;        // Whether to make std/os globally available
    int dump_unhandled_promise_rejection = 0;  // Promise debugging
    size_t memory_limit = 0; // Memory usage limit (0 = unlimited)
    char *include_list[32];  // List of files to include before main script
    int i, include_count = 0; // Iterator and count for include list
    size_t stack_size = 0;   // JavaScript call stack limit
    
    /*
     * Command Line Argument Parsing
     * 
     * We implement a custom parser instead of using getopt() because
     * we want to pass remaining arguments to the JavaScript script.
     * 
     * This parser handles both short options (-h) and long options (--help).
     */
    optind = 1;  // Start after program name (argv[0])
    
    // Process all arguments that start with '-'
    while (optind < argc && *argv[optind] == '-') {
        char *arg = argv[optind] + 1;  // Skip the '-'
        const char *longopt = "";      // Will hold long option name
        
        // Handle special case: a lone '-' is not an option
        if (!*arg) break;
        
        optind++;  // Move to next argument
        
        /*
         * Handle long options (--option)
         * 
         * If we see '--', everything after the first character
         * is the long option name.
         */
        if (*arg == '-') {
            longopt = arg + 1;         // Skip second '-'
            arg += strlen(arg);        // Move arg to end (no short chars)
            if (!*longopt) break;      // Handle '--' (end of options)
        }
        
        /*
         * Parse individual characters from short options or process long option
         * 
         * This loop handles cases like:
         * -abc (equivalent to -a -b -c)
         * --long-option
         */
        for (; *arg || *longopt; longopt = "") {
            char opt = *arg;           // Current short option character
            if (opt) arg++;            // Move to next character
            
            // Help option
            if (opt == 'h' || opt == '?' || !strcmp(longopt, "help")) {
                help();  // Print help and exit
                continue;
            }
            
            // Evaluate expression option
            if (opt == 'e' || !strcmp(longopt, "eval")) {
                // Expression can be attached to option or in next argument
                if (*arg) {
                    expr = arg;        // Attached: -eEXPR
                    break;             // Done with this argument
                }
                if (optind < argc) {
                    expr = argv[optind++];  // Separate: -e EXPR
                    break;             // Done with this argument  
                }
                fprintf(stderr, "qjsx: missing expression for -e\n");
                exit(2);
            }
            
            // Include file option
            if (opt == 'I' || !strcmp(longopt, "include")) {
                if (optind >= argc) {
                    fprintf(stderr, "expecting filename");
                    exit(1);
                }
                if (include_count >= 32) {  // Arbitrary limit
                    fprintf(stderr, "too many included files");
                    exit(1);
                }
                include_list[include_count++] = argv[optind++];
                continue;
            }
            
            // Interactive mode
            if (opt == 'i' || !strcmp(longopt, "interactive")) {
                interactive++;
                continue;
            }
            
            // Force module mode
            if (opt == 'm' || !strcmp(longopt, "module")) {
                module = 1;
                continue;
            }
            
            // Force script mode
            if (!strcmp(longopt, "script")) {
                module = 0;
                continue;
            }
            
            // Memory dump option
            if (opt == 'd' || !strcmp(longopt, "dump")) {
                dump_memory++;
                continue;
            }
            
            // Make std/os globally available
            if (!strcmp(longopt, "std")) {
                load_std = 1;
                continue;
            }
            
            // Promise rejection debugging
            if (!strcmp(longopt, "unhandled-rejection")) {
                dump_unhandled_promise_rejection = 1;
                continue;
            }
            
#ifdef CONFIG_BIGNUM
            // Enable BigNum extensions
            if (!strcmp(longopt, "bignum")) {
                bignum_ext = 1;
                continue;
            }
            
#endif
            
            // Empty run (testing)
            if (opt == 'q' || !strcmp(longopt, "quit")) {
                empty_run++;
                continue;
            }
            
            // Memory limit
            if (!strcmp(longopt, "memory-limit")) {
                if (optind >= argc) {
                    fprintf(stderr, "expecting memory limit");
                    exit(1);
                }
                memory_limit = (size_t)strtod(argv[optind++], NULL);
                continue;
            }
            
            // Stack size limit
            if (!strcmp(longopt, "stack-size")) {
                if (optind >= argc) {
                    fprintf(stderr, "expecting stack size");
                    exit(1);
                }
                stack_size = (size_t)strtod(argv[optind++], NULL);
                continue;
            }
            
            // Unknown option - print error and show help
            if (opt) {
                fprintf(stderr, "qjsx: unknown option '-%c'\n", opt);
            } else {
                fprintf(stderr, "qjsx: unknown option '--%s'\n", longopt);
            }
            help();  // This will exit
        }
    }
    
    
    /*
     * JavaScript Runtime Initialization
     * 
     * Now we set up the JavaScript engine and configure it
     * according to the command-line options.
     */
    
    // Create the JavaScript runtime (the core engine)
    rt = JS_NewRuntime();
    if (!rt) {
        fprintf(stderr, "qjsx: cannot allocate JS runtime\n");
        exit(2);
    }
    
    // Apply resource limits if specified
    if (memory_limit != 0) JS_SetMemoryLimit(rt, memory_limit);
    if (stack_size != 0) JS_SetMaxStackSize(rt, stack_size);
    
    // Set up worker context creation (for Worker threads)
    js_std_set_worker_new_context_func(JS_NewCustomContext);
    
    // Initialize I/O and timer handlers
    js_std_init_handlers(rt);
    
    // Create the main execution context
    ctx = JS_NewCustomContext(rt);
    if (!ctx) {
        fprintf(stderr, "qjsx: cannot allocate JS context\n");
        exit(2);
    }
    
    /*
     * *** THE ONLY IMPORTANT CHANGE FROM ORIGINAL QJS ***
     * 
     * Install our custom module loader that supports QJSXPATH resolution.
     * This single line is what enables Node.js-style module imports!
     * 
     * Everything else in this file is just standard QuickJS setup.
     * 
     * Using the new JS_SetModuleLoaderFunc2 API with attribute checking.
     */
    JS_SetModuleLoaderFunc2(rt, NULL, qjsx_loader, js_module_check_attributes, NULL);
    
    // Set up promise rejection tracking if requested
    if (dump_unhandled_promise_rejection) {
        JS_SetHostPromiseRejectionTracker(rt, js_std_promise_rejection_tracker, NULL);
    }
    
    /*
     * JavaScript Execution Phase
     * 
     * Now we actually run JavaScript code based on the command-line options.
     * We can run in several modes:
     * 1. Evaluate an expression (-e)
     * 2. Run a script file
     * 3. Start interactive mode
     * 4. Empty run (just start up and quit)
     */
    if (!empty_run) {
        
        // Set up command-line arguments for the script
        // This makes process.argv available in JavaScript
        js_std_add_helpers(ctx, argc - optind, argv + optind);
        
        /*
         * Make std and os modules globally available
         * 
         * Normally you need to import these: import * as std from 'std'
         * This option makes them available as global.std and global.os
         */
        if (load_std) {
            const char *str = "import * as std from 'std';\n"
                "import * as os from 'os';\n"
                "globalThis.std = std;\n"
                "globalThis.os = os;\n";
            eval_buf(ctx, str, strlen(str), "<input>", JS_EVAL_TYPE_MODULE);
        }
        
        // Process include files first
        for(i = 0; i < include_count; i++) {
            if (eval_file(ctx, include_list[i], module))
                goto fail;  // Exit on error
        }
        
        /*
         * Main execution logic
         * 
         * Determine what to run based on command-line arguments:
         */
        if (expr) {
            // Mode 1: Evaluate expression from -e option
            if (eval_buf(ctx, expr, strlen(expr), "<cmdline>", 0))
                goto fail;
        } else if (optind >= argc) {
            // Mode 2: No script file specified, go interactive
            interactive = 1;
        } else {
            // Mode 3: Run the specified script file
            const char *filename = argv[optind];
            if (eval_file(ctx, filename, module))
                goto fail;
        }
        
        /*
         * Start interactive REPL if requested
         * 
         * The REPL (Read-Eval-Print Loop) allows interactive JavaScript
         * session where you can type commands and see results immediately.
         */
        if (interactive) {
            js_std_eval_binary(ctx, qjsc_repl, qjsc_repl_size, 0);
        }
        
        // Run the main event loop (handles timers, I/O, etc.)
        js_std_loop(ctx);
    }
    
    // Print memory statistics if requested
    if (dump_memory) {
        JSMemoryUsage stats;
        JS_ComputeMemoryUsage(rt, &stats);
        JS_DumpMemoryUsage(stdout, &stats, rt);
    }
    
    /*
     * Cleanup Phase
     * 
     * Properly shut down the JavaScript engine and free all resources.
     * This is important to avoid memory leaks.
     */
    js_std_free_handlers(rt);  // Clean up I/O handlers
    JS_FreeContext(ctx);       // Free the execution context
    JS_FreeRuntime(rt);        // Free the runtime
    return 0;                  // Success!
    
    /*
     * Error handling
     * 
     * If any JavaScript evaluation failed, we jump here to clean up
     * and exit with an error code.
     */
 fail:
    js_std_free_handlers(rt);  // Clean up I/O handlers
    JS_FreeContext(ctx);       // Free the execution context  
    JS_FreeRuntime(rt);        // Free the runtime
    return 1;                  // Failure
}