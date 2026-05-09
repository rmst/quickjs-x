// Test that node-globals are available in workers
self.onmessage = async (event) => {
	const results = {}

	// setTimeout
	results.hasSetTimeout = typeof setTimeout === 'function'
	results.hasClearTimeout = typeof clearTimeout === 'function'
	results.hasSetInterval = typeof setInterval === 'function'

	// Buffer
	results.hasBuffer = typeof Buffer === 'function'
	results.bufferWorks = Buffer.from('hello').toString('hex') === '68656c6c6f'

	// URL
	results.hasURL = typeof URL === 'function'
	results.urlWorks = new URL('https://example.com/path').pathname === '/path'

	// TextEncoder/TextDecoder
	results.hasTextEncoder = typeof TextEncoder === 'function'
	results.hasTextDecoder = typeof TextDecoder === 'function'
	results.textEncoderWorks = new TextEncoder().encode('hi').length === 2

	// performance.now
	results.hasPerformanceNow = typeof performance?.now === 'function'
	results.performanceWorks = performance.now() > 0

	// process
	results.hasProcess = typeof process === 'object'
	results.hasPid = typeof process?.pid === 'number'

	// console
	results.hasConsoleError = typeof console?.error === 'function'

	// Web Crypto
	results.hasCrypto = typeof globalThis.crypto === 'object'
	results.hasGetRandomValues = typeof globalThis.crypto?.getRandomValues === 'function'
	results.hasSubtleDigest = typeof globalThis.crypto?.subtle?.digest === 'function'
	const u = new Uint8Array(8)
	globalThis.crypto.getRandomValues(u)
	results.getRandomValuesWorks = u.some(b => b !== 0)
	const buf = await globalThis.crypto.subtle.digest('SHA-256',
		new TextEncoder().encode('hello world'))
	const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
	results.subtleDigestWorks =
		hex === 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'

	self.postMessage(results)
}
