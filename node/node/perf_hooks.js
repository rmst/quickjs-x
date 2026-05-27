import {
	hrtime as _hrtime,
	hrtimeBigInt as _hrtimeBigInt,
	eventLoopUtilization as _nativeEventLoopUtilization,
	setTimeout as _setTimeout,
	clearTimeout as _clearTimeout,
	timerUnref as _timerUnref,
} from 'qn_vm'
import { NodeCompatibilityError } from './errors.js'

// timeOrigin: ms since unix epoch when this module loaded (≈ process start).
// performance.now() returns ms since this same instant, so
// `timeOrigin + now() ≈ Date.now()` and now() is small, matching Node.
const _start = _hrtime()
const timeOrigin = Date.now()
const now = () => _hrtime() - _start

// Storage for marks/measures. Node.js exposes them via getEntries*.
const entries = []

// Active PerformanceObservers, dispatched on mark/measure.
const observers = new Set()
const dispatchEntry = (entry) => {
	for (const obs of observers) {
		if (obs._types.has(entry.entryType)) obs._buffer.push(entry)
	}
	queueMicrotask(() => {
		for (const obs of observers) {
			if (obs._buffer.length === 0) continue
			const list = obs._buffer
			obs._buffer = []
			try {
				obs._callback({
					getEntries: () => list.slice(),
					getEntriesByName: (n, t) => list.filter(e => e.name === n && (t === undefined || e.entryType === t)),
					getEntriesByType: (t) => list.filter(e => e.entryType === t),
				}, obs)
			} catch (e) {
				console.error(e)
			}
		}
	})
}

class PerformanceEntry {
	constructor(name, entryType, startTime, duration = 0) {
		this.name = name
		this.entryType = entryType
		this.startTime = startTime
		this.duration = duration
	}
	toJSON() {
		return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration }
	}
}

class PerformanceMark extends PerformanceEntry {
	constructor(name, options = {}) {
		const startTime = options.startTime ?? now()
		super(name, 'mark', startTime, 0)
		this.detail = options.detail ?? null
	}
}

class PerformanceMeasure extends PerformanceEntry {
	constructor(name, startTime, duration, detail = null) {
		super(name, 'measure', startTime, duration)
		this.detail = detail
	}
}

const findMark = (name) => {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].entryType === 'mark' && entries[i].name === name) return entries[i]
	}
	return null
}

const resolveMark = (v) => {
	if (typeof v !== 'string') return v
	const m = findMark(v)
	if (!m) throw new Error(`The "${v}" performance mark has not been set`)
	return m.startTime
}

const normalizeELU = (u) => ({
	idle: Number(u?.idle ?? 0),
	active: Number(u?.active ?? 0),
	utilization: Number(u?.utilization ?? 0),
})

const makeELU = (idle, active) => {
	const total = idle + active
	return { idle, active, utilization: total > 0 ? active / total : 0 }
}

const eventLoopUtilization = (utilization1, utilization2) => {
	if (utilization1 === undefined) return normalizeELU(_nativeEventLoopUtilization())

	const newer = utilization2 === undefined
		? normalizeELU(_nativeEventLoopUtilization())
		: normalizeELU(utilization1)
	const older = normalizeELU(utilization2 === undefined ? utilization1 : utilization2)
	return makeELU(newer.idle - older.idle, newer.active - older.active)
}

