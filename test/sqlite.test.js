import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, $ } from './util.js'

describe('node:sqlite DatabaseSync', () => {
	test('opens in-memory database', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			console.log(JSON.stringify({ isOpen: db.isOpen }))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isOpen: true })
	})

	test('exec creates table', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
			db.exec("INSERT INTO test (name) VALUES ('hello')")
			const stmt = db.prepare('SELECT COUNT(*) as count FROM test')
			const row = stmt.get()
			console.log(JSON.stringify(row))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 1 })
	})

	test('prepare and run with parameters', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)')
			const insert = db.prepare('INSERT INTO users (name, age) VALUES (?, ?)')
			const result = insert.run('Alice', 30)
			console.log(JSON.stringify({
				changes: result.changes,
				hasRowid: typeof result.lastInsertRowid === 'number'
			}))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { changes: 1, hasRowid: true })
	})

	test('get returns single row', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
			db.exec("INSERT INTO users (name) VALUES ('Alice'), ('Bob')")
			const stmt = db.prepare('SELECT * FROM users WHERE id = ?')
			const row = stmt.get(1)
			console.log(JSON.stringify(row))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { id: 1, name: 'Alice' })
	})

	test('get returns undefined for no match', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
			const stmt = db.prepare('SELECT * FROM users WHERE id = ?')
			const row = stmt.get(999)
			console.log(row === undefined ? 'undefined' : 'not undefined')
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'undefined')
	})

	test('all returns array of rows', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
			db.exec("INSERT INTO users (name) VALUES ('Alice'), ('Bob'), ('Charlie')")
			const stmt = db.prepare('SELECT * FROM users ORDER BY id')
			const rows = stmt.all()
			console.log(JSON.stringify(rows))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), [
			{ id: 1, name: 'Alice' },
			{ id: 2, name: 'Bob' },
			{ id: 3, name: 'Charlie' }
		])
	})

	test('all returns empty array for no matches', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
			const stmt = db.prepare('SELECT * FROM users')
			const rows = stmt.all()
			console.log(JSON.stringify(rows))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), [])
	})

	test('handles null values', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)')
			const insert = db.prepare('INSERT INTO test (value) VALUES (?)')
			insert.run(null)
			const stmt = db.prepare('SELECT * FROM test WHERE id = 1')
			const row = stmt.get()
			console.log(JSON.stringify(row))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { id: 1, value: null })
	})

	test('handles numeric types', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE test (i INTEGER, f REAL)')
			const insert = db.prepare('INSERT INTO test (i, f) VALUES (?, ?)')
			insert.run(42, 3.14)
			const stmt = db.prepare('SELECT * FROM test')
			const row = stmt.get()
			console.log(JSON.stringify(row))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { i: 42, f: 3.14 })
	})

	test('reuses prepared statements', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)')
			const insert = db.prepare('INSERT INTO test (value) VALUES (?)')
			insert.run('first')
			insert.run('second')
			insert.run('third')
			const stmt = db.prepare('SELECT COUNT(*) as count FROM test')
			const row = stmt.get()
			console.log(JSON.stringify(row))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 3 })
	})

	test('file-based database', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const dbPath = '${dir}/test.db'

			// Create and populate
			const db1 = new DatabaseSync(dbPath)
			db1.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)')
			db1.exec("INSERT INTO test (value) VALUES ('persisted')")
			db1.close()

			// Reopen and read
			const db2 = new DatabaseSync(dbPath)
			const stmt = db2.prepare('SELECT * FROM test')
			const row = stmt.get()
			console.log(JSON.stringify(row))
			db2.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { id: 1, value: 'persisted' })
	})

	test('open option delays opening', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:', { open: false })
			console.log(JSON.stringify({ isOpenBefore: db.isOpen }))
			db.open()
			console.log(JSON.stringify({ isOpenAfter: db.isOpen }))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		const lines = output.split('\n')
		assert.deepStrictEqual(JSON.parse(lines[0]), { isOpenBefore: false })
		assert.deepStrictEqual(JSON.parse(lines[1]), { isOpenAfter: true })
	})

	test('throws on SQL error', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			try {
				db.exec('INVALID SQL')
				console.log('no error')
			} catch (e) {
				console.log('error thrown')
			}
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'error thrown')
	})

	test('readOnly option blocks writes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:', { readOnly: true })
			try {
				db.exec('CREATE TABLE x(y INTEGER)')
				console.log('no error')
			} catch (e) {
				console.log('error thrown')
			}
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'error thrown')
	})

	test('readOnly on existing file blocks writes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const dbPath = '${dir}/ro.db'
			const seed = new DatabaseSync(dbPath)
			seed.exec('CREATE TABLE x(y INTEGER); INSERT INTO x VALUES (1)')
			seed.close()
			const db = new DatabaseSync(dbPath, { readOnly: true })
			const row = db.prepare('SELECT y FROM x').get()
			let blocked = false
			try { db.exec('INSERT INTO x VALUES (2)') }
			catch (e) { blocked = true }
			console.log(JSON.stringify({ row, blocked }))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { row: { y: 1 }, blocked: true })
	})

	test('readOnly on nonexistent file fails to open', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			try {
				new DatabaseSync('${dir}/does-not-exist.db', { readOnly: true })
				console.log('opened')
			} catch (e) {
				console.log('failed')
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'failed')
	})

	test('file: URI with mode=ro is enforced', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const dbPath = '${dir}/uri.db'
			const seed = new DatabaseSync(dbPath)
			seed.exec('CREATE TABLE x(y INTEGER); INSERT INTO x VALUES (42)')
			seed.close()
			const db = new DatabaseSync('file:' + dbPath + '?mode=ro')
			const row = db.prepare('SELECT y FROM x').get()
			let blocked = false
			try { db.exec('INSERT INTO x VALUES (99)') }
			catch (e) { blocked = true }
			console.log(JSON.stringify({ row, blocked }))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { row: { y: 42 }, blocked: true })
	})

	test('file: URI with immutable=1 reads', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const dbPath = '${dir}/immut.db'
			const seed = new DatabaseSync(dbPath)
			seed.exec('CREATE TABLE x(y INTEGER); INSERT INTO x VALUES (7)')
			seed.close()
			const db = new DatabaseSync('file:' + dbPath + '?immutable=1')
			console.log(JSON.stringify(db.prepare('SELECT y FROM x').get()))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { y: 7 })
	})

	test('WAL checkpoint succeeds after get/run (statements reset)', ({ bin, dir }) => {
		// Regression: if run()/get() leave the statement active after step(),
		// they hold a WAL read mark / open transaction. wal_checkpoint(TRUNCATE)
		// then returns busy=1 and the WAL never drains. See node/node/sqlite/index.js.
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync('${dir}/wal.db')
			db.exec('PRAGMA journal_mode=WAL')
			db.exec('CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT)')
			const ins = db.prepare('INSERT OR REPLACE INTO t (k, v) VALUES (?, ?)')
			const sel = db.prepare('SELECT v FROM t WHERE k = ?')
			for (let i = 0; i < 50; i++) {
				ins.run(i, 'x'.repeat(100))
				sel.get(i)
			}
			const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
			console.log(JSON.stringify(r))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		const r = JSON.parse(output)
		assert.strictEqual(r.busy, 0, 'wal_checkpoint busy must be 0 (no pinned reader/writer)')
	})

	test('throws on closed database', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.close()
			try {
				db.exec('SELECT 1')
				console.log('no error')
			} catch (e) {
				console.log('error thrown')
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'error thrown')
	})
})
