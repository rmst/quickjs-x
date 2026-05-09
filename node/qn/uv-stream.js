/*
 * qn:uv-stream - Typed JS wrappers over the single-dispatch C _op function.
 *
 * This module is the JS-side API for qn_uv_stream. It provides named functions
 * that call _op(opcode, ...args).
 */

import {
	_op,
	TCP_NEW, TCP_BIND, LISTEN, TCP_CONNECT,
	READ_START, READ_STOP, WRITE, SHUTDOWN, CLOSE, FILENO,
	TCP_NODELAY, TCP_KEEPALIVE, TCP_GETSOCKNAME, TCP_GETPEERNAME,
	SET_ON_READ, SET_ON_CONNECTION, SET_ON_CONNECT, SET_ON_SHUTDOWN,
	PIPE_NEW, PIPE_OPEN,
	TTY_NEW, TTY_SET_MODE, TTY_GET_WINSIZE, TTY_RESET_MODE,
	TTY_MODE_NORMAL, TTY_MODE_RAW, TTY_MODE_IO,
	REF, UNREF,
	AF_INET, AF_INET6,
} from 'qn_uv_stream'

export { AF_INET, AF_INET6 }
export { TTY_MODE_NORMAL, TTY_MODE_RAW, TTY_MODE_IO }

/* TCP handle creation */
export const tcpNew         = (family) => _op(TCP_NEW, family)
export const tcpBind        = (handle, host, port) => _op(TCP_BIND, handle, host, port)
export const listen         = (handle, backlog) => _op(LISTEN, handle, backlog)
export const tcpConnect     = (handle, host, port) => _op(TCP_CONNECT, handle, host, port)

/* Stream I/O */
export const readStart      = (handle) => _op(READ_START, handle)
export const readStop       = (handle) => _op(READ_STOP, handle)
export const write          = (handle, buf) => _op(WRITE, handle, buf)
export const shutdown       = (handle) => _op(SHUTDOWN, handle)
export const close          = (handle) => _op(CLOSE, handle)

/* Handle properties */
export const fileno         = (handle) => _op(FILENO, handle)
export const tcpNodelay     = (handle, enable) => _op(TCP_NODELAY, handle, enable)
export const tcpKeepalive   = (handle, enable) => _op(TCP_KEEPALIVE, handle, enable)
export const tcpGetsockname = (handle) => _op(TCP_GETSOCKNAME, handle)
export const tcpGetpeername = (handle) => _op(TCP_GETPEERNAME, handle)

/* Pipe handles */
export const pipeNew        = () => _op(PIPE_NEW)
export const pipeOpen       = (handle, fd) => _op(PIPE_OPEN, handle, fd)

/* TTY handles */
export const ttyNew         = (fd, readable) => _op(TTY_NEW, fd, readable)
export const ttySetMode     = (handle, mode) => _op(TTY_SET_MODE, handle, mode)
export const ttyGetWinSize  = (handle) => _op(TTY_GET_WINSIZE, handle)
export const ttyResetMode   = () => _op(TTY_RESET_MODE)

/* Event-loop ref counting */
export const ref            = (handle) => _op(REF, handle)
export const unref          = (handle) => _op(UNREF, handle)

/* Callback setters */
export const setOnRead       = (handle, fn) => _op(SET_ON_READ, handle, fn)
export const setOnConnection = (handle, fn) => _op(SET_ON_CONNECTION, handle, fn)
export const setOnConnect    = (handle, fn) => _op(SET_ON_CONNECT, handle, fn)
export const setOnShutdown   = (handle, fn) => _op(SET_ON_SHUTDOWN, handle, fn)
