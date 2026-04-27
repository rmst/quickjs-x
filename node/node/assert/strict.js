/*
 * node:assert/strict — strict-mode variant of node:assert.
 *
 * Identical to node:assert in qn because qn already aliases the loose
 * comparators (equal/notEqual/deepEqual) to their strict counterparts.
 * In Node.js, importing this module is what guarantees that behavior;
 * here it is the default, so this is a thin re-export.
 */
export * from '../assert.js'
export { default } from '../assert.js'
