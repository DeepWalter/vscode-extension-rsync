# Remote Sync

Sync files from your VS Code workspace to a remote host using [rsync](https://rsync.samba.org/). Provides single-file sync, full project sync, and automatic sync on save — all running natively through the VS Code Tasks API so output appears in the integrated terminal.

![Version](https://img.shields.io/badge/version-0.0.1-blue)

## Features

- **Sync Current File** — Sync the active editor file to the remote, preserving its directory structure relative to the workspace root.
- **Sync Entire Project** — Sync the whole workspace to the remote with configurable exclusion patterns (`--exclude`).
- **Sync on Save** — Automatically sync the current file whenever you save, with a configurable debounce delay.
- **Status Bar Indicator** — A status bar item shows the current sync state (idle, running, success, error) with codicons and color coding.
- **Interactive Setup** — The `rsync: Configure Workspace Settings` command walks you through setting up the remote host, path, and advanced options step by step.
- **Native Terminal Output** — Uses the VS Code Tasks API so rsync output appears in the integrated terminal with full task history.
- **Smart Exclusions** — File-sync-on-save skips files matching your `rsync.exclude` patterns before spawning rsync, avoiding wasteful tasks for files inside `node_modules/`, `.venv/`, etc.

## Requirements

- **rsync** must be installed and available on your `PATH` (or specify a custom path via `rsync.rsyncPath`).
- **VS Code 1.120.0** or later.
- A remote host accessible via rsync (SSH or rsync daemon).

## Quick Start

1. Install the extension.
2. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run **rsync: Configure Workspace Settings**.
3. Enter your remote host (e.g., `user@example.com`) and destination path (e.g., `/home/user/project/`).
4. Optionally configure advanced options like exclude patterns, extra rsync flags, and sync-on-save.
5. Run **rsync: Sync Current File** or **rsync: Sync Entire Project** to start syncing.

## Commands

| Command | ID | Description |
| --- | --- | --- |
| **rsync: Sync Current File to Remote** | `rsync.syncCurrentFile` | Syncs the file in the active editor to the remote, preserving its workspace-relative path. |
| **rsync: Sync Entire Project to Remote** | `rsync.syncProject` | Syncs the entire workspace folder to the remote. |
| **rsync: Configure Workspace Settings** | `rsync.config` | Interactive guided setup for workspace-level rsync settings. |

The status bar item (shown as a sync icon on the left side of the status bar) also triggers **rsync: Sync Current File** when clicked.

## Extension Settings

This extension contributes the following settings under the `rsync.*` namespace:

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `rsync.remoteHost` | `string` | `""` | Remote host in rsync format (e.g., `user@host`). **Required.** |
| `rsync.remotePath` | `string` | `""` | Destination path on the remote (e.g., `/home/user/project/`). **Required.** |
| `rsync.remoteName` | `string` | `""` | Optional display name for the remote. When set, the status bar shows "rsync to _name_" instead of the raw host. |
| `rsync.rsyncPath` | `string` | `"rsync"` | Path to the rsync binary. Change this if rsync is installed in a non-standard location. |
| `rsync.extraOptions` | `string[]` | `["-az", "--delete"]` | Extra flags passed to every rsync invocation. |
| `rsync.exclude` | `string[]` | See below | Patterns passed to `--exclude`. Defaults cover common IDE, Python, Node, and build artifacts. |
| `rsync.syncOnSave` | `boolean` | `false` | When enabled, automatically syncs the current file to the remote on save. |
| `rsync.syncOnSaveDelay` | `number` | `500` | Debounce delay in milliseconds before syncing on save. The timer resets on each save, so rapid saves (e.g., from formatters) only trigger one sync. Set to `0` for immediate sync. |

### Default Exclude Patterns

```
.vscode, .idea, .DS_Store, node_modules, .vscode-test,
**/__pycache__/, *.py[co], .venv, venv, .env,
.pytest_cache, .mypy_cache, .ruff_cache, .tox,
dist, build, *.egg-info, *.log
```

Exclude patterns follow rsync's `--exclude` semantics:
- Patterns containing `/` match against the full relative path.
- Patterns without `/` match against any path segment (file or directory name).
- A trailing `/` restricts the pattern to directories only.
- `**` matches anything including `/`; `*` matches anything except `/`.

## Status Bar

The extension adds a status bar item on the left side of the status bar (next to Problems/Warnings):

| State | Icon | Color | Behavior |
| --- | --- | --- | --- |
| Idle | `$(sync)` | Default | Ready to sync. Success reverts to idle after 3 seconds. |
| Running | `$(sync~spin)` | Default | A sync task is currently executing. |
| Success | `$(pass)` | Green (`#73c991`) | Sync completed successfully. Auto-reverts to idle after 3 seconds. |
| Error | `$(error)` | Red (`#f14c4c`) | Sync failed. Persists until the next sync starts. |

Clicking the status bar item triggers **rsync: Sync Current File**.

## Architecture

This extension uses the **VS Code Tasks API** (`vscode.Task` + `vscode.ShellExecution`) instead of spawning `rsync` via `child_process`. This provides:

- Native terminal output and task history.
- Standard VS Code task presentation without manual stream piping.
- Clean integration with the built-in terminal panel.

## Known Issues

- Only single-root workspaces are supported (uses `workspaceFolders[0]`).
- On Windows, rsync must be available through WSL, Cygwin, or a native port. The extension assumes a POSIX-compatible rsync binary.

## Release Notes

### 0.0.1

Initial release with file sync, project sync, sync-on-save, status bar indicator, and interactive configuration.

---

**Enjoy!**