const performance = {
	timeOrigin,

	now,

	mark(name, options) {
		const m = new PerformanceMark(name, options)
		entries.push(m)
		dispatchEntry(m)
		return m
	},

	measure(name, startOrOptions, endMark) {
		let startTime, duration, detail = null
		if (typeof startOrOptions === 'object' && startOrOptions !== null) {
			const opts = startOrOptions
			detail = opts.detail ?? null
			const start = opts.start !== undefined ? resolveMark(opts.start) : undefined
			const end = opts.end !== undefined ? resolveMark(opts.end) : undefined
			if (opts.duration !== undefined) {
				if (start !== undefined) {
					startTime = start
					duration = opts.duration
				} else if (end !== undefined) {
					startTime = end - opts.duration
					duration = opts.duration
				} else {
					startTime = now()
					duration = opts.duration
				}
			} else {
				startTime = start ?? 0
				duration = (end ?? now()) - startTime
			}
		} else {
			const start = startOrOptions !== undefined ? resolveMark(startOrOptions) : 0
			const end = endMark !== undefined ? resolveMark(endMark) : now()
			startTime = start
			duration = end - start
		}
		const m = new PerformanceMeasure(name, startTime, duration, detail)
		entries.push(m)
		dispatchEntry(m)
		return m
	},

	clearMarks(name) {
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].entryType === 'mark' && (name === undefined || entries[i].name === name)) {
				entries.splice(i, 1)
			}
		}
	},

	clearMeasures(name) {
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].entryType === 'measure' && (name === undefined || entries[i].name === name)) {
				entries.splice(i, 1)
			}
		}
	},

	getEntries() {
		return entries.slice()
	},

	getEntriesByName(name, type) {
		return entries.filter(e => e.name === name && (type === undefined || e.entryType === type))
	},

	getEntriesByType(type) {
		return entries.filter(e => e.entryType === type)
	},

	eventLoopUtilization,

	toJSON() {
		return { timeOrigin: this.timeOrigin, nodeTiming: {} }
	},
}

// PerformanceObserver: dispatches mark/measure entries created after observe().
// Other entry types (gc, function, etc.) are not produced by qn, so the observer
// will simply never fire for them.
class PerformanceObserver {
	constructor(callback) {
		this._callback = callback
		this._types = new Set()
		this._buffer = []
	}
	observe(options = {}) {
		const types = options.entryTypes ?? (options.type ? [options.type] : [])
		this._types = new Set(types)
		observers.add(this)
		// Note: `buffered: true` is a no-op — Node only replays entries from
		// its global performance buffer (resource timing etc.), not user marks.
	}
	disconnect() {
		observers.delete(this)
		this._buffer = []
	}
	takeRecords() {
		const r = this._buffer
		this._buffer = []
		return r
	}
}
PerformanceObserver.supportedEntryTypes = ['mark', 'measure']

const INITIAL_MIN = 9223372036854775807
const EMPTY_PERCENTILE_VALUE = 511
const BUCKETS_PER_POWER = 16
const MAX_SAFE_NS = Number.MAX_SAFE_INTEGER

const nsBigIntToNumber = (ns) => {
	if (ns <= 0n) return 0
	const max = BigInt(MAX_SAFE_NS)
	return Number(ns > max ? max : ns)
}

const bucketIndexFor = (ns) => {
	if (ns <= 0) return 0
	const exponent = Math.floor(Math.log2(ns))
	const base = 2 ** exponent
	const step = Math.max(1, Math.floor(base / BUCKETS_PER_POWER))
	const slot = Math.min(BUCKETS_PER_POWER - 1, Math.floor((ns - base) / step))
	return exponent * BUCKETS_PER_POWER + slot + 1
}

const bucketUpperBound = (index) => {
	if (index <= 0) return 0
	const adjusted = index - 1
	const exponent = Math.floor(adjusted / BUCKETS_PER_POWER)
	const slot = adjusted % BUCKETS_PER_POWER
	const base = 2 ** exponent
	const step = Math.max(1, Math.floor(base / BUCKETS_PER_POWER))
	return Math.min(MAX_SAFE_NS, base + (slot + 1) * step - 1)
}

// monitorEventLoopDelay samples a repeating, unref'd timer. Samples are stored
// in nanoseconds, matching Node's Histogram API. Streaming mean/stddev keep
// summary stats exact while logarithmic buckets bound memory for percentiles.
class EventLoopDelayHistogram {
	#resolutionMs
	#resolutionNs
	#enabled = false
	#timer = null
	#lastNs = 0n
	#count = 0
	#min = INITIAL_MIN
	#max = 0
	#mean = 0
	#m2 = 0
	#exceeds = 0
	#buckets = new Map()

	constructor(options = {}) {
		const resolution = options?.resolution ?? 10
		if (!Number.isFinite(resolution) || resolution <= 0) {
			throw new RangeError('The value of "options.resolution" is out of range. It must be a positive number.')
		}
		this.#resolutionMs = Math.max(1, Math.trunc(resolution))
		this.#resolutionNs = BigInt(this.#resolutionMs) * 1_000_000n
	}

