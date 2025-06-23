
import * as std from "std"
import * as os from "os"


export const monkeyPatchGlobals = () => {
	
	if(globalThis.process)
		return

	globalThis.process = {
		argv: [...scriptArgs],  // TODO: maybe we have to unwrap these
		env: std.getenviron(),  // TODO: make this function call (via getter / setter / proxy)
		exit: std.exit,
	}
	
	// TODO: Other important Node.js globals to add in the future:
	// - global (alias for globalThis)
	// - Buffer (for binary data handling)
	// - console (enhanced console methods)
	// - setImmediate/clearImmediate
	// - setTimeout/clearTimeout (if not already available)
	// - setInterval/clearInterval (if not already available)
	// - __dirname and __filename (for CommonJS compatibility)
}

