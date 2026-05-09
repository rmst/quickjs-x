import { describe, it } from 'node:test'
import assert from 'node:assert'
import { join, dirname } from 'node:path'

const FIXTURES = join(dirname(import.meta.filename), 'fixtures')

describe('Worker', () => {
	it('basic postMessage/onmessage echo', async () => {
		const w = new Worker(join(FIXTURES, 'echo-worker.js'))
		const result = await new Promise((resolve, reject) => {
			w.onmessage = (event) => resolve(event.data)
			w.onerror = (err) => reject(err)
			w.postMessage('hello')
		})
		assert.equal(result, 'hello')
		w.terminate()
	})

	it('structured clone - objects and arrays', async () => {
		const w = new Worker(join(FIXTURES, 'echo-worker.js'))
		const data = { name: 'test', values: [1, 2, 3], nested: { a: true } }
		const result = await new Promise((resolve, reject) => {
			w.onmessage = (event) => resolve(event.data)
			w.onerror = (err) => reject(err)
			w.postMessage(data)
		})
		assert.deepEqual(result, data)
		w.terminate()
	})

	it('multiple messages in sequence', async () => {
		const w = new Worker(join(FIXTURES, 'echo-worker.js'))
		const received = []
		const done = new Promise((resolve, reject) => {
			w.onmessage = (event) => {
				received.push(event.data)
				if (received.length === 3) resolve()
			}
			w.onerror = (err) => reject(err)
		})
		w.postMessage(1)
		w.postMessage(2)
		w.postMessage(3)
		await done
		assert.deepEqual(received, [1, 2, 3])
		w.terminate()
	})

	it('worker computation', async () => {
		const w = new Worker(join(FIXTURES, 'compute-worker.js'))
		const result = await new Promise((resolve, reject) => {
			w.onmessage = (event) => resolve(event.data)
			w.onerror = (err) => reject(err)
			w.postMessage({ op: 'sum', values: [1, 2, 3, 4, 5] })
		})
		assert.deepEqual(result, { op: 'sum', result: 15 })
		w.terminate()
	})

	it('multiple concurrent workers', async () => {
		const workers = Array.from({ length: 3 }, () =>
			new Worker(join(FIXTURES, 'echo-worker.js'))
		)
		const results = await Promise.all(workers.map((w, i) =>
			new Promise((resolve, reject) => {
				w.onmessage = (event) => resolve(event.data)
				w.onerror = (err) => reject(err)
				w.postMessage(`worker-${i}`)
			})
		))
		assert.deepEqual(results, ['worker-0', 'worker-1', 'worker-2'])
		workers.forEach(w => w.terminate())
	})

	it('terminate stops worker', async () => {
		const w = new Worker(join(FIXTURES, 'echo-worker.js'))
		const result = await new Promise((resolve, reject) => {
			w.onmessage = (event) => resolve(event.data)
			w.onerror = (err) => reject(err)
			w.postMessage('ping')
		})
		assert.equal(result, 'ping')
		w.terminate()
	})

	it('constructor requires string url', () => {
		assert.throws(() => new Worker(123), { name: 'TypeError' })
	})

	it('workers have node globals (setTimeout, Buffer, URL, etc.)', async () => {
		const w = new Worker(join(FIXTURES, 'globals-worker.js'))
		const result = await new Promise((resolve, reject) => {
			w.onmessage = (event) => resolve(event.data)
			w.onerror = (err) => reject(err)
			w.postMessage('go')
		})
		assert.strictEqual(result.hasSetTimeout, true, 'setTimeout available')
		assert.strictEqual(result.hasBuffer, true, 'Buffer available')
		assert.strictEqual(result.bufferWorks, true, 'Buffer.from works')
		assert.strictEqual(result.hasURL, true, 'URL available')
		assert.strictEqual(result.urlWorks, true, 'URL works')
		assert.strictEqual(result.hasTextEncoder, true, 'TextEncoder available')
		assert.strictEqual(result.textEncoderWorks, true, 'TextEncoder works')
		assert.strictEqual(result.hasPerformanceNow, true, 'performance.now available')
		assert.strictEqual(result.hasProcess, true, 'process available')
		assert.strictEqual(result.hasCrypto, true, 'globalThis.crypto available')
		assert.strictEqual(result.hasGetRandomValues, true, 'crypto.getRandomValues available')
		assert.strictEqual(result.hasSubtleDigest, true, 'crypto.subtle.digest available')
		assert.strictEqual(result.getRandomValuesWorks, true, 'crypto.getRandomValues works')
		assert.strictEqual(result.subtleDigestWorks, true, 'crypto.subtle.digest works')
		w.terminate()
	})

	it('workers can import node:* modules', async () => {
		const w = new Worker(join(FIXTURES, 'fs-worker.js'))
		const result = await new Promise((resolve, reject) => {
			w.onmessage = (event) => resolve(event.data)
			w.onerror = (err) => reject(err)
			w.postMessage('go')
		})
		assert.strictEqual(result.ok, true, 'node:fs read succeeded')
		assert.strictEqual(result.hasImport, true, 'read own source with import.meta.filename')
		w.terminate()
	})

	it('workers support TypeScript', async () => {
		const w = new Worker(join(FIXTURES, 'ts-worker.ts'))
		const result = await new Promise((resolve, reject) => {
			w.onmessage = (event) => resolve(event.data)
			w.onerror = (err) => reject(err)
			w.postMessage({ value: 21 })
		})
		assert.strictEqual(result.doubled, 42, 'TypeScript worker computed correctly')
		w.terminate()
	})
})
