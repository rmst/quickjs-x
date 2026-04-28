/**
 * node:timers — timer functions backed by libuv uv_timer_t via qn_vm.
 */
import {
	setTimeout as _setTimeout, clearTimeout as _clearTimeout,
	timerRef as _timerRef, timerUnref as _timerUnref,
} from 'qn_vm'
import { NodeCompatibilityError } from './errors.js'

// Timer handle wrapper — matches Node.js Timeout interface (ref/unref/Symbol.toPrimitive)
class TimerHandle {
	#id
	constructor(id) { this.#id = id }
	ref() { _timerRef(this.#id); return this }
	unref() { _timerUnref(this.#id); return this }
	[Symbol.toPrimitive]() { return this.#id }
}

export function setTimeout(fn, delay, ...args) {
	if (args.length > 0) {
		throw new NodeCompatibilityError('setTimeout does not support passing arguments to callback. Use an arrow function instead.')
	}
	return new TimerHandle(_setTimeout(fn, delay))
}

export function clearTimeout(handle) {
	_clearTimeout(+handle)
}

export function setImmediate(fn, ...args) {
	return new TimerHandle(_setTimeout(() => fn(...args), 0))
}

export function clearImmediate(handle) {
	_clearTimeout(+handle)
}

const _intervals = new Map()
let _intervalId = 1

export function setInterval(fn, delay, ...args) {
	if (args.length > 0)
		throw new NodeCompatibilityError('setInterval does not support passing arguments to callback. Use an arrow function instead.')
	const id = _intervalId++
	let unrefd = false
	const tick = () => {
		if (!_intervals.has(id)) return
		try { fn() } catch (e) { console.error(e) }
		if (_intervals.has(id)) {
			const timerId = _setTimeout(tick, delay)
			if (unrefd) _timerUnref(timerId)
			_intervals.set(id, timerId)
		}
	}
	const timerId = _setTimeout(tick, delay)
	_intervals.set(id, timerId)
	return {
		ref() { unrefd = false; _timerRef(_intervals.get(id)); return this },
		unref() { unrefd = true; _timerUnref(_intervals.get(id)); return this },
		[Symbol.toPrimitive]() { return id },
	}
}

export function clearInterval(handle) {
	const id = typeof handle === 'object' ? +handle : handle
	const timer = _intervals.get(id)
	if (timer !== undefined) {
		_clearTimeout(timer)
		_intervals.delete(id)
	}
}

export default {
	setTimeout, clearTimeout,
	setImmediate, clearImmediate,
	setInterval, clearInterval,
}
