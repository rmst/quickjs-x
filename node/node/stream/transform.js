/*
 * node:stream Transform — minimal but correct.
 *
 * Subclasses implement _transform(chunk, encoding, cb) and optionally
 * _flush(cb). Provides:
 *   - write/end (Writable side) with backpressure (`drain` event)
 *   - data/end/readable events + .read() + Symbol.asyncIterator (Readable side)
 *   - .pipe(dest) honors dest.write()'s backpressure return value
 *   - destroy(err) cleans up and emits 'close'
 *
 * Single-input serialization: only one _transform call is in flight at a
 * time; subsequent writes are queued until the current one completes.
 *
 * Not a 1:1 reimplementation of Node's Transform — known omissions:
 * objectMode, cork/uncork, allowHalfOpen, setDefaultEncoding, autoDestroy
 * config (always behaves as if true). Sufficient for node:zlib piping and
 * the common pipe/asyncIterator patterns. */

import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import { setImmediate } from 'node:timers'

const DEFAULT_HWM = 16 * 1024

export class Transform extends EventEmitter {
	#opts
	#hwmW
	#hwmR

	// Writable side state
	#writableEnded = false
	#writableFinished = false
	#busy = false
	#pendingWrites = []   // [{ chunk, encoding, cb }]

	// Readable side state
	#buffer = []          // [Uint8Array|string]
	#bufBytes = 0
	#flowing = false
	#readableEnded = false
	#flushed = false      // _flush called
	#endEmitted = false
	#encoding = null

	#destroyed = false
	#errored = false
	#needDrain = false    // set when write returned false; emit on drain

	bytesRead = 0
	bytesWritten = 0

	constructor(opts) {
		super()
		this.#opts = opts || {}
		this.#hwmW = this.#opts.writableHighWaterMark
			?? this.#opts.highWaterMark ?? DEFAULT_HWM
		this.#hwmR = this.#opts.readableHighWaterMark
			?? this.#opts.highWaterMark ?? DEFAULT_HWM
	}

	/* Subclass hooks. Override these. */
	_transform(chunk, encoding, cb) { cb(null, chunk) }
	_flush(cb) { cb() }

	/* ---- Writable side ---- */

	write(chunk, encoding, cb) {
		if (typeof encoding === 'function') { cb = encoding; encoding = null }
		if (this.#destroyed || this.#errored) {
			const err = new Error('write after destroy')
			if (cb) setImmediate(() => cb(err))
			return false
		}
		if (this.#writableEnded) {
			const err = new Error('write after end')
			if (cb) setImmediate(() => cb(err))
			else this.emit('error', err)
			return false
		}
		if (typeof chunk === 'string') {
			chunk = Buffer.from(chunk, encoding || 'utf8')
		}
		this.bytesWritten += chunk.length

		if (this.#busy || this.#pendingWrites.length > 0) {
			this.#pendingWrites.push({ chunk, encoding, cb })
		} else {
			this.#runTransform(chunk, encoding, cb)
		}

		// Backpressure: return false if either side is over its high water mark.
		const over = this.#bufBytes >= this.#hwmR
			|| this.#queuedWriteBytes() >= this.#hwmW
		if (over) this.#needDrain = true
		return !over
	}

	end(chunk, encoding, cb) {
		if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = null }
		else if (typeof encoding === 'function') { cb = encoding; encoding = null }
		if (chunk != null) this.write(chunk, encoding)
		if (this.#writableEnded) { if (cb) setImmediate(cb); return this }
		this.#writableEnded = true
		if (cb) this.once('finish', cb)
		this.#tryFlush()
		return this
	}

	#queuedWriteBytes() {
		let n = 0
		for (const w of this.#pendingWrites) n += w.chunk.length
		return n
	}

	#runTransform(chunk, encoding, cb) {
		this.#busy = true
		try {
			this._transform(chunk, encoding, (err, out) => {
				this.#busy = false
				if (err) { this.#fail(err); if (cb) cb(err); return }
				if (out) this.push(out)
				if (cb) cb()
				this.#drainPending()
			})
		} catch (e) {
			this.#busy = false
			this.#fail(e)
			if (cb) cb(e)
		}
	}

	#drainPending() {
		while (this.#pendingWrites.length > 0 && !this.#busy && !this.#destroyed) {
			const w = this.#pendingWrites.shift()
			this.#runTransform(w.chunk, w.encoding, w.cb)
		}
		if (!this.#busy && this.#pendingWrites.length === 0) {
			if (this.#needDrain
				&& this.#bufBytes < this.#hwmR
				&& this.#queuedWriteBytes() < this.#hwmW) {
				this.#needDrain = false
				this.emit('drain')
			}
			if (this.#writableEnded) this.#tryFlush()
		}
	}

