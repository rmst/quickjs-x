/**
 * qn:git — minimal git client for fetching trees at a commit and verifying hashes.
 *
 * Supports:
 *   - Local repos (read .git/ directly: refs, loose objects, packfiles)
 *   - Remote repos via smart HTTP v1 (https://, fetched into in-memory pack)
 *
 * SHA-1 only. No push, no merge, no working-tree mutation tracking.
 *
 * Public API:
 *   - openLocal(gitDir) -> Repo
 *   - resolve(repo, ref) -> sha   (literal pointee — does not peel tags)
 *   - readObject(repo, sha) -> { type, content }   (verifies hash)
 *   - readTree(repo, sha) -> [{ mode, name, sha }]
 *   - readCommit(repo, sha) -> { tree, parents, ... }   (peels through tag objects)
 *   - peel(repo, sha) -> { sha, type, content }   (follows tag → ... → non-tag)
 *   - checkout(repo, treeSha, destDir) -> number (files written)
 *   - fetchTree({ source, ref, dest }) -> { commit, tree, files }
 *
 * Tag handling: an annotated tag is a tag *object* whose SHA is not the underlying
 * commit's SHA. `readCommit` and `fetchTree` peel through tag objects transparently;
 * each hop is hash-verified by readObject and the tag's `type` header is checked
 * against the target's actual type, keeping the merkle chain intact.
 *
 * The remote path lives in this same module further down (see fetchRemote).
 */

import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import * as Z from 'qn_zlib'
import {
	readFileSync, existsSync, readdirSync, mkdirSync,
	writeFileSync, statSync, symlinkSync, chmodSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { Buffer } from 'node:buffer'

/* ============================================================
 * Object identity
 * ============================================================ */

/** sha-1 of "<type> <size>\0<content>" — git's canonical object id. */
function objectHash(type, content) {
	const h = createHash('sha1')
	h.update(`${type} ${content.length}\0`)
	h.update(content)
	return h.digest('hex')
}

/* ============================================================
 * Object content parsers
 * ============================================================ */

/** Parse a tree object body into entries. */
export function parseTreeBody(buf) {
	const entries = []
	let i = 0
	while (i < buf.length) {
		const sp = buf.indexOf(0x20, i)
		const mode = buf.subarray(i, sp).toString('ascii')
		const nul = buf.indexOf(0x00, sp + 1)
		const name = buf.subarray(sp + 1, nul).toString('utf8')
		const sha = buf.subarray(nul + 1, nul + 21).toString('hex')
		entries.push({ mode, name, sha })
		i = nul + 21
	}
	return entries
}

/**
 * Parse a tag object body. Annotated tags have the shape:
 *   object <sha>
 *   type <commit|tree|blob|tag>
 *   tag <name>
 *   tagger <ident>
 *   <blank>
 *   <message>
 */
export function parseTagBody(buf) {
	const text = buf.toString('utf8')
	const split = text.indexOf('\n\n')
	const headerBlock = split >= 0 ? text.slice(0, split) : text
	const message = split >= 0 ? text.slice(split + 2) : ''
	const out = { message }
	for (const line of headerBlock.split('\n')) {
		if (line.startsWith('object ')) out.object = line.slice(7).trim()
		else if (line.startsWith('type ')) out.type = line.slice(5).trim()
		else if (line.startsWith('tag ')) out.tag = line.slice(4).trim()
		else if (line.startsWith('tagger ')) out.tagger = line.slice(7)
	}
	return out
}

/** Parse a commit object body — we only need tree + parents for our use. */
export function parseCommitBody(buf) {
	const text = buf.toString('utf8')
	const split = text.indexOf('\n\n')
	const headerBlock = split >= 0 ? text.slice(0, split) : text
	const message = split >= 0 ? text.slice(split + 2) : ''
	const out = { parents: [], message }
	for (const line of headerBlock.split('\n')) {
		if (line.startsWith('tree ')) out.tree = line.slice(5).trim()
		else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim())
		else if (line.startsWith('author ')) out.author = line.slice(7)
		else if (line.startsWith('committer ')) out.committer = line.slice(10)
	}
	return out
}

