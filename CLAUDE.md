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

This extension provides three rsync commands: `rsync.syncCurrentFile` (sync the active editor file), `rsync.syncProject` (sync the entire workspace), and `rsync.config` (interactive guided setup for workspace settings). It also provides a **status bar item** that reflects the current sync state with codicons. All logic lives in [src/extension.ts](src/extension.ts).

### Design: VS Code Tasks API

Instead of spawning `rsync` via Node.js `child_process`, the extension uses the **VS Code Tasks API** (`vscode.Task` + `vscode.ShellExecution`). This gives native terminal output, task history, and standard presentation without manual stream piping.

**Command flow for both sync commands:**
1. Validate user settings (`rsync.remoteHost`, `rsync.remotePath`) — show an error notification and abort if missing
2. Validate workspace state (folder open; for file sync, an active editor with a file inside the workspace)
3. Build rsync arguments (extra options, exclusions, source, destination)
4. Wrap in a `vscode.Task` with `ShellExecution` (task `definition.type` = `'rsync'`)
5. Execute via `vscode.tasks.executeTask()` — output appears in the integrated terminal
6. `onDidStartTask` listener flips the status bar to "running" state
7. `onDidEndTaskProcess` listener updates the status bar (success/error) and shows an error notification on failure

### Design: Status Bar Item

A `vscode.StatusBarItem` (left-aligned, next to Problems/Warnings) reflects sync state:

|State|Codicon|Color|Behavior|
|---|---|---|---|
|Idle|`$(sync)`|default|Initial state; success reverts here after 3 s|
|Running|`$(sync~spin)`|default|Set by `onDidStartTask`|
|Success|`$(pass)`|green `#73c991`|3 s timeout, then reverts to idle|
|Error|`$(error)`|red `#f14c4c`|Persists until next sync starts|

The item displays "rsync to *name*" where *name* comes from `rsync.remoteName` (if set) or `rsync.remoteHost`, falling back to just "rsync". Clicking the item triggers `rsync.syncCurrentFile`.

### Key functions in [src/extension.ts](src/extension.ts)

|Function|Purpose|
|---|---|
|`activate()`|Creates the status bar item, registers task lifecycle listeners (`onDidStartTask`/`onDidEndTaskProcess`), auto-save listener, task provider, and commands|
|`syncCurrentFile()`|Handler for syncing the active editor file (validates, then delegates to `syncFile`)|
|`syncFile(document)`|Core sync logic for a single document — used by both `syncCurrentFile` and the `syncOnSave` listener; validates silently and skips files matching `rsync.exclude` patterns via `isExcluded`|
|`syncProject()`|Handler for syncing the entire workspace|
|`validateConfig()`|Reads and validates required settings; returns `null` with a user notification if missing|
|`getWorkspaceRoot()`|Returns `workspaceFolders[0].uri.fsPath` or `null` if no folder is open|
|`createRsyncTask(name, args)`|Builds a `vscode.Task` with `ShellExecution` and `presentationOptions`|
|`escapeShellGlob(pattern)`|Escapes shell glob metacharacters (`*?[]`) for safe `--exclude` passthrough in `syncProject`|
|`matchGlob(str, pattern)`|Converts rsync-style glob patterns (`**`, `*`, `?`, `[...]`) to regex for matching|
|`isExcluded(relativePath, excludePatterns)`|Tests a file path against `rsync.exclude` patterns; used by `syncFile` to skip excluded files on save|
|`configWorkspace()`|Handler for interactive workspace configuration (`rsync.config` command)|
|`promptAdvancedOptions(config)`|Prompts for optional settings: remoteName, rsyncPath, extraOptions, exclude patterns, syncOnSave|
|`getRemoteDisplayName()`|Reads `rsync.remoteName` or falls back to `rsync.remoteHost`; returns full label like "rsync to production"|
|`setSyncStatus(state)`|Updates the status bar item text, icon, color, and tooltip for the given state (`idle`/`running`/`success`/`error`)|

### Configuration

Users must set at minimum `rsync.remoteHost` and `rsync.remotePath` in their VS Code settings before the commands will work. `rsync.remoteName` is optional — if set, the status bar shows "rsync to *name*" instead of the raw host. All settings are declared in [package.json](package.json) under `contributes.configuration`:

|Setting|Default|Description|
|---|---|---|
|`rsync.remoteHost`|`""`|Remote host (e.g., `user@host`)|
|`rsync.remotePath`|`""`|Destination path on remote|
|`rsync.remoteName`|`""`|Optional display name for the remote; shown in the status bar as "rsync to *name*"|
|`rsync.rsyncPath`|`"rsync"`|Path to rsync binary|
|`rsync.exclude`|`[".vscode", ".idea", ".DS_Store", "node_modules", ".vscode-test", "**/__pycache__/", "*.py[co]", ".venv", "venv", ".env", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", "dist", "build", "*.egg-info", "*.log"]`|Patterns passed to `--exclude`|
|`rsync.extraOptions`|`["-az", "--delete"]`|Extra rsync flags|
|`rsync.syncOnSave`|`false`|Automatically sync the current file on save|
|`rsync.syncOnSaveDelay`|`500`|Debounce delay in ms before syncing on save|

### Build output

Source TypeScript compiles to `out/` (ES2022 target, Node16 modules, strict mode enabled). The tsconfig explicitly lists `"types": ["node", "mocha"]` so the TypeScript server resolves Node.js and Mocha type declarations.
