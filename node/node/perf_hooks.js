import { hrtime as _hrtime } from 'qn_vm'
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

	eventLoopUtilization() {
		// Stub: Node.js returns { idle, active, utilization }. We don't track these.
		return { idle: 0, active: 0, utilization: 0 }
	},

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

// monitorEventLoopDelay: stub Histogram. Real implementation would sample the
// event loop; we return a histogram-shaped object that always reports zeros.
class EventLoopDelayHistogram {
	constructor() {
		this.min = 0
		this.max = 0
		this.mean = 0
		this.stddev = 0
		this.exceeds = 0
	}
	enable() { return true }
	disable() { return true }
	reset() {}
	percentile(_p) { return 0 }
	percentiles() { return new Map() }
}

const monitorEventLoopDelay = (_options) => new EventLoopDelayHistogram()

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