/* ============================================================
 * Loose objects
 * ============================================================ */

function readLoose(gitDir, sha) {
	const path = join(gitDir, 'objects', sha.slice(0, 2), sha.slice(2))
	if (!existsSync(path)) return null
	const raw = inflateSync(readFileSync(path))
	let i = 0
	while (i < raw.length && raw[i] !== 0x20) i++
	const type = raw.subarray(0, i).toString('ascii')
	let j = i + 1
	while (j < raw.length && raw[j] !== 0x00) j++
	const size = parseInt(raw.subarray(i + 1, j).toString('ascii'), 10)
	const content = Buffer.from(raw.subarray(j + 1))
	if (content.length !== size) {
		throw new Error(`loose ${sha}: size mismatch (header ${size}, got ${content.length})`)
	}
	const got = objectHash(type, content)
	if (got !== sha) throw new Error(`loose ${sha}: hash mismatch (got ${got})`)
	return { type, content }
}

/* ============================================================
 * Pack index v2
 * ============================================================ */

class PackIndex {
	constructor(buf) {
		if (buf.length < 8 + 256 * 4) throw new Error('idx: too short')
		if (!(buf[0] === 0xff && buf[1] === 0x74 && buf[2] === 0x4f && buf[3] === 0x63)) {
			throw new Error('idx: only v2 supported (no magic)')
		}
		const ver = buf.readUInt32BE(4)
		if (ver !== 2) throw new Error(`idx: only v2 supported (got v${ver})`)
		this.buf = buf
		this.fanout = new Uint32Array(256)
		for (let i = 0; i < 256; i++) this.fanout[i] = buf.readUInt32BE(8 + i * 4)
		const total = this.fanout[255]
		this.total = total
		this.shasOff = 8 + 256 * 4
		this.crcsOff = this.shasOff + 20 * total
		this.offs32Off = this.crcsOff + 4 * total
		this.offs64Off = this.offs32Off + 4 * total
		// trailer = pack-sha (20) + idx-sha (20) at the very end
	}

	/** Look up a sha (hex) → byte offset into the .pack, or -1 if not found. */
	find(sha) {
		const first = parseInt(sha.slice(0, 2), 16)
		const lo = first === 0 ? 0 : this.fanout[first - 1]
		const hi = this.fanout[first]
		const target = Buffer.from(sha, 'hex')
		let l = lo, r = hi - 1
		while (l <= r) {
			const m = (l + r) >> 1
			const cmp = this.buf.compare(target, 0, 20, this.shasOff + m * 20, this.shasOff + m * 20 + 20)
			if (cmp === 0) return this._offsetAt(m)
			else if (cmp < 0) r = m - 1
			else l = m + 1
		}
		return -1
	}

	_offsetAt(idx) {
		const w = this.buf.readUInt32BE(this.offs32Off + idx * 4)
		if ((w & 0x80000000) === 0) return w >>> 0
		const sub = w & 0x7fffffff
		const hi32 = this.buf.readUInt32BE(this.offs64Off + sub * 8)
		const lo32 = this.buf.readUInt32BE(this.offs64Off + sub * 8 + 4)
		// Number is fine up to 2^53, and pack files larger than that don't exist.
		return hi32 * 0x100000000 + lo32
	}

	/** Iterate all sha → offset pairs, in offset order (used to build a sha lookup). */
	*entries() {
		for (let i = 0; i < this.total; i++) {
			const sha = this.buf.subarray(this.shasOff + i * 20, this.shasOff + i * 20 + 20).toString('hex')
			yield { sha, offset: this._offsetAt(i) }
		}
	}
}

/* ============================================================
 * Pack file: object header + zlib body + delta resolution
 * ============================================================ */

const PACK_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs_delta', 7: 'ref_delta' }

