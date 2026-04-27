/**
 * Node.js test runner module compatibility for Qn.
 * Implements the subset used by qn and jix tests.
 * @see https://nodejs.org/api/test.html
 */

import process from 'node:process'

// ANSI color codes
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'
const CYAN = '\x1b[36m'

// Consume and clear QN_TEST_CHILD so it doesn't propagate to nested child processes
const isChildProcess = !!process.env.QN_TEST_CHILD
delete process.env.QN_TEST_CHILD

/**
 * Create an empty suite object.
 */
function makeSuite(name, options, parent) {
	return {
		name,
		options,
		parent,
		tests: [],
		suites: [],
		before: [],
		after: [],
		beforeEach: [],
		afterEach: [],
	}
}

// Test state
const rootSuite = makeSuite(null, {}, null)
let currentSuite = rootSuite
let isRunning = false
let hasScheduledRun = false

// Results tracking
const results = {
	tests: 0,
	suites: 0,
	pass: 0,
	fail: 0,
	skip: 0,
	todo: 0,
	failures: []
}

/**
 * Test context passed to test functions.
 * Supports subtests via t.test()
 */
class TestContext {
	constructor(name, parent = null) {
		this.name = name
		this.parent = parent
		this.subtests = []
	}

	/**
	 * Create a subtest
	 */
	async test(name, optionsOrFn, maybeFn) {
		const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
		const options = typeof optionsOrFn === 'object' ? optionsOrFn : {}

		const subtest = { name, fn, options, parent: this }
		this.subtests.push(subtest)

		// Run the subtest immediately
		return runTest(subtest, null, getIndent(this) + 1)
	}
}

/**
 * Get nesting level for indentation
 */
function getIndent(context) {
	let indent = 0
	let current = context
	while (current && current.parent) {
		indent++
		current = current.parent
	}
	return indent
}

/**
 * Create indentation string
 */
function indent(level) {
	return '  '.repeat(level)
}

/**
 * Format duration
 */
function formatDuration(ms) {
	return `(${ms.toFixed(3)}ms)`
}

/**
 * Collect hooks of a given kind from root → suite (inclusive).
 * Used to assemble beforeEach/afterEach chains that cascade through
 * nested describe blocks like Node's runner.
 */
function collectChainHooks(suite, kind) {
	const chain = []
	let s = suite
	while (s) {
		chain.unshift(s)
		s = s.parent
	}
	return chain.flatMap(s => s[kind])
}

/**
 * Run a single test
 */
async function runTest(test, parentSuite, indentLevel = 0) {
	const { name, fn, options = {} } = test
	const pad = indent(indentLevel)

	if (options.skip) {
		console.log(`${pad}${YELLOW}⊘ ${name} ${DIM}[skipped]${RESET}`)
		results.skip++
		results.tests++
		return { passed: true, skipped: true }
	}

	if (options.todo) {
		console.log(`${pad}${BLUE}⊘ ${name} ${DIM}[todo]${RESET}`)
		results.todo++
		results.tests++
		return { passed: true, todo: true }
	}

	const context = new TestContext(name, test.parent)
	const startTime = performance.now()
	const errors = []

	const beforeEachHooks = parentSuite ? collectChainHooks(parentSuite, 'beforeEach') : []
	for (const h of beforeEachHooks) {
		try {
			await h.fn()
		} catch (error) {
			errors.push(error)
			break
		}
	}

	if (errors.length === 0) {
		try {
			await fn(context)
		} catch (error) {
			errors.push(error)
		}
	}

	const afterEachHooks = parentSuite ? collectChainHooks(parentSuite, 'afterEach').reverse() : []
	for (const h of afterEachHooks) {
		try {
			await h.fn()
		} catch (error) {
			errors.push(error)
		}
	}

	const duration = performance.now() - startTime

	if (errors.length === 0) {
		console.log(`${pad}${GREEN}✔${RESET} ${name} ${DIM}${formatDuration(duration)}${RESET}`)
		results.pass++
		results.tests++
		return { passed: true, duration }
	}

	console.log(`${pad}${RED}✖${RESET} ${name} ${DIM}${formatDuration(duration)}${RESET}`)
	results.fail++
	results.tests++
	for (const error of errors) {
		results.failures.push({ name, error, indentLevel })
	}
	return { passed: false, duration, error: errors[0] }
}

