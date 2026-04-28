/**
 * Shared error classes for Node.js compatibility.
 */
export class NodeCompatibilityError extends Error {
	constructor(message) {
		super(message)
		this.name = 'NodeCompatibilityError'
	}
}

export default { NodeCompatibilityError }
