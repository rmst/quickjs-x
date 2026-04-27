/**
 * Shared qn runtime init
 *
 * Runs the side-effecty setup every qn context needs before user code:
 *   - install node-globals (queueMicrotask, performance, DOMException, …)
 *   - register a source transform for .ts stripping + CJS wrapping
 *   - register a module resolver fallback that consults tsconfig.json / jsconfig.json
 *
 * Imported from three places, which must stay in sync:
 *   - node/bootstrap.js           (the qn interpreter's entry)
 *   - qnc main context            (qnc/qnc.js, emitted into main())
 *   - qnc worker context setup    (qnc/qnc.js, emitted into qn_setup_worker_context)
 *
 * Depends on the C layer having bound __qn_setSourceTransform and
 * __qn_setModuleResolverFallback on globalThis already.
 */

import "node-globals"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import { dirname } from "node:path"
import { stripTypeScriptTypes } from "node:module"
import { isCjs } from "qn:cjs"
import { createTsconfigPathsResolver, nodeEnv } from "qn:tsconfig-paths"

__qn_setSourceTransform((source, filename) => {
	if (filename.endsWith(".ts")) {
		try {
			source = stripTypeScriptTypes(source)
		} catch {
			source = stripTypeScriptTypes(source, { mode: "transform" })
		}
	}

	if (isCjs(filename, source)) {
		source = `import { __cjsLoad } from "qn:cjs"\n` +
			`const { module: __cjs_module } = __cjsLoad(import.meta.filename, import.meta.dirname, function(exports, require, module, __filename, __dirname) {\n` +
			source + `\n});\n` +
			`export default __cjs_module.exports;\n`
	}

	return source
})

const __qnTsconfigPaths = createTsconfigPathsResolver({ env: nodeEnv(nodeFs, nodePath) })
__qn_setModuleResolverFallback((specifier, baseName) => {
	if (!baseName) return null
	if (baseName.startsWith("embedded://") || baseName.startsWith("node:") ||
		baseName.includes(":") && !baseName.startsWith("/")) return null
	const fromDir = dirname(baseName)
	return __qnTsconfigPaths.resolve(specifier, fromDir) || null
})