/** Read the variable-length type+size header at offset. Returns { type, size, headerLen }. */
function readPackObjectHeader(packBuf, off) {
	let b = packBuf[off]
	const type = (b >> 4) & 0x07
	let size = b & 0x0f
	let shift = 4
	let i = off + 1
	while (b & 0x80) {
		b = packBuf[i++]
		size |= (b & 0x7f) << shift
		shift += 7
	}
	return { type, size, headerLen: i - off }
}

/** Variable-length offset for ofs_delta, after the type/size header. */
function readOfsDeltaOffset(packBuf, off) {
	let b = packBuf[off]
	let val = b & 0x7f
	let i = off + 1
	while (b & 0x80) {
		val += 1
		b = packBuf[i++]
		val = (val << 7) | (b & 0x7f)
	}
	return { value: val, len: i - off }
}

/** Inflate a zlib-wrapped stream starting at offset, returning {output, consumed}. */
function inflateAtOffset(packBuf, off) {
	const stream = Z.inflateInit(15)  // zlib wrapper
	try {
		// Slice from off to end and let miniz consume only what it needs.
		const slice = packBuf.subarray(off)
		const r = Z.process(stream, slice, Z.Z_FINISH)
		if (!r.done) throw new Error('pack: inflate did not complete')
		return { output: Buffer.from(r.output), consumed: r.consumed }
	} finally {
		Z.end(stream)
	}
}

/** Apply a git delta to a base buffer, returning the result buffer. */
function applyDelta(base, delta) {
	let i = 0
	const readVarSize = () => {
		let b = delta[i++]
		let v = b & 0x7f
		let shift = 7
		while (b & 0x80) {
			b = delta[i++]
			v |= (b & 0x7f) << shift
			shift += 7
		}
		return v
	}
	const baseSize = readVarSize()
	const resultSize = readVarSize()
	if (base.length !== baseSize) throw new Error(`delta: base size mismatch (${base.length} vs ${baseSize})`)
	const out = Buffer.alloc(resultSize)
	let outPos = 0
	while (i < delta.length) {
		const op = delta[i++]
		if (op & 0x80) {
			// copy from base
			let copyOff = 0, copySize = 0
			if (op & 0x01) copyOff |= delta[i++]
			if (op & 0x02) copyOff |= delta[i++] << 8
			if (op & 0x04) copyOff |= delta[i++] << 16
			if (op & 0x08) copyOff |= delta[i++] << 24
			if (op & 0x10) copySize |= delta[i++]
			if (op & 0x20) copySize |= delta[i++] << 8
			if (op & 0x40) copySize |= delta[i++] << 16
			if (copySize === 0) copySize = 0x10000
			copyOff = copyOff >>> 0
			base.copy(out, outPos, copyOff, copyOff + copySize)
			outPos += copySize
		} else if (op !== 0) {
			// insert: next `op` bytes go directly into output
			delta.copy(out, outPos, i, i + op)
			outPos += op
			i += op
		} else {
			throw new Error('delta: reserved opcode 0x00')
		}
	}
	if (outPos !== resultSize) throw new Error(`delta: result size mismatch (${outPos} vs ${resultSize})`)
	return out
}

/**
 * Read an object from a pack at a given offset, resolving deltas recursively.
 * Returns { type, content }. Verifies output length but not sha (caller knows expected sha).
 */
function readPackObject(packBuf, off, idx) {
	const hdr = readPackObjectHeader(packBuf, off)
	const typeName = PACK_TYPE[hdr.type]
	if (!typeName) throw new Error(`pack: unknown type ${hdr.type} at offset ${off}`)

	if (typeName === 'ofs_delta') {
		const o = readOfsDeltaOffset(packBuf, off + hdr.headerLen)
		const baseOff = off - o.value
		const inf = inflateAtOffset(packBuf, off + hdr.headerLen + o.len)
		const base = readPackObject(packBuf, baseOff, idx)
		return { type: base.type, content: applyDelta(base.content, inf.output) }
	}
	if (typeName === 'ref_delta') {
		const baseSha = packBuf.subarray(off + hdr.headerLen, off + hdr.headerLen + 20).toString('hex')
		const inf = inflateAtOffset(packBuf, off + hdr.headerLen + 20)
		const baseOff = idx ? idx.find(baseSha) : -1
		if (baseOff < 0) throw new Error(`ref_delta: base ${baseSha} not in pack`)
		const base = readPackObject(packBuf, baseOff, idx)
		return { type: base.type, content: applyDelta(base.content, inf.output) }
	}
	const inf = inflateAtOffset(packBuf, off + hdr.headerLen)
	if (inf.output.length !== hdr.size) {
		throw new Error(`pack: size mismatch at off ${off} (${inf.output.length} vs ${hdr.size})`)
	}
	return { type: typeName, content: inf.output }
}

