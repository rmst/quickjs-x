#!/usr/bin/env qn
/**
 * Qn Bootstrap
 *
 * This is a minimal bootstrap file that acts as an interpreter for user scripts.
 * When compiled with qnc using the -D flag for all node modules, it creates
 * a standalone executable that can run any JavaScript file with embedded Node.js
 * compatibility modules.
 *
 * All node modules are embedded at compile time using qnc's -D flag, so they
 * are available to dynamically loaded scripts without needing external files.
 */

import * as std from "std"
import "qn:init"
import { resolve } from "node:path"
import { globSync } from "node:fs"
import { commit, buildTime } from "qn:version-info"
import { isDirectory, resolveDirectoryEntry, detectModule } from "./qn/bootstrap-utils.js"
import { statSync, S_IFMT, S_IFREG } from "qn:uv-fs"

/** Check if a pattern contains glob special characters */
function isGlobPattern(pattern) {
	return /[*?[\]{}!]/.test(pattern)
}

/** Check if a file exists */
function fileExists(path) {
	try {
		const st = statSync(path)
		return (st.mode & S_IFMT) === S_IFREG
	} catch {
		return false
	}
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

/** Detect number of available CPU cores */
function getCpuCount() {
	try {
		const f = std.popen('nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null', 'r')
		const line = f.getline()
		f.close()
		const n = parseInt(line, 10)
		return n > 0 ? n : 4
	} catch {
		return 4
	}
}

// ANSI codes for parallel test output
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'

/**
 * Run multiple test files in parallel via child processes.
 * Each file runs in a separate qn process. Output is printed
 * incrementally in completion order, like node --test.
 */
async function runTestsParallel(testFiles, concurrency) {
	const { spawn } = await import('node:child_process')
	const qnBin = scriptArgs[0]
	const cwd = process.cwd()

	if (concurrency <= 0) concurrency = getCpuCount()

	const totals = { tests: 0, suites: 0, pass: 0, fail: 0, skip: 0, todo: 0 }
	const allFailures = []

	function printFileResult(r) {
		const relPath = r.file.startsWith(cwd + '/') ? r.file.substring(cwd.length + 1) : r.file
		const fileStatus = r.code === 0 ? `${GREEN}✔${RESET}` : `${RED}✖${RESET}`
		std.out.puts(`${fileStatus} ${BOLD}${relPath}${RESET}\n`)

		if (r.stdout) std.out.puts(r.stdout + '\n')
		if (r.stderr) std.err.puts(r.stderr + '\n')
		std.out.flush()

		if (r.result) {
			totals.tests += r.result.tests
			totals.suites += r.result.suites
			totals.pass += r.result.pass
			totals.fail += r.result.fail
			totals.skip += r.result.skip
			totals.todo += r.result.todo
			if (r.result.failures) {
				for (const f of r.result.failures) allFailures.push(f)
			}
		} else if (r.code !== 0) {
			totals.fail++
			totals.tests++
			allFailures.push({ name: relPath, message: `Process exited with code ${r.code}` })
		}
	}

	function runFile(filePath) {
		return new Promise((resolve, reject) => {
			const env = std.getenviron()
			env.QN_TEST_CHILD = '1'
			const child = spawn(qnBin, ['--test', filePath], {
				stdio: ['ignore', 'pipe', 'pipe'],
				env,
			})
			let stdout = ''
			let stderr = ''
			child.stdout.on('data', d => stdout += d)
			child.stderr.on('data', d => stderr += d)
			child.on('error', reject)
			child.on('close', (code) => {
				let result = null
				const marker = 'QN_TEST_RESULT:'
				const stderrLines = stderr.split('\n')
				const cleanStderr = []
				for (const line of stderrLines) {
					if (line.startsWith(marker)) {
						try { result = JSON.parse(line.substring(marker.length)) } catch {}
					} else if (line) {
						cleanStderr.push(line)
					}
				}
				const r = {
					stdout: stdout.trimEnd(),
					stderr: cleanStderr.join('\n'),
					code,
					result,
					file: filePath,
				}
				printFileResult(r)
				resolve(r)
			})
		})
	}

	let nextIndex = 0

	async function worker() {
		while (nextIndex < testFiles.length) {
			const index = nextIndex++
			await runFile(testFiles[index])
		}
	}

	const startTime = performance.now()
	const workerCount = Math.min(concurrency, testFiles.length)
	await Promise.all(Array.from({ length: workerCount }, () => worker()))
	const totalDuration = performance.now() - startTime

	// Print aggregate summary
	std.out.puts(`\n`)
	std.out.puts(`${DIM}ℹ${RESET} files ${testFiles.length}\n`)
	std.out.puts(`${DIM}ℹ${RESET} tests ${totals.tests}\n`)
	std.out.puts(`${DIM}ℹ${RESET} suites ${totals.suites}\n`)
	std.out.puts(`${DIM}ℹ${RESET} pass ${totals.pass}\n`)
	std.out.puts(`${DIM}ℹ${RESET} fail ${totals.fail}\n`)
	if (totals.skip > 0) std.out.puts(`${DIM}ℹ${RESET} skipped ${totals.skip}\n`)
	if (totals.todo > 0) std.out.puts(`${DIM}ℹ${RESET} todo ${totals.todo}\n`)
	std.out.puts(`${DIM}ℹ${RESET} duration_ms ${totalDuration.toFixed(3)}\n`)

	if (allFailures.length > 0) {
		std.out.puts(`\n${RED}✖ failing tests:${RESET}\n\n`)
		for (const f of allFailures) {
			std.out.puts(`${RED}✖${RESET} ${f.name}\n`)
			if (f.message) std.out.puts(`  ${f.message}\n`)
			if (f.stack) {
				const stackLines = f.stack.split('\n').slice(1, 5)
				for (const line of stackLines) {
					std.out.puts(`  ${DIM}${line.trim()}${RESET}\n`)
				}
			}
			std.out.puts('\n')
		}
	}

	std.out.flush()
	process.exitCode = totals.fail > 0 ? 1 : 0
}

// Handle --version flag
if (scriptArgs[1] === '--version' || scriptArgs[1] === '-V') {
	let version = `qn ${commit}`
	if (buildTime) version += ` (dirty, built ${buildTime})`
	std.out.puts(version + '\n')
	std.exit(0)
}

// Handle subcommands
if (scriptArgs[1] === 'install') {
	const { cli } = await import("qn:install")
	await cli(scriptArgs.slice(2))
} else if (scriptArgs[1] === 'run') {
	const { cli } = await import("qn:run")
	await cli(scriptArgs.slice(2))
} else if (scriptArgs[1] === 'build') {
	const { cli } = await import("qn:bundle")
	await cli(scriptArgs.slice(2))
} else if (scriptArgs[1] === '-e' || scriptArgs[1] === '--eval') {
	if (scriptArgs.length < 3) {
		std.err.puts('Error: -e requires an argument\n')
		std.exit(1)
	}
	// Adjust argv so imported scripts see args after -e code (strip --)
	const evalCode = scriptArgs[2]
	let rest = scriptArgs.slice(3)
	if (rest[0] === '--') rest = rest.slice(1)
	scriptArgs.length = 0
	scriptArgs.push('qn', '<eval>', ...rest)
	// process.argv was already copied from scriptArgs at import time — update it too
	globalThis.process.argv = [...scriptArgs]
	try {
		const result = detectModule(evalCode)
			? __qn_evalModule(evalCode)
			: std.evalScript(evalCode)
		if (result && typeof result.then === 'function') await result
	} catch (e) {
		std.err.puts("Error: " + (e.message || e) + "\n")
		if (e.stack) std.err.puts(e.stack + "\n")
		std.exit(1)
	}
} else if (scriptArgs.length < 2) {
// No script provided — start the REPL
	await import("qn:repl")
} else if (scriptArgs[1] === '--watch') {
	if (scriptArgs.length < 3) {
		std.err.puts('Error: --watch requires a script path\n')
		std.exit(1)
	}
	const { runWatch } = await import("qn:watch")
	await runWatch(scriptArgs[2], scriptArgs.slice(3))
} else if (scriptArgs[1] === '--test') {
	// Run test files with glob expansion (like Node.js)

	// Parse --test-concurrency flag and separate from file args
	let concurrency = 0
	const fileArgs = []
	for (let i = 2; i < scriptArgs.length; i++) {
		const arg = scriptArgs[i]
		const match = arg.match(/^--test-concurrency(?:=(\d+))?$/)
		if (match) {
			const val = match[1] || scriptArgs[++i]
			concurrency = parseInt(val, 10)
			if (!(concurrency > 0)) {
				std.err.puts(`Error: --test-concurrency requires a positive integer, got '${val}'\n`)
				std.exit(1)
			}
		} else {
			fileArgs.push(arg)
		}
	}

	// Separate explicit files from glob patterns (including negative patterns)
	const explicitFiles = []
	const patterns = []
	for (const arg of fileArgs) {
		// Negative patterns and glob patterns go to glob, explicit files are added directly
		if (arg.startsWith('!') || isGlobPattern(arg) || !fileExists(arg)) {
			patterns.push(arg)
		} else {
			explicitFiles.push(arg)
		}
	}

	// Expand all patterns together (so negative patterns can exclude from positive ones)
	const globFiles = patterns.length > 0 ? globSync(patterns) : []

	// Combine and deduplicate using resolved paths
	const seen = new Set()
	const testFiles = []
	for (const file of [...explicitFiles, ...globFiles]) {
		const resolved = resolve(file)
		if (!seen.has(resolved)) {
			seen.add(resolved)
			testFiles.push(resolved)
		}
	}

	if (testFiles.length === 0) {
		std.err.puts('Warning: no test files found\n')
		std.exit(1)
	}

	if (testFiles.length === 1) {
		// Single file: run in-process (fast path, no child process overhead)
		await import('node:test')
		await import("file://" + testFiles[0])
	} else {
		// Multiple files: run in parallel via child processes
		await runTestsParallel(testFiles, concurrency)
	}
} else {
	let scriptPath = resolveScriptPath(scriptArgs[1])

	// If the script path is a directory, resolve to its entry point
	if (isDirectory(scriptPath)) {
		scriptPath = resolveDirectoryEntry(scriptPath)
	}

	// Keep scriptArgs as-is to match Node.js argv behavior:
	// argv[0] = interpreter, argv[1] = script, argv[2+] = args

	// Load and execute the user's script
	try {
		await import("file://" + scriptPath)
	} catch (e) {
		std.err.puts("Error loading script: " + e.message + "\n")
		if (e.stack) {
			std.err.puts(e.stack + "\n")
		}
		std.exit(1)
	}
}
