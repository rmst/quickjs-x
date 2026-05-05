/**
 * qn install — minimal package installer
 *
 * Reads package.json dependencies and installs them into node_modules/.
 * Supports: local paths (file:), git URLs (github:, git+https://).
 *
 * Also reads `sourceDependencies` — declarative entries pinned to a git
 * commit ({ git, rev, ... }) or a local path ({ path, ... }), each with
 * optional `exports` rewrite and `build` shell escape hatch. See
 * `installSourceDeps` for the field shape and behavior.
 *
 * Missing features:
 * - npm registry fetching (npmjs.com)
 * - Transitive dependency installation
 * - Lockfile
 * - Semver resolution
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, resolve, basename, dirname } from "node:path"
import { fetchTree } from "./git.js"
import { build as bundleBuild } from "./bundle.js"

/**
 * Parse a dependency specifier into a type and value.
 * @param {string} name - package name
 * @param {string} spec - version/url specifier
 * @returns {{ type: "file" | "github" | "git", value: string }}
 */
function parseSpec(name, spec) {
	if (spec.startsWith("file:")) {
		return { type: "file", value: spec.slice(5) }
	}
	if (spec.startsWith("github:")) {
		return { type: "github", value: spec.slice(7) }
	}
	if (spec.startsWith("git+https://") || spec.startsWith("git+http://") || spec.startsWith("git+ssh://")) {
		return { type: "git", value: spec.replace(/^git\+/, "") }
	}
	if (/^https?:\/\/github\.com\//.test(spec)) {
		return { type: "git", value: spec }
	}
	// Bare version specifiers (npm) — not yet supported
	return { type: "npm", value: spec }
}

/**
 * Split a git URL into (url, ref). Refs are passed as `#fragment` per npm
 * convention. Returns ref="HEAD" if no fragment was given.
 */
function splitGitRef(url) {
	let i = url.indexOf("#")
	if (i < 0) return { url, ref: "HEAD" }
	return { url: url.slice(0, i), ref: url.slice(i + 1) || "HEAD" }
}

/**
 * Fetch a git URL (https/http) into a cache directory using qn:git.
 * Always overwrites the destination — caching by sha is left as a future
 * optimization. Returns the path to the materialized tree.
 *
 * SSH URLs fall back to the system `git` binary, since qn:git speaks only
 * smart HTTP. If that binary isn't available, the user gets a clear error.
 */
async function gitFetch(rawUrl, cacheDir) {
	let { url, ref } = splitGitRef(rawUrl)
	let key = rawUrl.replace(/[^a-zA-Z0-9._-]/g, "_")
	let dest = join(cacheDir, key)

	if (url.startsWith("ssh://") || url.startsWith("git+ssh://")) {
		// Shell out for SSH transport — qn:git doesn't speak SSH.
		let sshUrl = url.replace(/^git\+/, "")
		if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
		mkdirSync(dest, { recursive: true })
		execFileSync(
			"git",
			["clone", "--depth", "1", ...(ref !== "HEAD" ? ["-b", ref] : []), sshUrl, dest],
			{ timeout: 60000 },
		)
		// Strip .git so installPackage's later cleanup is a no-op (kept for clarity).
		let gitDir = join(dest, ".git")
		if (existsSync(gitDir)) rmSync(gitDir, { recursive: true })
		return dest
	}

	if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
	mkdirSync(dest, { recursive: true })
	await fetchTree({ source: url, ref, dest })
	return dest
}

/**
 * Resolve a github shorthand (owner/repo, owner/repo#ref) to a cache path.
 * @param {string} spec - e.g. "rmst/tailpipe" or "rmst/tailpipe#v0.1.0"
 * @param {string} cacheDir - base cache directory
 * @returns {Promise<string>} path to materialized tree
 */
async function resolveGithub(spec, cacheDir) {
	let [repo, ref] = spec.split("#")
	let url = `https://github.com/${repo}` + (ref ? `#${ref}` : "")
	return await gitFetch(url, cacheDir)
}

/**
 * Resolve a file: path relative to the project directory.
 * @param {string} filePath - relative or absolute path
 * @param {string} projectDir - directory containing package.json
 * @returns {string} resolved absolute path
 */
function resolveFile(filePath, projectDir) {
	return resolve(projectDir, filePath)
}

/**
 * Copy a package into node_modules, respecting scoped names.
 * @param {string} name - package name (e.g. "tailpipe" or "@twind/core")
 * @param {string} srcDir - source directory to copy from
 * @param {string} nodeModulesDir - target node_modules directory
 */