/** Verify the trailing 20-byte sha-1 over the pack body. */
function verifyPackChecksum(packBuf) {
	if (packBuf.length < 32) throw new Error('pack: too short')
	const body = packBuf.subarray(0, packBuf.length - 20)
	const trailer = packBuf.subarray(packBuf.length - 20).toString('hex')
	const got = createHash('sha1').update(body).digest('hex')
	if (got !== trailer) throw new Error(`pack: checksum mismatch (got ${got}, expected ${trailer})`)
}

/* ============================================================
 * Local repo
 * ============================================================ */

/** Read all packs in a repo, return [{ idx, packBuf }]. */
function loadPacks(gitDir) {
	const dir = join(gitDir, 'objects', 'pack')
	if (!existsSync(dir)) return []
	const out = []
	for (const f of readdirSync(dir)) {
		if (!f.endsWith('.idx')) continue
		const base = f.slice(0, -4)
		const idxBuf = readFileSync(join(dir, f))
		const packPath = join(dir, base + '.pack')
		if (!existsSync(packPath)) continue
		const packBuf = readFileSync(packPath)
		// Header sanity
		if (packBuf.subarray(0, 4).toString('ascii') !== 'PACK') {
			throw new Error(`pack: bad magic in ${packPath}`)
		}
		out.push({ idx: new PackIndex(idxBuf), packBuf })
	}
	return out
}

/** Read all refs (HEAD, refs/, packed-refs) into a Map<refname, sha>. */
function loadRefs(gitDir) {
	const refs = new Map()
	const packedPath = join(gitDir, 'packed-refs')
	if (existsSync(packedPath)) {
		for (const line of readFileSync(packedPath, 'utf8').split('\n')) {
			if (!line || line.startsWith('#') || line.startsWith('^')) continue
			const sp = line.indexOf(' ')
			if (sp < 0) continue
			refs.set(line.slice(sp + 1).trim(), line.slice(0, sp).trim())
		}
	}
	const refsDir = join(gitDir, 'refs')
	if (existsSync(refsDir)) {
		const walk = (d, prefix) => {
			for (const f of readdirSync(d)) {
				const p = join(d, f)
				const st = statSync(p)
				if (st.isDirectory()) walk(p, prefix + f + '/')
				else refs.set(prefix + f, readFileSync(p, 'utf8').trim())
			}
		}
		walk(refsDir, 'refs/')
	}
	const headPath = join(gitDir, 'HEAD')
	if (existsSync(headPath)) {
		const head = readFileSync(headPath, 'utf8').trim()
		if (head.startsWith('ref: ')) {
			const target = head.slice(5).trim()
			const sha = refs.get(target)
			if (sha) refs.set('HEAD', sha)
		} else {
			refs.set('HEAD', head)
		}
	}
	return refs
}

/** Open a local git repo. `gitDir` may point at the .git directory or its parent. */
export function openLocal(gitDir) {
	if (!existsSync(join(gitDir, 'HEAD')) && existsSync(join(gitDir, '.git'))) {
		gitDir = join(gitDir, '.git')
	}
	if (!existsSync(join(gitDir, 'HEAD'))) {
		throw new Error(`not a git dir: ${gitDir}`)
	}
	const packs = loadPacks(gitDir)
	const refs = loadRefs(gitDir)
	return {
		kind: 'local',
		gitDir,
		refs,
		packs,
	}
}

