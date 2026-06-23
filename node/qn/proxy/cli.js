/**
 * Reverse proxy CLI — config-file-driven proxy server
 *
 * Usage:
 *   qn proxy-cli.js [--config] <path> [--port <port>] [--hostname <addr>]
 *
 * Config file format (one mapping per line):
 *   # comments start with #
 *   hostname backend_url
 *   *.suffix backend_url
 *
 * Example config:
 *   app.local      http://localhost:3000
 *   api.local      http://localhost:4000
 *   *.preview.local http://localhost:5000
 *
 * The config file is polled for changes every 2 seconds.
 *
 * Environment variables:
 *   PROXY_USER  User to drop privileges to after binding (when running as root)
 */

import { createProxy } from 'qn:proxy'
import { readFileSync, statSync } from 'node:fs'
import { getUserInfo } from 'qn_vm'

const args = process.argv.slice(2)
let configPath = null
let port = 80
let hostname = '127.0.0.1'

for (let i = 0; i < args.length; i++) {
	const arg = args[i]
	if (arg === '--config' || arg === '-c') configPath = args[++i]
	else if (arg === '--port' || arg === '-p') port = parseInt(args[++i])
	else if (arg === '--hostname' || arg === '-H') hostname = args[++i]
	else if (arg === '--help') { usage(); process.exit(0) }
	else if (!arg.startsWith('-') && !configPath) configPath = arg
}

if (!configPath) {
	usage()
	process.exit(1)
}

function usage() {
	console.error('Usage: qn proxy-cli.js [--config] <path> [--port <port>] [--hostname <addr>]')
}

let routes = { exact: new Map(), wildcards: [] }

function loadConfig() {
	try {
		const content = readFileSync(configPath, 'utf8')
		const exact = new Map()
		const wildcards = new Map()
		for (const line of content.split('\n')) {
			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith('#')) continue
			const parts = trimmed.split(/\s+/)
			if (parts.length >= 2) {
				const host = normalizeHost(parts[0])
				if (host.startsWith('*.') && host.length > 2) {
					const suffix = host.slice(1)
					wildcards.set(suffix, { host, suffix, target: parts[1] })
				} else {
					exact.set(host, parts[1])
				}
			}
		}
		routes = {
			exact,
			wildcards: [...wildcards.values()].sort((a, b) => b.suffix.length - a.suffix.length),
		}
		const entries = [
			...routes.exact.entries(),
			...routes.wildcards.map(({ host, target }) => [host, target]),
		].map(([h, b]) => `  ${h} -> ${b}`).join('\n')
		console.log(`[proxy] loaded ${entries.length} route(s) from ${configPath}${entries ? '\n' + entries : ''}`)
	} catch (err) {
		console.error(`[proxy] error reading config: ${err.message}`)
	}
}

loadConfig()

const proxy = await createProxy({
	port,
	hostname,
	route: (req) => {
		const host = hostFromHeader(req.headers.host || '')
		return matchRoute(host)
	},
})

const addr = proxy.address()
console.log(`[proxy] listening on ${addr.address}:${addr.port}`)

// Drop privileges after binding
if (process.getuid() === 0) {
	const user = process.env.PROXY_USER
	if (user) {
		const info = getUserInfo(user)
		process.setgroups([])
		process.setgid(info.gid)
		process.setuid(info.uid)
		console.log(`[proxy] dropped privileges to ${info.username} (uid=${info.uid}, gid=${info.gid})`)
	} else {
		console.error('[proxy] WARNING: running as root without PROXY_USER set')
	}
}

// Poll config file for changes
let lastMtime = 0
try { lastMtime = statSync(configPath).mtimeMs } catch {}

setInterval(() => {
	try {
		const mtime = statSync(configPath).mtimeMs
		if (mtime !== lastMtime) {
			lastMtime = mtime
			loadConfig()
		}
	} catch (err) {
		console.error(`[proxy] error watching config: ${err.message}`)
	}
}, 2000)

function matchRoute(host) {
	const exact = routes.exact.get(host)
	if (exact) return exact
	const wildcard = routes.wildcards.find(({ suffix }) => host.length > suffix.length && host.endsWith(suffix))
	return wildcard?.target || null
}

function hostFromHeader(value) {
	const host = String(value).trim()
	if (host.startsWith('[')) {
		const end = host.indexOf(']')
		return normalizeHost(end === -1 ? host : host.slice(1, end))
	}
	const firstColon = host.indexOf(':')
	const lastColon = host.lastIndexOf(':')
	return normalizeHost(firstColon !== -1 && firstColon === lastColon ? host.slice(0, lastColon) : host)
}

function normalizeHost(host) {
	return host.toLowerCase().replace(/\.$/, '')
}
