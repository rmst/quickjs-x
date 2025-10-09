import * as std from 'std';
import * as os from 'os';

/**
 * Execute a command synchronously and return its output, similar to Node.js's execFileSync.
 *
 * @param {string} file - The command or executable file to run.
 * @param {Array} [args=[]] - The list of arguments to pass to the command.
 * @param {Object} [options={}] - Optional parameters.
 * @param {Object} [options.env] - Environment variables for the command.
 * @param {string} [options.cwd] - Working directory for the command.
 * @param {string} [options.stdout] - Redirect stdout (can be 'inherit').
 * @param {string} [options.stderr] - Redirect stderr (can be 'inherit').
 * @param {string} [options.input] - A string to be passed as input to the command.
 *
 * @returns {string} - The stdout output of the command (if not forwarded).
 *
 * @throws {Error} - Throws an error if the command exits with a non-zero status.
 *
 * Example usage:
 *
 * 1. Basic call:
 * ```js
 * const output = execFileSync('echo', ['Hello, World!']);
 * console.log(output);  // Outputs: Hello, World!
 * ```
 *
 * 2. Call with custom environment and working directory:
 * ```js
 * const output = execFileSync('printenv', [], { env: { CUSTOM_ENV: 'myvalue' }, cwd: '/tmp' });
 * console.log(output);  // Outputs: CUSTOM_ENV=myvalue
 * ```
 *
 * 3. Call with stdout and stderr forwarded (no capture, direct display):
 * ```js
 * execFileSync('your_command', ['arg1', 'arg2'], { stdout: 'inherit', stderr: 'inherit' });
 * ```
 *
 * 4. Call with input string:
 * ```js
 * const output = execFileSync('cat', [], { input: 'Hello from input!' });
 * console.log(output);  // Outputs: Hello from input!
 * ```
 */
export const execFileSync = (file, args = [], options = {}) => {
	if (typeof file !== 'string') {
		throw new TypeError('file must be a string');
	}
	if (!Array.isArray(args)) {
		throw new TypeError('args must be an array');
	}
	if (options != null && typeof options !== 'object') {
		throw new TypeError('options must be an object');
	}

	let env = options.env || std.getenviron();  // Use the provided environment or current one
	let cwd = options.cwd || undefined;    // Optional working directory

	// Create pipes for stdin, stdout, and stderr
	let [stdinRead, stdinWrite] = [null, null];
	if (options.input) {
		[stdinRead, stdinWrite] = os.pipe();
	}

	const inheritStdout = options.stdout === 'inherit';
	let stdoutRead, stdoutWrite;
	if (!inheritStdout) {
		[stdoutRead, stdoutWrite] = os.pipe();
	}

	const inheritStderr = options.stderr === 'inherit';
	let stderrRead, stderrWrite;
	if (!inheritStderr) {
		[stderrRead, stderrWrite] = os.pipe();
	}
	
	// Prepare the process execution
	let execOptions = {
		env: env,
		cwd: cwd,
		...(options.input ? { stdin: stdinRead } : {}),
		...(inheritStdout ? {} : { stdout: stdoutWrite }),
		...(inheritStderr ? {} : { stderr: stderrWrite }),

	};

	// Write input to the process if provided
	if (options.input) {
		let inputFile = std.fdopen(stdinWrite, 'w');
		inputFile.puts(options.input);
		inputFile.close();
	}

	let exitCode = os.exec([file, ...args], execOptions);

	// Close the parent's copy of stdinRead after the child has inherited it
	if (options.input) {
		os.close(stdinRead);
	}

  // Read stdout and stderr from pipes if not forwarded
	let output = "";
	if (!inheritStdout) {
    os.close(stdoutWrite);
		output = readFromFd(stdoutRead);  // Capture stdout
		os.close(stdoutRead);  // Close the read-end of stdout pipe
	}

  let errorOutput = "";
  if (!inheritStderr) {
    os.close(stderrWrite);
		errorOutput = readFromFd(stderrRead);  // Capture stderr
		os.close(stderrRead);  // Close the read-end of stderr pipe
  }

	// Handle error case if exit code is non-zero
	if (exitCode !== 0) {
		let argsSection = args
			.map(a => `'${a}'`)
			.join(', ')
			.replaceAll("\n", "\n  ")

		let errorMsg = `Command: ['${file}', ${argsSection}]\n`
		if(argsSection.includes("\n"))
			errorMsg += "\n"

		errorMsg += `Exit Code: ${exitCode}\n`

		if (options.env) {
			let envVars = Object.entries(options.env)
				.map(([key, value]) => `${key}=${value}`)
				.join('\n')
				
			errorMsg += `Env:\n${indent(envVars)}\n\n`;
		}

		// Add working directory if specified
		if (options.cwd) {
			errorMsg += `Cwd: ${options.cwd}\n`;
		}

    // errorMsg += `Stdout:\n${indent(output)}\n`
		// if(output.includes("\n"))
		// 	errorMsg += "\n"

		// Append error output from stderr if it was captured
    errorMsg += `Stderr:\n${indent(errorOutput)}\n`;
		if(errorOutput.includes("\n"))
			errorMsg += "\n"

		throw new Error(errorMsg);
	}

	// Return stdout output (trimmed) if captured
	return output.trim();
};

/**
 * Reads the entire contents from a file descriptor (fd) using std.fdopen.
 * 
 * @param {number} fd - The file descriptor to read from.
 * @returns {string} - The string contents of the file descriptor.
 */
function readFromFd(fd) {
  let file = std.fdopen(fd, 'r');

  if(file === null) {
    throw new Error(`Failed to open file descriptor: ${fd}`);
  }

  let output = file.readAsString();
  file.close();

  return output;
}

/**
 * @param {*} prefix 
 * @param {string} str 
 */
function prefixLines(prefix, str){
	return str.split("\n")
		.map(line => prefix + line)
		.join("\n")
}

const indent = str => prefixLines("  ", str)