function installPackage(name, srcDir, nodeModulesDir) {
	let destDir = join(nodeModulesDir, name)

	// Handle scoped packages (@scope/name)
	if (name.startsWith("@")) {
		let scope = name.split("/")[0]
		mkdirSync(join(nodeModulesDir, scope), { recursive: true })
	}

	// Remove existing
	if (existsSync(destDir)) {
		rmSync(destDir, { recursive: true })
	}

	cpSync(srcDir, destDir, { recursive: true })

	// Clean up .git directory in the copy
	let gitDir = join(destDir, ".git")
	if (existsSync(gitDir)) {
		rmSync(gitDir, { recursive: true })
	}
}

/**
 * Run a lifecycle script if present in the package.
 * @param {string} pkgDir - package directory
 * @param {string} name - script name (e.g. "prepare", "postinstall")
 * @param {object} [opts]
 * @param {object} [opts.pkg] - pre-parsed package.json
 * @param {string} [opts.binDir] - node_modules/.bin dir to prepend to PATH
 */
function runScript(pkgDir, name, opts = {}) {
	let pkg = opts.pkg
	if (!pkg) {
		let pkgJsonPath = join(pkgDir, "package.json")
		if (!existsSync(pkgJsonPath)) return
		pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"))
	}
	let script = pkg.scripts?.[name]
	if (!script) return

	let env = { ...process.env }
	// Ensure lifecycle scripts that invoke `qn` see the currently running binary,
	// not whatever `qn` happens to be on PATH.
	let pathParts = []
	if (opts.binDir) pathParts.push(opts.binDir)
	pathParts.push(dirname(process.execPath))
	env.PATH = pathParts.join(":") + ":" + (env.PATH || "")
	env.QN_EXECPATH = process.execPath
	env.npm_package_name = pkg.name || ""
	env.npm_lifecycle_event = name

	console.log(`  running ${name} script...`)
	try {
		execFileSync("sh", ["-c", script], { cwd: pkgDir, env, stdio: "inherit" })
	} catch (e) {
		console.error(`  ${name} script failed: ${e.message}`)
		throw e
	}
}

/**
 * Get the cache directory for git clones.
 * @returns {string}
 */
function getCacheDir() {
	let home = process.env.HOME || process.env.USERPROFILE || "/tmp"
	return join(home, ".cache", "qn", "packages")
}

/**
 * Install entries from package.json's `sourceDependencies` field.
 *
 * Two source variants:
 *
 *   Git-pinned (Cargo-style):
 *     "preact": {
 *       "git":     "https://github.com/preactjs/preact",  // required
 *       "rev":     "21dd6d04...",                          // required: 40-hex SHA
 *       "exports": { ".": "./src/index.js", ... },         // optional override
 *       "imports": { "#x": "./src/x.ts", ... },             // optional override
 *       "build":   "make all"                              // optional escape hatch
 *     }
 *
 *   Local path (for sibling packages and uncommitted-edit dev workflows):
 *     "server-common": {
 *       "path":    "../../web/server-common",              // required (relative to projectDir, or absolute)
 *       "exports": { ... },                                 // optional override
 *       "imports": { ... },                                 // optional override
 *       "build":   "..."                                    // optional escape hatch
 *     }
 *
 * Behavior per entry:
 *   1. Materialize source into node_modules/<name>:
 *        - git+rev: fetchTree via qn:git (full SHA-1 verification);
 *        - path:    cpSync from resolved local path (working-dir contents,
 *                   uncommitted edits included).
 *   2. Rewrite the resulting package.json's `exports` and `imports` fields:
 *        - if a matching override is given, use it verbatim;
 *        - else apply the default tree-mirror rewrite:
 *            a. collapse any conditional whose first matching `qn` or `bun`
 *               key (in that priority order) has a string value to that
 *               string verbatim — a common convention for source-equivalent
 *               paths (e.g. markdown-to-jsx's `#entities` bun condition);
 *            b. rewrite remaining `./dist/X.{js,mjs}` paths to `./src/X.ts`;
 *        - if neither step changes anything, leave the field alone.
 *   3. If `build` is given, run it as a shell command in the materialized dir.
 *
 * Lifecycle scripts on the source package (prepare, etc.) are NOT run —
 * the spec is intended to be fully declarative.
 *
 * @param {Record<string, { git?: string, rev?: string, path?: string, exports?: object, imports?: object, build?: string }>} sourceDeps
 * @param {string} nodeModulesDir
 * @param {string} projectDir - used to resolve relative `path` entries
 */
