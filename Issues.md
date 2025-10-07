
### Read/Watch
- Structured stack trace access: https://github.com/bellard/quickjs/issues/235
- Typescript: https://github.com/bellard/quickjs/issues/173
- Sockets: https://github.com/bellard/quickjs/pull/405

## Bugs

## Improvements

The Nodejs --import cli option https://nodejs.org/api/cli.html#--importmodule (usage: https://nodejs.org/api/module.html#enabling) is probably how importing should be done here as well

An "iframe"-like mechanism that launches a new "nested" quickjs process  that is completely sandboxed and doesn't have access to the os and std modules and can't import anything outside a predefined QJSXPATH. The only way it can affect things is through communication with the main process (which would have to be implemented). Also: I doubt it, but check if maybe web workers or sth already can do this