/**
 * Run tasks with bounded concurrency.
 * @param {Array<() => Promise>} tasks
 * @param {number} limit
 */
async function runWithPool(tasks, limit) {
	if (limit >= tasks.length) {
		return Promise.all(tasks.map(t => t()))
	}
	const executing = new Set()
	for (const task of tasks) {
		const p = task().then(() => executing.delete(p))
		executing.add(p)
		if (executing.size >= limit) {
			await Promise.race(executing)
		}
	}
	await Promise.all(executing)
}

/**
 * Run a suite (describe block)
 */
async function runSuite(suite, indentLevel = 0) {
	const pad = indent(indentLevel)
	const startTime = performance.now()
	const failsBefore = results.fail
	const concurrency = suite.options?.concurrency

	if (suite.name) {
		console.log(`${pad}${BOLD}▶${RESET} ${suite.name}`)
		results.suites++
	}

	const childIndent = suite.name ? indentLevel + 1 : indentLevel
	const hookLabel = suite.name || '<root>'

	let beforeFailed = false
	for (const h of suite.before) {
		try {
			await h.fn()
		} catch (error) {
			beforeFailed = true
			console.log(`${indent(childIndent)}${RED}✖${RESET} before hook failed`)
			results.fail++
			results.failures.push({ name: `${hookLabel} > before`, error, indentLevel: childIndent })
			break
		}
	}

	if (!beforeFailed) {
		if (concurrency) {
			// Run tests and nested suites concurrently
			const allTasks = [
				...suite.tests.map(test => () => runTest(test, suite, childIndent)),
				...suite.suites.map(nested => () => runSuite(nested, childIndent)),
			]
			const limit = concurrency === true ? Infinity : concurrency
			await runWithPool(allTasks, limit)
		} else {
			// Run sequentially (default)
			for (const test of suite.tests) {
				await runTest(test, suite, childIndent)
			}
			for (const nested of suite.suites) {
				await runSuite(nested, childIndent)
			}
		}

		for (const h of suite.after) {
			try {
				await h.fn()
			} catch (error) {
				console.log(`${indent(childIndent)}${RED}✖${RESET} after hook failed`)
				results.fail++
				results.failures.push({ name: `${hookLabel} > after`, error, indentLevel: childIndent })
				break
			}
		}
	}

	if (suite.name) {
		const duration = performance.now() - startTime
		const suiteFailed = results.fail > failsBefore
		const status = suiteFailed ? `${RED}✖${RESET}` : `${GREEN}✔${RESET}`
		console.log(`${pad}${status} ${suite.name} ${DIM}${formatDuration(duration)}${RESET}`)
	}
}

/**
 * Print final summary
 */
function printSummary(totalDuration) {
	console.log(`${DIM}ℹ${RESET} tests ${results.tests}`)
	console.log(`${DIM}ℹ${RESET} suites ${results.suites}`)
	console.log(`${DIM}ℹ${RESET} pass ${results.pass}`)
	console.log(`${DIM}ℹ${RESET} fail ${results.fail}`)
	if (results.skip > 0) console.log(`${DIM}ℹ${RESET} skipped ${results.skip}`)
	if (results.todo > 0) console.log(`${DIM}ℹ${RESET} todo ${results.todo}`)
	console.log(`${DIM}ℹ${RESET} duration_ms ${totalDuration.toFixed(3)}`)

	// Print failure details
	if (results.failures.length > 0) {
		console.log(`\n${RED}✖ failing tests:${RESET}\n`)
		for (const { name, error, indentLevel } of results.failures) {
			console.log(`${RED}✖${RESET} ${name}`)
			console.log(`  ${error.name || 'Error'}: ${error.message}`)
			if (error.stack) {
				const stackLines = error.stack.split('\n').slice(1, 5)
				for (const line of stackLines) {
					console.log(`  ${DIM}${line.trim()}${RESET}`)
				}
			}
			console.log()
		}
	}
}