async function installSourceDeps(sourceDeps, nodeModulesDir, projectDir) {
	for (let [name, src] of Object.entries(sourceDeps)) {
		if (!src || typeof src !== "object") {
			throw new Error(`sourceDependencies["${name}"]: must be an object`)
		}

		let isPath = src.path !== undefined
		let isGit = src.git !== undefined || src.rev !== undefined

		if (isPath && isGit) {
			throw new Error(`sourceDependencies["${name}"]: cannot combine 'path' with 'git'/'rev'`)
		}
		if (!isPath && !isGit) {
			throw new Error(`sourceDependencies["${name}"]: requires either 'git'+'rev' or 'path'`)
		}
		if (isGit) {
			if (!src.git || typeof src.git !== "string") {
				throw new Error(`sourceDependencies["${name}"]: 'git' field is required`)
			}
			if (!src.rev || typeof src.rev !== "string") {
				throw new Error(`sourceDependencies["${name}"]: 'rev' field is required`)
			}
		}
		if (isPath) {
			if (typeof src.path !== "string") {
				throw new Error(`sourceDependencies["${name}"]: 'path' must be a string`)
			}
		}

		let dest = join(nodeModulesDir, name)
		if (name.startsWith("@")) {
			let scope = name.split("/")[0]
			mkdirSync(join(nodeModulesDir, scope), { recursive: true })
		}
		if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
		mkdirSync(dest, { recursive: true })

		if (isPath) {
			let absPath = resolve(projectDir, src.path)
			if (!existsSync(absPath)) {
				throw new Error(`sourceDependencies["${name}"]: path not found: ${absPath}`)
			}
			console.log(`${name} <- ${src.path}`)
			cpSync(absPath, dest, { recursive: true })
		} else {
			console.log(`${name} <- ${src.git}#${src.rev}`)
			await fetchTree({ source: src.git, ref: src.rev, dest })
		}

		// Rewrite exports and imports.
		let pkgJsonPath = join(dest, "package.json")
		if (existsSync(pkgJsonPath)) {
			let cloned = JSON.parse(readFileSync(pkgJsonPath, "utf8"))
			let nextExports = src.exports ?? rewriteDistToSource(cloned.exports)
			let nextImports = src.imports ?? rewriteDistToSource(cloned.imports)
			let changed = false
			if (nextExports) { cloned.exports = nextExports; changed = true }
			if (nextImports) { cloned.imports = nextImports; changed = true }
			if (changed) {
				writeFileSync(pkgJsonPath, JSON.stringify(cloned, null, 2))
			}
		}

		// Optional build escape hatch. Mirror runScript's PATH/QN_EXECPATH env
		// handling so the script can invoke `qn` reliably (and via $QN_EXECPATH
		// without ambiguity), even when no qn is on the host's PATH — required
		// for sourceDependencies that bundle via `qn build` to work in
		// content-addressed build sandboxes (jix.build, etc.).
		if (src.build) {
			if (typeof src.build !== "string") {
				throw new Error(`sourceDependencies["${name}"]: 'build' must be a string`)
			}
			console.log(`  building ${name}...`)
			let env = { ...process.env }
			env.PATH = dirname(process.execPath) + ":" + (env.PATH || "")
			env.QN_EXECPATH = process.execPath
			execFileSync("sh", ["-c", src.build], { cwd: dest, env, stdio: "inherit" })
		}
	}
}

/**
 * Conditions that, by convention, point at a source-equivalent path. Checked
 * in priority order: a `qn` branch (explicit support) wins over `bun` (the
 * common community convention — e.g. markdown-to-jsx's `#entities`).
 */
const SOURCE_CONDITIONS = ["qn", "bun"]

/**
 * Default tree-mirror rewrite for an exports/imports map:
 *   1. Where a conditional object has a string value under one of
 *      SOURCE_CONDITIONS, collapse the whole conditional to that path verbatim.
 *   2. Then rewrite remaining `./dist/X.{js,mjs}` paths to `./src/X.ts`.
 * Returns null if neither step produced any change (or the input is missing).
 */
