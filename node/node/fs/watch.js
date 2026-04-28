/*
 * node:fs — fs.watch / FSWatcher
 *
 * Wraps qn_uv_fs_event (uv_fs_event_t) in the Node.js FSWatcher API.
 * Native recursive works on macOS/Windows. On Linux, inotify has no recursive
 * mode, so we walk the tree and create one handle per directory, adding/
 * removing handles as subdirectories are created/deleted (same strategy as
 * Node.js).
 */

import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import { fsWatch, UV_RENAME, UV_CHANGE } from 'qn_uv_fs_event'
import { statSync, readdirSync, S_IFMT, S_IFDIR } from 'qn:uv-fs'
import { toPath } from './_path.js'

const PLATFORM = (() => {
	try {
		/* Avoid hard dep on node:os here to prevent init cycles */
		return globalThis.process?.platform || 'linux'
	} catch {
		return 'linux'
	}
})()

function eventName(bits) {
	return (bits & UV_RENAME) ? 'rename' : 'change'
}

function encodeFilename(name, encoding) {
	if (name == null) return null
	if (encoding === 'buffer') return Buffer.from(name, 'utf8')
	return name
}

function joinRel(prefix, name) {
	if (!prefix) return name
	if (name == null) return prefix
	return prefix + '/' + name
}

function isDirSync(path) {
	try {
		return (statSync(path).mode & S_IFMT) === S_IFDIR
	} catch {
		return false
	}
}

function listDirsSync(path) {
	let entries
	try {
		entries = readdirSync(path)
	} catch {
		return []
	}
	const dirs = []
	for (const { name } of entries) {
		const child = path + '/' + name
		if (isDirSync(child)) dirs.push({ name, path: child })
	}
	return dirs
}

export class FSWatcher extends EventEmitter {
	constructor() {
		super()
		this._closed = false
		this._encoding = 'utf8'
		/* Map of relPrefix → native handle. relPrefix is the path from the
		 * watched root; empty string for the root itself. Only populated on
		 * Linux-recursive; for native-recursive / non-recursive we keep a
		 * single entry with key "". */
		this._handles = new Map()
		/* Set of real paths we've watched (symlink-loop guard, Linux only). */
		this._seenReal = new Set()
		this._rootPath = null
		this._recursive = false
		this._emulateRecursive = false
	}

	_start(rootPath, opts) {
		this._rootPath = rootPath
		this._encoding = opts.encoding || 'utf8'
		this._recursive = !!opts.recursive
		this._emulateRecursive = this._recursive && PLATFORM === 'linux' && isDirSync(rootPath)

		if (this._emulateRecursive) {
			/* Root must exist (fsWatch throws sync), subdir failures tolerated. */
			this._addHandleStrict(rootPath, '', false)
			for (const sub of listDirsSync(rootPath)) {
				this._addDirRecursive(sub.path, sub.name)
			}
		} else {
			this._addHandleStrict(rootPath, '', this._recursive)
		}

		if (opts.persistent === false) this.unref()

		if (opts.signal) {
			const signal = opts.signal
			if (signal.aborted) {
				queueMicrotask(() => this.close())
			} else {
				const onAbort = () => this.close()
				signal.addEventListener('abort', onAbort, { once: true })
				this._onAbort = () => signal.removeEventListener('abort', onAbort)
			}
		}
	}

	/* Strict: fsWatch errors propagate synchronously (Node throws on ENOENT). */
	_addHandleStrict(path, relPrefix, recursive) {
		if (this._closed) return
		if (this._handles.has(relPrefix)) return
		const handle = fsWatch(path, recursive, (events, filename) => {
			this._onEvent(relPrefix, events, filename)
		})
		this._handles.set(relPrefix, handle)
	}

	/* Tolerant: swallows errors (used for subdirs during Linux recursive walk,
	 * where a dir can vanish between readdir and fsWatch). */
	_addHandleSafe(path, relPrefix) {
		if (this._closed) return
		if (this._handles.has(relPrefix)) return
		try {
			const handle = fsWatch(path, false, (events, filename) => {
				this._onEvent(relPrefix, events, filename)
			})
			this._handles.set(relPrefix, handle)
		} catch {}
	}

	_addDirRecursive(path, relPrefix) {
		/* Symlink-loop guard: dedup by resolved path string. Cheap and catches
		 * obvious self-loops; a determined attacker could still cause a large
		 * walk but not infinite recursion. */
		if (this._seenReal.has(path)) return
		this._seenReal.add(path)

		this._addHandleSafe(path, relPrefix)

		for (const sub of listDirsSync(path)) {
			const childRel = relPrefix ? relPrefix + '/' + sub.name : sub.name
			this._addDirRecursive(sub.path, childRel)
		}
	}

	_onEvent(relPrefix, events, filename) {
		if (this._closed) return

		/* Negative values are uv errors surfaced by the C callback. */
		if (events < 0) {
			const err = new Error(`fs.watch error (uv errno ${events})`)
			err.code = 'UV_ERR'
			this.emit('error', err)
			return
		}

		const combinedRel = joinRel(relPrefix, filename)
		const outName = this._emulateRecursive
			? (combinedRel === '' ? null : combinedRel)
			: filename
		const type = eventName(events)
		this.emit('change', type, encodeFilename(outName, this._encoding))

		/* Linux-recursive emulation: on rename in a watched dir, a subdir may
		 * have appeared (add watcher) or disappeared (drop watcher). */
		if (this._emulateRecursive && (events & UV_RENAME) && filename) {
			const parentPath = relPrefix
				? this._rootPath + '/' + relPrefix
				: this._rootPath
			const childPath = parentPath + '/' + filename
			const childRel = relPrefix ? relPrefix + '/' + filename : filename
			if (isDirSync(childPath)) {
				this._addDirRecursive(childPath, childRel)
			} else {
				/* Path gone (or is now a file) — drop any handle registered
				 * under its prefix. Also drop handles for descendants. */
				this._dropPrefix(childRel)
			}
		}
	}

	_dropPrefix(prefix) {
		const prefixSlash = prefix + '/'
		for (const key of Array.from(this._handles.keys())) {
			if (key === prefix || key.startsWith(prefixSlash)) {
				try { this._handles.get(key).close() } catch {}
				this._handles.delete(key)
			}
		}
	}

	close() {
		if (this._closed) return
		this._closed = true
		for (const h of this._handles.values()) {
			try { h.close() } catch {}
		}
		this._handles.clear()
		this._seenReal.clear()
		if (this._onAbort) { this._onAbort(); this._onAbort = null }
		this.emit('close')
	}

	ref() {
		for (const h of this._handles.values()) {
			try { h.ref() } catch {}
		}
		return this
	}

	unref() {
		for (const h of this._handles.values()) {
			try { h.unref() } catch {}
		}
		return this
	}
}

export function watch(filename, options, listener) {
	if (typeof options === 'function') {
		listener = options
		options = undefined
	}
	if (typeof options === 'string') options = { encoding: options }
	options = options || {}

	filename = toPath(filename)

	const watcher = new FSWatcher()
	if (typeof listener === 'function') watcher.on('change', listener)
	watcher._start(filename, options)
	return watcher
}