/**
 * Run all registered tests
 */
async function runAllTests() {
	if (isRunning) return
	isRunning = true

	const startTime = performance.now()

	await runSuite(rootSuite)

	const totalDuration = performance.now() - startTime

	if (isChildProcess) {
		// Child process mode: emit machine-readable results for the parent
		const json = JSON.stringify({
			tests: results.tests,
			suites: results.suites,
			pass: results.pass,
			fail: results.fail,
			skip: results.skip,
			todo: results.todo,
			duration_ms: totalDuration,
			failures: results.failures.map(f => ({
				name: f.name,
				message: f.error?.message,
				stack: f.error?.stack,
			})),
		})
		process.stderr.write(`QN_TEST_RESULT:${json}\n`)
	} else {
		printSummary(totalDuration)
	}

	process.exitCode = results.fail > 0 ? 1 : 0
}

/**
 * Schedule test run after current module evaluation
 */
function scheduleRun() {
	if (hasScheduledRun) return
	hasScheduledRun = true

	// Use setTimeout to run after all describe/test calls are registered
	setTimeout(runAllTests, 0)
}

/**
 * Create a test suite (describe block)
 */
export function describe(name, optionsOrFn, maybeFn) {
	const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
	const options = typeof optionsOrFn === 'object' ? optionsOrFn : {}

	const suite = makeSuite(name, options, currentSuite)
	currentSuite.suites.push(suite)

	const previousSuite = currentSuite
	currentSuite = suite
	fn()
	currentSuite = previousSuite

	scheduleRun()
}

/**
 * Create a test case
 */
export function test(name, optionsOrFn, maybeFn) {
	const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
	const options = typeof optionsOrFn === 'object' ? optionsOrFn : {}

	currentSuite.tests.push({ name, fn, options })
	scheduleRun()
}

/**
 * Create a skipped test
 */
test.skip = function skip(name, optionsOrFn, maybeFn) {
	const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
	const options = typeof optionsOrFn === 'object' ? optionsOrFn : {}
	options.skip = true
	currentSuite.tests.push({ name, fn, options })
	scheduleRun()
}

/**
 * Create a todo test
 */
test.todo = function todo(name, optionsOrFn, maybeFn) {
	const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
	const options = typeof optionsOrFn === 'object' ? optionsOrFn : {}
	options.todo = true
	currentSuite.tests.push({ name, fn, options })
	scheduleRun()
}

/**
 * Run only this test (marks others as skipped)
 * Note: This is a simplified implementation
 */
test.only = function only(name, optionsOrFn, maybeFn) {
	const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
	const options = typeof optionsOrFn === 'object' ? optionsOrFn : {}
	options.only = true
	currentSuite.tests.push({ name, fn, options })
	scheduleRun()
}

// Alias
export const it = test

/**
 * Register a hook that runs once before all tests in the current suite.
 */
export function before(fn, options = {}) {
	currentSuite.before.push({ fn, options })
}

/**
 * Register a hook that runs once after all tests in the current suite.
 */
export function after(fn, options = {}) {
	currentSuite.after.push({ fn, options })
}

/**
 * Register a hook that runs before each test in the current suite
 * (and tests in nested suites).
 */
export function beforeEach(fn, options = {}) {
	currentSuite.beforeEach.push({ fn, options })
}

/**
 * Register a hook that runs after each test in the current suite
 * (and tests in nested suites).
 */
export function afterEach(fn, options = {}) {
	currentSuite.afterEach.push({ fn, options })
}

// Default export includes all functions
export default { describe, test, it, before, after, beforeEach, afterEach }