function rewriteDistToSource(spec) {
	if (!spec) return null
	let collapsed = collapseSourceConditions(spec)
	let collapsedJson = JSON.stringify(collapsed)
	let rewritten = collapsedJson.replace(/"\.\/dist\/([^"]+)\.m?js"/g, '"./src/$1.ts"')
	if (rewritten === JSON.stringify(spec)) return null
	return JSON.parse(rewritten)
}

/**
 * Recursively replace any conditional object whose first matching
 * SOURCE_CONDITIONS key has a string value with that string. Other shapes
 * are walked through unchanged.
 */
function collapseSourceConditions(node) {
	if (Array.isArray(node)) return node.map(collapseSourceConditions)
	if (node && typeof node === "object") {
		for (let cond of SOURCE_CONDITIONS) {
			if (typeof node[cond] === "string") return node[cond]
		}
		let out = {}
		for (let [k, v] of Object.entries(node)) {
			out[k] = collapseSourceConditions(v)
		}
		return out
	}
	return node
}

/**
 * Compile a single sourceDep in node_modules: bundle each source-shaped
 * exports/imports leaf into ./dist/X.js using qn:bundle and rewrite the leaf
 * to point at the bundled file. Mirrors the per-dep compile pass that lives
 * in jix's `compileDeps: true`, but runs in-process with no shell hop.
 *
 * Each leaf is processed independently; if a leaf's bundle fails (e.g.
 * qn:bundle hits an unsupported feature), we leave that leaf unchanged and
 * warn — consumers that don't import it are unaffected.
 *
 * Accepted leaf shapes (after `installSourceDeps` has done its rewrite):
 *   "./src/X.{ts,tsx,js,jsx}"   ← typical shape after tree-mirror rewrite
 *   "./dist/X.{js,mjs}"          ← upstream-published shape, when no rewrite hit
 * Anything else (URL-style, glob, missing file) is passed through verbatim.
 *
 * @param {string} pkgDir   - absolute path to the installed dep
 * @param {string} pkgName  - name of the dep (used to mark self-imports external)
 */
async function compileSourceDep(pkgDir, pkgName) {
	let pkgJsonPath = join(pkgDir, "package.json")
	if (!existsSync(pkgJsonPath)) return
	let pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"))

	let bundleEntry = async (srcRel) => {
		let entry = join(pkgDir, srcRel)
		let distRel = srcRel.replace(/^src\//, "dist/").replace(/\.[jt]sx?$/, ".js")
		let outDir = join(pkgDir, dirname(distRel))
		await bundleBuild({
			entrypoints: [entry],
			outdir: outDir,
			target: "node",
			external: [pkgName, pkgName + "/*"],
		})
		return "./" + distRel
	}

	let resolveSrc = (target) => {
		if (typeof target !== "string") return null
		if (target.includes("*")) return null
		if (target.startsWith("./src/")) {
			let rel = target.slice(2)
			return existsSync(join(pkgDir, rel)) ? rel : null
		}
		if (target.startsWith("./dist/")) {
			let base = "src/" + target.slice("./dist/".length).replace(/\.m?js$/, "")
			for (let ext of [".ts", ".tsx", ".js", ".jsx"]) {
				if (existsSync(join(pkgDir, base + ext))) return base + ext
			}
			return null
		}
		return null
	}

	let walk = async (node) => {
		if (typeof node === "string") {
			let srcRel = resolveSrc(node)
			if (!srcRel) return node
			try {
				return await bundleEntry(srcRel)
			} catch (e) {
				console.warn(`compile-deps: skipping ${pkgName}:${srcRel} (bundle failed: ${e.message}); leaving leaf as ${node}`)
				return node
			}
		}
		if (Array.isArray(node)) {
			let out = []
			for (let v of node) out.push(await walk(v))
			return out
		}
		if (node && typeof node === "object") {
			let out = {}
			for (let [k, v] of Object.entries(node)) out[k] = await walk(v)
			return out
		}
		return node
	}

	let changed = false
	if (pkg.exports) { pkg.exports = await walk(pkg.exports); changed = true }
	if (pkg.imports) { pkg.imports = await walk(pkg.imports); changed = true }
	if (changed) writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2))
}

/**
 * Install dependencies from a package.json file.
 * @param {string} projectDir - directory containing package.json
 * @param {object} [options]
 * @param {boolean} [options.dev=false] - include devDependencies
 * @param {boolean} [options.compileDeps=false] - bundle TS-shaped sourceDependencies
 *   into ./dist/*.js so the resulting node_modules is consumable by node, plain
 *   bundlers, and browsers (not just qn/bun/deno).
 */
