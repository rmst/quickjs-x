/*
 * node:readline/promises — Promise-based wrapper over node:readline.
 */

import {
	Interface as CallbackInterface,
	cursorTo, moveCursor, clearLine, clearScreenDown,
} from './index.js'

export class Interface extends CallbackInterface {
	question(query, options) {
		const signal = options && options.signal
		return new Promise((resolve, reject) => {
			super.question(query, options, (answer) => {
				if (answer === undefined && signal && signal.aborted) {
					const err = new Error('The operation was aborted')
					err.name = 'AbortError'
					reject(err)
				} else {
					resolve(answer)
				}
			})
		})
	}
}

export function createInterface(options) {
	return new Interface(options)
}

export { cursorTo, moveCursor, clearLine, clearScreenDown }

export default {
	Interface,
	createInterface,
	cursorTo, moveCursor, clearLine, clearScreenDown,
}