/** Resolve a ref string (sha, branch, tag, "HEAD") to a full sha. */
export function resolve(repo, ref) {
	if (/^[0-9a-f]{40}$/.test(ref)) return ref
	if (repo.refs.has(ref)) return repo.refs.get(ref)
	const candidates = [
		`refs/heads/${ref}`, `refs/tags/${ref}`,
		`refs/remotes/origin/${ref}`, `refs/remotes/${ref}`,
	]
	for (const c of candidates) if (repo.refs.has(c)) return repo.refs.get(c)
	throw new Error(`ref not found: ${ref}`)
}

/** Read object by sha. Verifies hash. Throws if not found. */
export function readObject(repo, sha) {
	if (repo.kind === 'local') {
		const loose = readLoose(repo.gitDir, sha)
		if (loose) return loose
		for (const p of repo.packs) {
			const off = p.idx.find(sha)
			if (off < 0) continue
			const obj = readPackObject(p.packBuf, off, p.idx)
			const got = objectHash(obj.type, obj.content)
			if (got !== sha) throw new Error(`pack ${sha}: hash mismatch (got ${got})`)
			return obj
		}
		throw new Error(`object not found: ${sha}`)
	}
	// remote/in-memory store
	const obj = repo.objects.get(sha)
	if (!obj) throw new Error(`object not found: ${sha}`)
	return obj
}

/**
 * Follow tag objects until a non-tag object is reached. Returns the final
 * { sha, type, content }. Each hop is hash-verified by readObject, and the
 * tag's `type` header is checked against the target's actual object type —
 * this keeps the chain merkle-verified and rejects malformed tags.
 */
export function peel(repo, sha) {
	let curSha = sha
	let cur = readObject(repo, sha)
	const seen = new Set([sha])
	while (cur.type === 'tag') {
		const tag = parseTagBody(cur.content)
		if (!tag.object || !/^[0-9a-f]{40}$/.test(tag.object)) {
			throw new Error(`tag ${curSha}: missing or malformed object header`)
		}
		if (seen.has(tag.object)) throw new Error(`tag ${curSha}: cycle through ${tag.object}`)
		const next = readObject(repo, tag.object)
		if (tag.type && next.type !== tag.type) {
			throw new Error(`tag ${curSha}: type mismatch (header says ${tag.type}, target is ${next.type})`)
		}
		seen.add(tag.object)
		curSha = tag.object
		cur = next
	}
	return { sha: curSha, type: cur.type, content: cur.content }
}

export function readCommit(repo, sha) {
	const o = peel(repo, sha)
	if (o.type !== 'commit') throw new Error(`${sha} is not a commit (${o.type})`)
	return parseCommitBody(o.content)
}

export function readTree(repo, sha) {
	const o = readObject(repo, sha)
	if (o.type !== 'tree') throw new Error(`${sha} is not a tree (${o.type})`)
	return parseTreeBody(o.content)
}

/* ============================================================
 * Checkout: walk a tree and write blobs to disk
 * ============================================================ */

export function checkout(repo, treeSha, destDir) {
	mkdirSync(destDir, { recursive: true })
	let count = 0
	const walk = (sha, dir) => {
		for (const e of readTree(repo, sha)) {
			const p = join(dir, e.name)
			if (e.mode === '40000' || e.mode === '040000') {
				mkdirSync(p, { recursive: true })
				walk(e.sha, p)
			} else if (e.mode === '160000') {
				// gitlink (submodule pointer) — leave an empty dir as a placeholder
				mkdirSync(p, { recursive: true })
			} else if (e.mode === '120000') {
				const blob = readObject(repo, e.sha)
				symlinkSync(blob.content.toString('utf8'), p)
				count++
			} else {
				const blob = readObject(repo, e.sha)
				writeFileSync(p, blob.content)
				if (e.mode === '100755') chmodSync(p, 0o755)
				count++
			}
		}
	}
	walk(treeSha, destDir)
	return count
}

/* ============================================================
 * Top-level convenience: source string → checkout
 * ============================================================ */