	get min() { return this.#count === 0 ? INITIAL_MIN : this.#min }
	get max() { return this.#max }
	get mean() { return this.#count === 0 ? NaN : this.#mean }
	get stddev() { return this.#count === 0 ? NaN : Math.sqrt(this.#m2 / this.#count) }
	get exceeds() { return this.#exceeds }
	get count() { return this.#count }
	get percentiles() {
		if (this.#count === 0) return new Map([[100, 0]])
		return new Map([
			[0, this.#min],
			[50, this.percentile(50)],
			[75, this.percentile(75)],
			[87.5, this.percentile(87.5)],
			[100, this.#max],
		])
	}

	enable() {
		if (this.#enabled) return false
		this.#enabled = true
		this.#lastNs = _hrtimeBigInt()
		this.#schedule()
		return true
	}

	disable() {
		if (!this.#enabled) return false
		this.#enabled = false
		if (this.#timer !== null) {
			_clearTimeout(this.#timer)
			this.#timer = null
		}
		return true
	}

	reset() {
		this.#count = 0
		this.#min = INITIAL_MIN
		this.#max = 0
		this.#mean = 0
		this.#m2 = 0
		this.#exceeds = 0
		this.#buckets.clear()
		if (this.#enabled) this.#lastNs = _hrtimeBigInt()
	}

	percentile(percentile) {
		if (!(percentile > 0 && percentile <= 100)) {
			throw new RangeError(`The value of "percentile" is out of range. It must be > 0 && <= 100. Received ${percentile}`)
		}
		if (this.#count === 0) return EMPTY_PERCENTILE_VALUE
		if (percentile === 100) return this.#max

		const target = Math.max(1, Math.ceil(this.#count * percentile / 100))
		let seen = 0
		for (const index of [...this.#buckets.keys()].sort((a, b) => a - b)) {
			seen += this.#buckets.get(index)
			if (seen >= target) return bucketUpperBound(index)
		}
		return this.#max
	}

	toJSON() {
		return {
			count: this.count,
			min: this.min,
			max: this.max,
			mean: this.mean,
			exceeds: this.exceeds,
			stddev: this.stddev,
			percentiles: Object.fromEntries(this.percentiles),
		}
	}

	#schedule() {
		this.#timer = _setTimeout(() => this.#sample(), this.#resolutionMs)
		_timerUnref(this.#timer)
	}

	#sample() {
		if (!this.#enabled) return
		const currentNs = _hrtimeBigInt()
		let sampleNs = currentNs - this.#lastNs
		if (sampleNs < this.#resolutionNs) sampleNs = this.#resolutionNs
		this.#lastNs = currentNs
		this.#record(nsBigIntToNumber(sampleNs))
		this.#schedule()
	}

	#record(ns) {
		this.#count++
		if (ns < this.#min) this.#min = ns
		if (ns > this.#max) this.#max = ns
		const delta = ns - this.#mean
		this.#mean += delta / this.#count
		this.#m2 += delta * (ns - this.#mean)

		const index = bucketIndexFor(ns)
		this.#buckets.set(index, (this.#buckets.get(index) ?? 0) + 1)
	}
}

const monitorEventLoopDelay = (options) => new EventLoopDelayHistogram(options)

const createHistogram = () => {
	throw new NodeCompatibilityError('perf_hooks.createHistogram is not implemented')
}

const constants = {
	NODE_PERFORMANCE_GC_MAJOR: 4,
	NODE_PERFORMANCE_GC_MINOR: 1,
	NODE_PERFORMANCE_GC_INCREMENTAL: 8,
	NODE_PERFORMANCE_GC_WEAKCB: 16,
}

export {
	performance,
	PerformanceObserver,
	PerformanceEntry,
	PerformanceMark,
	PerformanceMeasure,
	monitorEventLoopDelay,
	createHistogram,
	constants,
}

export default {
	performance,
	PerformanceObserver,
	PerformanceEntry,
	PerformanceMark,
	PerformanceMeasure,
	monitorEventLoopDelay,
	createHistogram,
	constants,
}