	#tryFlush() {
		if (this.#flushed || this.#busy || this.#pendingWrites.length > 0) return
		this.#flushed = true
		try {
			this._flush((err, out) => {
				if (err) { this.#fail(err); return }
				if (out) this.push(out)
				if (!this.#writableFinished) {
					this.#writableFinished = true
					this.emit('finish')
				}
				this.push(null)
			})
		} catch (e) { this.#fail(e) }
	}

	/* ---- Readable side ---- */

	push(chunk) {
		if (this.#readableEnded) return false
		if (chunk === null) {
			this.#readableEnded = true
			this.#maybeEmitEnd()
			return false
		}
		if (typeof chunk === 'string') {
			chunk = Buffer.from(chunk, 'utf8')
		}
		this.bytesRead += chunk.length
		this.#bufBytes += chunk.length
		this.#buffer.push(chunk)
		if (this.#flowing) this.#emitData()
		else this.emit('readable')
		return this.#bufBytes < this.#hwmR
	}

	#emitData() {
		while (this.#flowing && this.#buffer.length > 0) {
			const chunk = this.#buffer.shift()
			this.#bufBytes -= chunk.length
			let out = chunk
			if (this.#encoding) out = chunk.toString(this.#encoding)
			this.emit('data', out)
		}
		this.#maybeEmitEnd()
		// If we drained the readable buffer, kick the writable side in case
		// it's waiting on backpressure.
		if (this.#bufBytes < this.#hwmR) this.#drainPending()
	}

	#maybeEmitEnd() {
		if (!this.#endEmitted && this.#readableEnded
			&& this.#buffer.length === 0
			&& (this.#flowing || this.listenerCount('end') > 0)) {
			this.#endEmitted = true
			setImmediate(() => this.emit('end'))
		}
	}

	read(n) {
		if (this.#buffer.length === 0) return null
		if (n == null || n >= this.#bufBytes) {
			const all = Buffer.concat(this.#buffer)
			this.#buffer = []
			this.#bufBytes = 0
			return this.#encoding ? all.toString(this.#encoding) : all
		}
		// Partial read: peel off n bytes
		let collected = 0
		const out = []
		while (collected < n && this.#buffer.length > 0) {
			const c = this.#buffer[0]
			const need = n - collected
			if (c.length <= need) {
				out.push(c)
				collected += c.length
				this.#buffer.shift()
			} else {
				out.push(c.subarray(0, need))
				this.#buffer[0] = c.subarray(need)
				collected += need
			}
		}
		this.#bufBytes -= collected
		const buf = Buffer.concat(out)
		return this.#encoding ? buf.toString(this.#encoding) : buf
	}

	pause()  { this.#flowing = false; return this }
	resume() {
		this.#flowing = true
		setImmediate(() => this.#emitData())
		return this
	}

	setEncoding(enc) {
		if (enc && enc.toLowerCase().replace('-', '') !== 'utf8') {
			throw new Error(`Unsupported encoding: ${enc}`)
		}
		this.#encoding = enc ? 'utf8' : null
		return this
	}

	pipe(dest, opts) {
		const onData = (chunk) => {
			if (dest.write(chunk) === false) this.pause()
		}
		const onDrain = () => this.resume()
		const onEnd = () => {
			if (!opts || opts.end !== false) {
				if (typeof dest.end === 'function') dest.end()
			}
		}
		const onError = (err) => {
			if (typeof dest.emit === 'function') dest.emit('error', err)
		}

		this.on('data', onData)
		if (typeof dest.on === 'function') dest.on('drain', onDrain)
		this.on('end', onEnd)
		this.on('error', onError)
		this.resume()
		return dest
	}

	on(event, listener) {
		const r = super.on(event, listener)
		if (event === 'data' && !this.#flowing) this.resume()
		else if (event === 'end' && this.#readableEnded) this.#maybeEmitEnd()
		return r
	}

	addListener(event, listener) { return this.on(event, listener) }

	[Symbol.asyncIterator]() {
		return this.#asyncIter()
	}

	async *#asyncIter() {
		const queue = []
		let resolveNext = null
		let ended = false
		let error = null

		const onData = (c) => {
			if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: c, done: false }) }
			else queue.push(c)
		}
		const onEnd = () => {
			ended = true
			if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }) }
		}
		const onError = (err) => {
			error = err
			if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }) }
		}

		this.on('data', onData)
		this.on('end', onEnd)
		this.on('error', onError)

		try {
			while (true) {
				if (error) throw error
				if (queue.length > 0) { yield queue.shift(); continue }
				if (ended) return
				const next = await new Promise((res) => { resolveNext = res })
				if (error) throw error
				if (next.done) return
				yield next.value
			}
		} finally {
			this.off('data', onData)
			this.off('end', onEnd)
			this.off('error', onError)
		}
	}

	destroy(err) {
		if (this.#destroyed) return this
		this.#destroyed = true
		if (err) {
			this.#errored = true
			setImmediate(() => this.emit('error', err))
		}
		setImmediate(() => this.emit('close'))
		return this
	}

	#fail(err) {
		if (this.#errored) return
		this.#errored = true
		this.#destroyed = true
		setImmediate(() => this.emit('error', err))
	}

	get writableEnded() { return this.#writableEnded }
	get writableFinished() { return this.#writableFinished }
	get readableEnded() { return this.#readableEnded && this.#buffer.length === 0 }
	get destroyed() { return this.#destroyed }
	get readableHighWaterMark() { return this.#hwmR }
	get writableHighWaterMark() { return this.#hwmW }
	get readableLength() { return this.#bufBytes }
}

/* Duplex is the same shape minus the implicit pass-through; subclasses
 * provide both _read and _write. For our needs Transform covers it, and
 * we expose Duplex as an alias since most code uses Transform anyway. */
export class Duplex extends Transform {}

/* PassThrough is a no-op Transform — Transform's default _transform already
 * forwards each chunk unchanged, so the subclass needs no body. */
export class PassThrough extends Transform {}