export async function install(projectDir, options = {}) {
	let pkgJsonPath = join(projectDir, "package.json")
	if (!existsSync(pkgJsonPath)) {
		console.error(`No package.json found in ${projectDir}`)
		process.exit(1)
	}

	let pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"))
	let deps = { ...pkg.dependencies }
	if (options.dev) {
		Object.assign(deps, pkg.devDependencies)
	}

	let nodeModulesDir = join(projectDir, "node_modules")
	let binDir = join(nodeModulesDir, ".bin")

	runScript(projectDir, "preinstall", { pkg, binDir })

	let names = Object.keys(deps)
	let unsupported = []
	let sourceDeps = pkg.sourceDependencies ?? {}
	let sourceNames = Object.keys(sourceDeps)

	if (names.length === 0 && sourceNames.length === 0) {
		console.log("No dependencies to install.")
	} else {
		mkdirSync(nodeModulesDir, { recursive: true })

		let cacheDir = getCacheDir()
		mkdirSync(cacheDir, { recursive: true })

		for (let name of names) {
			let spec = parseSpec(name, deps[name])
			let srcDir

			switch (spec.type) {
				case "file":
					srcDir = resolveFile(spec.value, projectDir)
					if (!existsSync(srcDir)) {
						console.error(`  file path not found: ${srcDir}`)
						process.exit(1)
					}
					console.log(`${name} <- ${spec.value}`)
					break

				case "github":
					console.log(`${name} <- github:${spec.value}`)
					srcDir = await resolveGithub(spec.value, cacheDir)
					break

				case "git":
					console.log(`${name} <- ${spec.value}`)
					srcDir = await gitFetch(spec.value, cacheDir)
					break

				case "npm":
					unsupported.push(name)
					continue
			}

			installPackage(name, srcDir, nodeModulesDir)
			// Only run prepare for git-sourced packages (they may need a build step)
			if (spec.type === "github" || spec.type === "git") {
				runScript(join(nodeModulesDir, name), "prepare", { binDir })
			}
		}

		if (sourceNames.length > 0) {
			await installSourceDeps(sourceDeps, nodeModulesDir, projectDir)
			if (options.compileDeps) {
				for (let name of sourceNames) {
					console.log(`  compiling ${name}...`)
					await compileSourceDep(join(nodeModulesDir, name), name)
				}
			}
		}
	}

	if (unsupported.length > 0) {
		console.log(`\nSkipped (npm registry not yet supported): ${unsupported.join(", ")}`)
	}

	runScript(projectDir, "install", { pkg, binDir })
	runScript(projectDir, "postinstall", { pkg, binDir })
	runScript(projectDir, "prepare", { pkg, binDir })
}

/**
 * CLI entry point.
 * @param {string[]} args - command line arguments after "install"
 */
export async function cli(args) {
	let dev = false
	let compileDeps = false
	let dir = process.cwd()

	for (let i = 0; i < args.length; i++) {
		let arg = args[i]
		if (arg === "--dev" || arg === "-D") {
			dev = true
		} else if (arg === "--compile-deps") {
			compileDeps = true
		} else if (arg === "--help" || arg === "-h") {
			console.log(`Usage: qn install [options]

Install dependencies from package.json into node_modules/.

Options:
  --dev, -D         Include devDependencies
  --compile-deps    Bundle TS-shaped sourceDependencies into ./dist/*.js so the
                    resulting node_modules is consumable by node, plain bundlers,
                    and browsers (not just qn/bun/deno).
  --help, -h        Show this help

Supported dependency specifiers (in "dependencies"):
  "file:../path"              Local directory
  "github:owner/repo[#ref]"   GitHub repository (#ref optional)
  "git+https://url.git[#ref]" Git repository over HTTPS or HTTP
  "git+ssh://url.git[#ref]"   Git repository over SSH (requires git in PATH)

Also supported in "sourceDependencies":
  "<name>": { "git": "<url>", "rev": "<sha>",
              "exports": <map>, "imports": <map>,
              "build": "<cmd>" }

Not yet supported:
  "^1.2.3", "~1.0.0", etc.    npm registry (planned)
  Transitive dependencies     (planned)`)
			return
		} else if (!arg.startsWith("-")) {
			dir = resolve(arg)
		} else {
			console.error(`Unknown option: ${arg}`)
			process.exit(1)
		}
	}

	await install(dir, { dev, compileDeps })
}
