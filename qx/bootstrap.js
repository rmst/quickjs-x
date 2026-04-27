#!/usr/bin/env qx
/**
 * QX Bootstrap
 *
 * Minimal zx-compatible shell scripting for QuickJS.
 * This bootstrap provides the $ function and Node.js compatibility modules.
 *
 * All modules are embedded at compile time using qnc's -D flag.
 */

import * as std from "std"
import * as os from "os"
import "node-globals"
import { resolve } from "node:path"
import process from "node:process"
import { Buffer } from "node:buffer"
import $, { ProcessPromise, ProcessOutput, retry } from "qx/core"
import { commit, buildTime } from "qn:version-info"
import { isDirectory, resolveDirectoryEntry, detectModule } from "../node/qn/bootstrap-utils.js"

// Handle --version flag
if (scriptArgs[1] === '--version' || scriptArgs[1] === '-V') {
	let version = `qx ${commit}`
	if (buildTime) version += ` (dirty, built ${buildTime})`
	std.out.puts(version + '\n')
	std.exit(0)
}

// Expose Buffer globally
globalThis.Buffer = Buffer

// Expose $ and related classes globally (like zx)
globalThis.$ = $
globalThis.ProcessPromise = ProcessPromise
globalThis.ProcessOutput = ProcessOutput
globalThis.retry = retry

// cd function for changing directories (uses node:process)
globalThis.cd = (path) => {
	process.chdir(path)
}

// pwd function (uses node:process)
globalThis.pwd = () => {
	return process.cwd()
}

// sleep function (returns a promise)
globalThis.sleep = (ms) => {
	return new Promise(resolve => setTimeout(resolve, ms))
}

// echo function (like zx's echo, uses node:process)
globalThis.echo = (...args) => {
	process.stdout.write(args.join(' ') + '\n')
}

// within helper - run code in a different directory
globalThis.within = async (fn) => {
	const cwd = process.cwd()
	try {
		return await fn()
	} finally {
		process.chdir(cwd)
	}
}

// Argv parsing (like zx's argv, uses node:process)
globalThis.argv = process.argv.slice(2)

// Handle -e flag (evaluate string as script or module)
if (scriptArgs[1] === '-e' || scriptArgs[1] === '--eval') {
	if (scriptArgs.length < 3) {
		std.err.puts('Error: -e requires an argument\n')
		std.exit(1)
	}
	try {
		const result = detectModule(scriptArgs[2])
			? __qn_evalModule(scriptArgs[2])
			: std.evalScript(scriptArgs[2])
		if (result && typeof result.then === 'function') await result
	} catch (e) {
		std.err.puts("Error: " + (e.message || e) + "\n")
		if (e.stack) std.err.puts(e.stack + "\n")
		std.exit(1)
	}
	std.exit(0)
}

/**
 * Resolve a script path to an absolute path.
 * - Relative paths (./ or ../) are resolved against cwd
 * - Absolute paths are returned as-is
 * - Bare paths are returned as-is for NODE_PATH / node_modules resolution
 */
function resolveScriptPath(path) {
	if (!path || path.startsWith('/')) return path
	if (path.startsWith('./') || path.startsWith('../')) return resolve(path)
	return path
}

// If no script provided, start the REPL
if (process.argv.length < 2) {
	await import("repl")
} else {
	let scriptPath = resolveScriptPath(process.argv[1])

	// If the script path is a directory, resolve to its entry point
	if (isDirectory(scriptPath)) {
		scriptPath = resolveDirectoryEntry(scriptPath)
	}

	// Load and execute the user's script
	try {
		await import(scriptPath)
	} catch (e) {
		process.stderr.write("Error loading script: " + e.message + "\n")
		if (e.stack) {
			process.stderr.write(e.stack + "\n")
		}
		process.exit(1)
	}
}
