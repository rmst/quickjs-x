#!/usr/bin/env qjsx-node
/**
 * QJSX-Node Bootstrap
 *
 * This is a minimal bootstrap file that acts as an interpreter for user scripts.
 * When compiled with qjsxc using the -D flag for all node modules, it creates
 * a standalone executable that can run any JavaScript file with embedded Node.js
 * compatibility modules.
 *
 * All node modules are embedded at compile time using qjsxc's -D flag, so they
 * are available to dynamically loaded scripts without needing external files.
 */

import * as std from "std";
import * as os from "os";

// Check if a script was provided
if (scriptArgs.length < 2) {
    console.log("Usage: qjsx-node <script.js> [args...]");
    std.exit(1);
}

const scriptPath = scriptArgs[1];

// Load and execute the user's script
try {
    await import(scriptPath);
} catch (e) {
    console.error("Error loading script:", e.message);
    if (e.stack) {
        console.error(e.stack);
    }
    std.exit(1);
}