/**
 * source: a path to a git working dir (or .git dir), OR a URL (https://…).
 * ref:    sha, branch, tag, or "HEAD"
 * dest:   directory to write the tree into
 *
 * returns { commit, tree, files }
 */
export async function fetchTree({ source, ref, dest }) {
	let repo
	if (/^https?:\/\//.test(source)) {
		repo = await fetchRemote(source, ref)
	} else {
		repo = openLocal(source)
	}
	const resolved = resolve(repo, ref)
	const peeled = peel(repo, resolved)
	if (peeled.type !== 'commit') {
		throw new Error(`${ref} resolves to a ${peeled.type}, not a commit`)
	}
	const c = parseCommitBody(peeled.content)
	const files = checkout(repo, c.tree, dest)
	return { commit: peeled.sha, tree: c.tree, files }
}

/* ============================================================
 * Pkt-line framing (smart HTTP)
 *
 * 4 hex digits of length (including the 4 length bytes themselves),
 * then the payload. `0000` = flush, `0001` = delim (v2-only).
 * ============================================================ */

function pktEncode(payload) {
	const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
	const total = body.length + 4
	const len = total.toString(16).padStart(4, '0')
	return Buffer.concat([Buffer.from(len, 'ascii'), body])
}
const PKT_FLUSH = Buffer.from('0000', 'ascii')

/** Iterator over pkt-lines in a buffer. Yields { type, data, end } where
 *  type is 'flush' | 'delim' | 'data', end is offset just past this packet. */
function* pktIter(buf, start = 0) {
	let i = start
	while (i + 4 <= buf.length) {
		const lenStr = buf.subarray(i, i + 4).toString('ascii')
		const len = parseInt(lenStr, 16)
		if (Number.isNaN(len)) throw new Error(`pkt-line: bad length "${lenStr}" at ${i}`)
		if (len === 0) { yield { type: 'flush', end: i + 4 }; i += 4; continue }
		if (len === 1) { yield { type: 'delim', end: i + 4 }; i += 4; continue }
		if (len < 4 || i + len > buf.length) throw new Error(`pkt-line: bad length ${len} at ${i}`)
		yield { type: 'data', data: buf.subarray(i + 4, i + len), end: i + len }
		i += len
	}
}

/* ============================================================
 * Smart HTTP fetch
 * ============================================================ */

