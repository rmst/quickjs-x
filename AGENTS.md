### At the start of every new conversation
- Read all of the following documents:
	- @Readme.md
	- @quickjs/doc/quickjs.texi
- Check the last few git commits to get a feeling for what has been worked on recently.

### Building
Before building read @Makefile. To build never just do `make $whatever`. Always use a temporary directory as the build dir, e.g. `make BIN_DIR=/tmp/build $whatever`we.

### Code comments
Never write comments describing what changed in a code edit. Comments should describe the current situation. Change notes belong in the commit message.

### Git commits
Never commit without being explicitly asked to. When making a commit, always add `Co-Authored-By: ai <noreply@ai.simonramstedt.com>` as the last line of the commit message. Before making a commit check if the commit fixed a bug or implemented a feature listed in Issues.md and if so remove it as part of the commit. Don't include trivial details. All commit messages should start with a tag (e.g. "feat" or "fix"). Be careful not to include \n charaters instead of proper newlines.