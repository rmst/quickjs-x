/**
 * AbortController and AbortSignal implementation
 * https://dom.spec.whatwg.org/#interface-abortcontroller
 */

/**
 * Minimal EventTarget implementation for AbortSignal
 */
class EventTarget {
	constructor() {
		this._listeners = new Map()
	}

	addEventListener(type, callback, options) {
		if (typeof callback !== 'function') return

		let listeners = this._listeners.get(type)
		if (!listeners) {
			listeners = []
			this._listeners.set(type, listeners)
		}

		const once = options?.once ?? false
		listeners.push({ callback, once })
	}

	removeEventListener(type, callback) {
		const listeners = this._listeners.get(type)
		if (!listeners) return

		const index = listeners.findIndex(l => l.callback === callback)
		if (index !== -1) {
			listeners.splice(index, 1)
		}
	}

	dispatchEvent(event) {
		const listeners = this._listeners.get(event.type)
		if (!listeners) return true

		// Copy array since listeners may remove themselves
		for (const { callback, once } of [...listeners]) {
			if (once) {
				this.removeEventListener(event.type, callback)
			}
			callback.call(this, event)
		}
		return !event.defaultPrevented
	}
}

/**
 * AbortSignal - signals when an operation should be aborted
 * https://dom.spec.whatwg.org/#interface-abortsignal
 */
export class AbortSignal extends EventTarget {
	constructor() {
		super()
		this._aborted = false
		this._reason = undefined
		this.onabort = null
	}

	get aborted() {
		return this._aborted
	}

	get reason() {
		return this._reason
	}

	throwIfAborted() {
		if (this._aborted) {
			throw this._reason
		}
	}

	// Internal method called by AbortController
	_abort(reason) {
		if (this._aborted) return

		this._aborted = true
		this._reason = reason ?? new DOMException('This operation was aborted', 'AbortError')

		const event = { type: 'abort', target: this }
		if (typeof this.onabort === 'function') {
			this.onabort(event)
		}
		this.dispatchEvent(event)
	}

	/**
	 * Returns an AbortSignal that is already aborted
	 */
	static abort(reason) {
		const signal = new AbortSignal()
		signal._abort(reason)
		return signal
	}

	/**
	 * Returns an AbortSignal that aborts after the given timeout
	 */
	static timeout(milliseconds) {
		const signal = new AbortSignal()
		setTimeout(() => {
			signal._abort(new DOMException('The operation timed out', 'TimeoutError'))
		}, milliseconds)
		return signal
	}

	/**
	 * Returns an AbortSignal that aborts when any of the given signals abort
	 */
	static any(signals) {
		const controller = new AbortController()

		for (const signal of signals) {
			if (signal.aborted) {
				controller.abort(signal.reason)
				return controller.signal
			}
			signal.addEventListener('abort', () => {
				controller.abort(signal.reason)
			}, { once: true })
		}

		return controller.signal
	}
}

/**
 * AbortController - allows aborting one or more operations
 * https://dom.spec.whatwg.org/#interface-abortcontroller
 */
export class AbortController {
	constructor() {
		this._signal = new AbortSignal()
	}

	get signal() {
		return this._signal
	}

	abort(reason) {
		this._signal._abort(reason)
	}
}

export default { AbortSignal, AbortController }
