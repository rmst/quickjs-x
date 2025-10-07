
### Important: At the start of every new conversation
- Read all of the following documents:
	- quickjs/doc/quickjs.texi
- Check the last few git commits (and list the files changed) to get a feeling for what has been worked on recently.

### Building
Important: Read `Makefile`. **Always** use temporary directory as the build dir (never use the default).

### Code comments
Never write comments describing what changed compared the previous version of the code. Comments should always describe the current situation. Change notes go in the commit message.

### Git commits
Never commit without being explicitly asked to. When making a commit, always add "Co-Authored-By AI" as the last line of the commit message. Before making a commit check if the commit fixed a bug or implemented a feature listed in Issues.md (and if so remove it as part of the commit). Don't include trivial details. All commit messages should with a type such "feat" or "fix". Be careful not to include \n charaters instead of proper newlines.