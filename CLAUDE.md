# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile          # TypeScript compilation (tsc -p ./)
npm run watch            # Watch mode compilation
npm run lint             # ESLint on src/
npm run test             # Run extension tests via vscode-test
npm run pretest          # Compile + lint before test
npm run vscode:prepublish  # Compile (used by vsce package/publish)
```

- Press **F5** in VS Code to launch the Extension Development Host for manual testing.
- Test files live in `src/test/` and compile to `out/test/`. The test runner config is in [.vscode-test.mjs](.vscode-test.mjs).

## Architecture

This extension provides two rsync commands: `rsync.syncCurrentFile` (sync the active editor file) and `rsync.syncProject` (sync the entire workspace). All logic lives in [src/extension.ts](src/extension.ts).

### Design: VS Code Tasks API

Instead of spawning `rsync` via Node.js `child_process`, the extension uses the **VS Code Tasks API** (`vscode.Task` + `vscode.ShellExecution`). This gives native terminal output, task history, and standard presentation without manual stream piping.

**Command flow for both commands:**
1. Validate user settings (`rsync.remoteHost`, `rsync.remotePath`) — show an error notification and abort if missing
2. Validate workspace state (folder open; for file sync, an active editor with a file inside the workspace)
3. Build rsync arguments (extra options, exclusions, source, destination)
4. Wrap in a `vscode.Task` with `ShellExecution` (task `definition.type` = `'rsync'`)
5. Execute via `vscode.tasks.executeTask()` — output appears in the integrated terminal
6. `onDidEndTaskProcess` listener filters for `type === 'rsync'` tasks and shows a success/error notification

### Key functions in [src/extension.ts](src/extension.ts)

|Function|Purpose|
|---|---|
|`activate()`|Registers commands and the `onDidEndTaskProcess` listener|
|`syncCurrentFile()`|Handler for syncing the active editor file|
|`syncProject()`|Handler for syncing the entire workspace|
|`validateConfig()`|Reads and validates required settings; returns `null` with a user notification if missing|
|`getWorkspaceRoot()`|Returns `workspaceFolders[0].uri.fsPath` or `null` if no folder is open|
|`createRsyncTask(name, args)`|Builds a `vscode.Task` with `ShellExecution` and `presentationOptions`|

### Configuration

Users must set at minimum `rsync.remoteHost` and `rsync.remotePath` in their VS Code settings before the commands will work. All settings are declared in [package.json](package.json) under `contributes.configuration`:

|Setting|Default|Description|
|---|---|---|
|`rsync.remoteHost`|`""`|Remote host (e.g., `user@host`)|
|`rsync.remotePath`|`""`|Destination path on remote|
|`rsync.rsyncPath`|`"rsync"`|Path to rsync binary|
|`rsync.exclude`|`[".git", "node_modules", "out", ".vscode-test"]`|Patterns passed to `--exclude`|
|`rsync.extraOptions`|`["-az", "--delete"]`|Extra rsync flags|

### Build output

Source TypeScript compiles to `out/` (ES2022 target, Node16 modules, strict mode enabled). The tsconfig explicitly lists `"types": ["node", "mocha"]` so the TypeScript server resolves Node.js and Mocha type declarations.
