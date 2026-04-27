import * as std from 'std'
import { spawn as _uvSpawn } from 'qn/uv-process'
import { pipeNew, close as _streamClose } from 'qn/uv-stream'
import { ChildProcess } from './ChildProcess.js'
import { parseStdio, checkUnsupportedOptions } from './utils.js'

const UNSUPPORTED_OPTIONS = [
	'uid',
	'gid',
	'timeout',
	'killSignal',
	'serialization',
	'argv0',
	'windowsHide',
	'windowsVerbatimArguments',
]

/**
 * Spawn a child process.
 *
 * @param {string} command - The command to run.
 * @param {string[]} [args=[]] - List of string arguments.
 * @param {Object} [options={}] - Optional parameters.
 * @param {string} [options.cwd] - Working directory for the command.
 * @param {Object} [options.env] - Environment variables for the command.
 * @param {string|string[]} [options.stdio='pipe'] - stdio configuration.
 * @param {boolean|string} [options.shell=false] - Run command in shell.
 * @param {AbortSignal} [options.signal] - AbortSignal to abort the child process.
 * @returns {ChildProcess}
 *
 * @example
 * const child = spawn('ls', ['-la'])
 * child.stdout.on('data', (data) => console.log(data))
 * child.on('close', (code) => console.log('exited with', code))
 *
 * @example
 * const child = spawn('echo', ['hello'], { stdio: 'inherit' })
 */
export function spawn(command, args, options) {
	// Handle overloaded arguments: spawn(cmd, options)
	if (args && !Array.isArray(args)) {
		options = args
		args = []
	}

	args = args || []
	options = options || {}

	if (typeof command !== 'string') {
		throw new TypeError('command must be a string')
	}
	if (!Array.isArray(args)) {
		throw new TypeError('args must be an array')
	}

	checkUnsupportedOptions(options, UNSUPPORTED_OPTIONS, 'spawn')

	const env = options.env || std.getenviron()
	const cwd = options.cwd || undefined
	const detached = options.detached || false

	// Handle shell option
	let execCommand = command
	let execArgs = args
	if (options.shell) {
		const shell = typeof options.shell === 'string' ? options.shell : '/bin/sh'
		execArgs = ['-c', [command, ...args].join(' ')]
		execCommand = shell
	}

	// Setup stdio pipes
	const stdio = parseStdio(options.stdio)
	const stdinHandle = stdio[0] === 'pipe' ? pipeNew() : null
	const stdoutHandle = stdio[1] === 'pipe' ? pipeNew() : null
	const stderrHandle = stdio[2] === 'pipe' ? pipeNew() : null

	// Build stdio array for uv_spawn:
	//   QNStream handle = create pipe
	//   null = ignore
	//   undefined = inherit
	//   number = inherit that fd
	const uvStdio = stdio.map((mode, i) => {
		if (mode === 'pipe') return [stdinHandle, stdoutHandle, stderrHandle][i]
		if (mode === 'inherit') return undefined
		if (mode === 'ignore') return null
		if (typeof mode === 'number') return mode
		return null // fallback to ignore
	})

	// Convert env object to array of "KEY=VALUE" strings
	const envArray = env
		? Object.entries(env).map(([k, v]) => `${k}=${v}`)
		: undefined

	// Spawn via libuv
	let procHandle
	try {
		procHandle = _uvSpawn(execCommand, execArgs, {
			cwd,
			env: envArray,
			stdio: uvStdio,
			detached,
		})
	} catch (err) {
		// libuv's uv_spawn opens parent-side stdio pipes even on exec failure
		// (see vendor/libuv/src/unix/process.c), so close them here to release
		// the FDs and let the QNStream wrappers be GC'd.
		if (stdinHandle) _streamClose(stdinHandle)
		if (stdoutHandle) _streamClose(stdoutHandle)
		if (stderrHandle) _streamClose(stderrHandle)
		// Emit error asynchronously like Node.js does
		const child = new ChildProcess(null, {
			stdinHandle: null,
			stdoutHandle: null,
			stderrHandle: null,
			detached,
			spawnError: err,
		})
		return child
	}

	// Create ChildProcess instance
	const child = new ChildProcess(procHandle, {
		stdinHandle: stdio[0] === 'pipe' ? stdinHandle : null,
		stdoutHandle: stdio[1] === 'pipe' ? stdoutHandle : null,
		stderrHandle: stdio[2] === 'pipe' ? stderrHandle : null,
		detached,
	})

	// Handle AbortSignal
	if (options.signal) {
		if (options.signal.aborted) {
			child.kill()
		} else {
			options.signal.addEventListener('abort', () => {
				child.kill()
			}, { once: true })
		}
	}

	return child
}
