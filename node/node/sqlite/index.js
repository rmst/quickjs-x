/*
 * node:sqlite - Node.js compatible SQLite module
 *
 * Implements a subset of the Node.js node:sqlite API.
 * https://nodejs.org/api/sqlite.html
 */

import { sqlite_db } from './sqlite_native.so';

// SQLite open flags (stable values from sqlite3.h)
const SQLITE_OPEN_READONLY = 0x01;
const SQLITE_OPEN_READWRITE = 0x02;
const SQLITE_OPEN_CREATE = 0x04;
const SQLITE_OPEN_URI = 0x40;

export class DatabaseSync {
    #db;
    #isOpen = false;
    #path;
    #flags;

    constructor(path, options = {}) {
        this.#path = path;
        this.#flags = options.readOnly
            ? SQLITE_OPEN_READONLY | SQLITE_OPEN_URI
            : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI;
        const shouldOpen = options.open !== false;

        if (shouldOpen) {
            this.open();
        }
    }

    open() {
        if (this.#isOpen) {
            throw new Error('Database is already open');
        }
        this.#db = new sqlite_db(this.#path, this.#flags);
        this.#isOpen = true;
    }

    close() {
        if (!this.#isOpen) {
            throw new Error('Database is not open');
        }
        this.#db.close();
        this.#isOpen = false;
    }

    exec(sql) {
        if (!this.#isOpen) {
            throw new Error('Database is not open');
        }
        this.#db.exec(sql);
    }

    prepare(sql) {
        if (!this.#isOpen) {
            throw new Error('Database is not open');
        }
        const stmt = this.#db.prepare(sql);
        return new StatementSync(stmt, this.#db);
    }

    get isOpen() {
        return this.#isOpen;
    }
}

export class StatementSync {
    #stmt;
    #db;
    #columnNames = null;
    #readBigInts = false;

    constructor(stmt, db) {
        this.#stmt = stmt;
        this.#db = db;
    }

    setReadBigInts(enabled) {
        this.#readBigInts = !!enabled;
    }

    #bindParams(params) {
        for (let i = 0; i < params.length; i++) {
            this.#stmt.bind(i + 1, params[i]);
        }
    }

    #getColumnNames() {
        if (this.#columnNames === null) {
            const count = this.#stmt.column_count();
            this.#columnNames = [];
            for (let i = 0; i < count; i++) {
                this.#columnNames.push(this.#stmt.column_name(i));
            }
        }
        return this.#columnNames;
    }

    #readRow() {
        const names = this.#getColumnNames();
        const row = {};
        for (let i = 0; i < names.length; i++) {
            let value = this.#stmt.column_value(i);
            // Convert ArrayBuffer to Uint8Array for BLOB columns (Node.js compatibility)
            if (value instanceof ArrayBuffer) {
                value = new Uint8Array(value);
            } else if (this.#readBigInts && typeof value === 'number' && Number.isInteger(value)) {
                value = BigInt(value);
            }
            row[names[i]] = value;
        }
        return row;
    }

    run(...params) {
        this.#stmt.reset();
        this.#bindParams(params);
        try {
            this.#stmt.step();
            return {
                changes: this.#db.changes(),
                lastInsertRowid: this.#db.last_insert_rowid()
            };
        } finally {
            // Reset to end the implicit autocommit transaction and release any
            // WAL read mark. Without this, the statement stays "active" between
            // calls — pinning a WAL frame and blocking checkpoint progress.
            this.#stmt.reset();
        }
    }

    get(...params) {
        this.#stmt.reset();
        this.#bindParams(params);
        try {
            const result = this.#stmt.step();
            if (result === 'row') {
                return this.#readRow();
            }
            return undefined;
        } finally {
            this.#stmt.reset();
        }
    }

    all(...params) {
        this.#stmt.reset();
        this.#bindParams(params);
        try {
            const rows = [];
            while (this.#stmt.step() === 'row') {
                rows.push(this.#readRow());
            }
            return rows;
        } finally {
            this.#stmt.reset();
        }
    }

    get sourceSQL() {
        return this.#stmt.sourceSQL;
    }
}

export default { DatabaseSync, StatementSync }
