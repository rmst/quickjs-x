/**
 * Glob pattern matching for node:fs
 */

import { statSync } from 'qn:uv-fs'
import picomatch from '../glob/index.js'
// Use relative import to avoid circular dependency with node:fs
import { readdirSync, lstatSync } from './index.js'
import { toPath } from './_path.js'

/**
 * Recursively match files against glob patterns.
 * @param {string|string[]} pattern - Glob pattern(s) to match
 * @param {Object} [options] - Options
 * @param {string} [options.cwd] - Current working directory (default: process.cwd())
 * @param {Function} [options.exclude] - Function to exclude paths, receives path as dirent-like object
 * @param {boolean} [options.withFileTypes] - Return Dirent objects instead of strings
 * @returns {string[]|Dirent[]} Array of matching paths
 */
export function globSync(pattern, options = {}) {
	const cwd = options.cwd != null ? toPath(options.cwd) : process.cwd()
	const exclude = options.exclude
	const withFileTypes = options.withFileTypes || false

	// Normalize patterns to array and strip leading ./
	const patterns = Array.isArray(pattern) ? pattern : [pattern]
	const normalizePattern = p => p.startsWith('./') ? p.slice(2) : p

	// Separate negation patterns from positive patterns
	const positivePatterns = []
	const negativePatterns = []

	for (const p of patterns) {
		if (p.startsWith('!') && !p.startsWith('!(')) {
			negativePatterns.push(normalizePattern(p.slice(1)))
		} else {
			positivePatterns.push(normalizePattern(p))
		}
	}

	// Create matchers
	const positiveMatcher = positivePatterns.length > 0
		? picomatch(positivePatterns, { dot: options.dot })
		: () => false
	const negativeMatcher = negativePatterns.length > 0
		? picomatch(negativePatterns, { dot: options.dot })
		: () => false

	const results = []
	const seen = new Set()

	// Analyze patterns to find the base directory to start searching from
	function getBaseDir(pattern) {
		const scanned = picomatch.scan(pattern)
		return scanned.base || '.'
	}

	// Get unique base directories to search
	const baseDirs = new Set()
	for (const p of positivePatterns) {
		baseDirs.add(getBaseDir(p))
	}

	// Check if pattern needs recursive search
	function needsRecursive(pattern) {
		return pattern.includes('**') || pattern.includes('/')
	}

	const recursive = positivePatterns.some(needsRecursive)

	// Walk directory and collect matches
	function walk(dir, relativePath = '') {
		let entries
		try {
			entries = readdirSync(dir)
		} catch (e) {
			return // Skip directories we can't read
		}

		for (const name of entries) {
			const fullPath = dir === '.' ? name : `${dir}/${name}`
			const relPath = relativePath ? `${relativePath}/${name}` : name

			let stat
			try {
				stat = lstatSync(fullPath)
			} catch (e) {
				continue // Skip entries we can't stat
			}

			const isDir = stat.isDirectory()

			// Create dirent-like object for exclude function
			const dirent = {
				name,
				path: fullPath,
				parentPath: dir,
				isDirectory: () => isDir,
				isFile: () => stat.isFile(),
				isSymbolicLink: () => stat.isSymbolicLink(),
			}

			// Check exclude function
			if (exclude && exclude(dirent)) {
				continue
			}

			// Test against patterns
			if (positiveMatcher(relPath) && !negativeMatcher(relPath)) {
				if (!seen.has(relPath)) {
					seen.add(relPath)
					if (withFileTypes) {
						results.push(dirent)
					} else {
						results.push(relPath)
					}
				}
			}

			// Recurse into directories
			if (isDir && recursive) {
				walk(fullPath, relPath)
			}
		}
	}

	// Start walking from each base directory
	const originalCwd = process.cwd()
	try {
		process.chdir(cwd)

		for (const baseDir of baseDirs) {
			const startDir = baseDir === '' ? '.' : baseDir
			// Check if base directory exists before walking
			let exists = true
			try { statSync(startDir) } catch { exists = false }
			if (exists) {
				if (baseDir && baseDir !== '.') {
					// Start walking from base, but include base in relative path
					walk(startDir, baseDir)
				} else {
					walk(startDir, '')
				}
			}
		}
	} finally {
		process.chdir(originalCwd)
	}

	return results
}


/**
 * Async glob - returns an async iterable.
 * Since QuickJS doesn't have true async I/O, this is a thin wrapper over globSync.
 * @param {string|string[]} pattern - Glob pattern(s) to match
 * @param {Object} [options] - Options
 * @returns {AsyncIterable<string|Dirent>}
 */
export async function* glob(pattern, options = {}) {
	const results = globSync(pattern, options)
	for (const result of results) {
		yield result
	}
}