async function httpGet(url, headers = {}) {
	const r = await fetch(url, { headers })
	if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`)
	return Buffer.from(await r.arrayBuffer())
}

async function httpPost(url, contentType, body, accept) {
	const r = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': contentType, 'Accept': accept },
		body,
	})
	if (!r.ok) throw new Error(`POST ${url}: HTTP ${r.status}`)
	return Buffer.from(await r.arrayBuffer())
}

/** Strip a trailing `.git` and any trailing slash, then return the base URL. */
function repoBaseUrl(url) {
	return url.replace(/\/+$/, '')
}

/** Discover refs via /info/refs?service=git-upload-pack (protocol v1). */
async function discoverRefs(url) {
	const base = repoBaseUrl(url)
	// Force protocol v1 by NOT sending a Git-Protocol header. Some servers default
	// to v2 if the client speaks it; we want the simpler v1 reply shape.
	const buf = await httpGet(`${base}/info/refs?service=git-upload-pack`)
	const refs = new Map()
	let capabilities = []
	let serviceLineSeen = false
	let firstRefSeen = false
	for (const pkt of pktIter(buf)) {
		if (pkt.type === 'flush') continue
		if (pkt.type === 'delim') continue
		const text = pkt.data.toString('utf8').replace(/\n$/, '')
		if (!serviceLineSeen) {
			if (!text.startsWith('# service=')) {
				throw new Error(`info/refs: unexpected first line: ${text}`)
			}
			serviceLineSeen = true
			continue
		}
		// First ref carries capabilities after a NUL.
		const nul = text.indexOf('\0')
		const line = nul >= 0 ? text.slice(0, nul) : text
		if (!firstRefSeen && nul >= 0) capabilities = text.slice(nul + 1).split(' ')
		firstRefSeen = true
		const sp = line.indexOf(' ')
		if (sp < 0) continue
		const sha = line.slice(0, sp)
		const name = line.slice(sp + 1)
		if (name === 'capabilities^{}') continue
		refs.set(name, sha)
	}
	// Synthesize HEAD as a name (server advertises it as `HEAD`).
	return { refs, capabilities }
}

/** Resolve a user-supplied ref against discovered refs. Returns sha. */
function resolveRemoteRef(refs, ref) {
	if (/^[0-9a-f]{40}$/.test(ref)) return ref
	if (refs.has(ref)) return refs.get(ref)
	const candidates = [
		`refs/heads/${ref}`, `refs/tags/${ref}`,
		`refs/tags/${ref}^{}`,  // peeled annotated tag
	]
	for (const c of candidates) if (refs.has(c)) return refs.get(c)
	throw new Error(`remote ref not found: ${ref}`)
}

/** Build the upload-pack request body. */
function buildUploadPackBody(wantSha, caps) {
	// First want carries capabilities; we only need one want.
	const wanted = ['side-band-64k', 'ofs-delta', 'agent=qn-git/0.1']
		.filter((c) => caps.includes(c) || c.startsWith('agent='))
	const lines = []
	lines.push(pktEncode(`want ${wantSha} ${wanted.join(' ')}\n`))
	if (caps.includes('shallow')) lines.push(pktEncode(`deepen 1\n`))
	lines.push(PKT_FLUSH)
	lines.push(pktEncode(`done\n`))
	return Buffer.concat(lines)
}

/** Demultiplex sideband-64k stream and return concatenated band-1 (data) bytes. */
function demuxSideband(buf, start = 0) {
	const dataChunks = []
	let progress = ''
	let errors = ''
	for (const pkt of pktIter(buf, start)) {
		if (pkt.type === 'flush') break  // end of pack stream
		if (pkt.type === 'delim') continue
		if (pkt.data.length === 0) continue
		const band = pkt.data[0]
		const payload = pkt.data.subarray(1)
		if (band === 1) dataChunks.push(payload)
		else if (band === 2) progress += payload.toString('utf8')
		else if (band === 3) errors += payload.toString('utf8')
		else throw new Error(`upload-pack: unknown band ${band}`)
	}
	if (errors) throw new Error(`upload-pack: server error: ${errors.trim()}`)
	return Buffer.concat(dataChunks)
}

/** Fetch a packfile for a single commit (shallow), returning the raw pack bytes. */
async function fetchPack(url, wantSha, caps) {
	const base = repoBaseUrl(url)
	const body = buildUploadPackBody(wantSha, caps)
	const reply = await httpPost(
		`${base}/git-upload-pack`,
		'application/x-git-upload-pack-request',
		body,
		'application/x-git-upload-pack-result',
	)
	// Walk pkt-lines until we exit the ACK/NAK/shallow header section, then
	// hand the rest to the sideband demuxer.
	let i = 0
	let inHeader = true
	for (const pkt of pktIter(reply)) {
		if (pkt.type === 'flush') {
			// Header may or may not end with a flush; in v1 we reach NAK then the
			// pack data follows without a delimiting flush — handled below.
			i = pkt.end
			continue
		}
		if (pkt.type === 'delim') { i = pkt.end; continue }
		const text = pkt.data.toString('utf8').replace(/\n$/, '')
		if (text === 'NAK' || text.startsWith('ACK ') || text.startsWith('shallow ') || text.startsWith('unshallow ')) {
			i = pkt.end
			continue
		}
		// Any other line: this is the start of pack data (band-prefixed).
		inHeader = false
		break
	}
	if (inHeader) throw new Error('upload-pack: no pack data in response')
	return demuxSideband(reply, i)
}

/* ============================================================
 * In-memory pack: scan all objects, build sha→offset index
 * ============================================================ */

class InMemoryIndex {
	constructor(packBuf) {
		this.packBuf = packBuf
		this.byOffset = new Map()  // offset -> sha
		this.bySha = new Map()     // sha -> offset
		this._scan()
	}

	find(sha) {
		const o = this.bySha.get(sha)
		return o === undefined ? -1 : o
	}

	_scan() {
		const buf = this.packBuf
		if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack: bad magic')
		const ver = buf.readUInt32BE(4)
		if (ver !== 2 && ver !== 3) throw new Error(`pack: unsupported version ${ver}`)
		const count = buf.readUInt32BE(8)
		let off = 12
		for (let i = 0; i < count; i++) {
			const objOff = off
			const hdr = readPackObjectHeader(buf, off)
			off += hdr.headerLen
			const typeName = PACK_TYPE[hdr.type]
			if (!typeName) throw new Error(`pack: unknown type ${hdr.type} at ${objOff}`)

			if (typeName === 'ofs_delta') {
				const o = readOfsDeltaOffset(buf, off)
				off += o.len
			} else if (typeName === 'ref_delta') {
				off += 20
			}
			// Inflate body to advance past it; record sha for non-deltas now,
			// for deltas after a follow-up resolution.
			const inf = inflateAtOffset(buf, off)
			off += inf.consumed

			if (typeName === 'commit' || typeName === 'tree' || typeName === 'blob' || typeName === 'tag') {
				const sha = objectHash(typeName, inf.output)
				this.byOffset.set(objOff, sha)
				this.bySha.set(sha, objOff)
			}
		}
		// 20-byte trailer = sha-1 of preceding bytes.
		verifyPackChecksum(buf)
		// Resolve deltas and record their shas. Repeat passes until stable
		// (handles ref_delta forward refs).
		let progress = true
		while (progress) {
			progress = false
			for (const [objOff] of this._iterDeltas()) {
				if (this.byOffset.has(objOff)) continue
				try {
					const obj = readPackObject(this.packBuf, objOff, this)
					const sha = objectHash(obj.type, obj.content)
					this.byOffset.set(objOff, sha)
					this.bySha.set(sha, objOff)
					progress = true
				} catch {
					// base not yet resolved — try next pass
				}
			}
		}
	}

	*_iterDeltas() {
		const buf = this.packBuf
		const count = buf.readUInt32BE(8)
		let off = 12
		for (let i = 0; i < count; i++) {
			const objOff = off
			const hdr = readPackObjectHeader(buf, off)
			off += hdr.headerLen
			const typeName = PACK_TYPE[hdr.type]
			if (typeName === 'ofs_delta') {
				const o = readOfsDeltaOffset(buf, off)
				off += o.len
				yield [objOff]
			} else if (typeName === 'ref_delta') {
				off += 20
				yield [objOff]
			}
			const inf = inflateAtOffset(buf, off)
			off += inf.consumed
		}
	}
}

/* ============================================================
 * Public: fetchRemote
 * ============================================================ */

/**
 * Fetch a (shallow) commit from a remote git server over smart HTTP v1
 * and return an in-memory Repo whose readObject/readTree/readCommit work
 * exactly like the local one.
 */
export async function fetchRemote(url, ref) {
	const { refs, capabilities } = await discoverRefs(url)
	const wantSha = resolveRemoteRef(refs, ref)
	const packBuf = await fetchPack(url, wantSha, capabilities)
	const idx = new InMemoryIndex(packBuf)
	const objects = new Map()
	// Eagerly materialize everything — packs from a shallow fetch are tiny.
	for (const [sha, off] of idx.bySha) {
		const obj = readPackObject(packBuf, off, idx)
		const got = objectHash(obj.type, obj.content)
		if (got !== sha) throw new Error(`remote: hash mismatch (${sha} vs ${got})`)
		objects.set(sha, obj)
	}
	// Synthesize a refs map so resolve() works
	const refMap = new Map(refs)
	refMap.set('HEAD', wantSha)  // best-effort; real HEAD from server above also works
	return {
		kind: 'memory',
		refs: refMap,
		objects,
	}
}
