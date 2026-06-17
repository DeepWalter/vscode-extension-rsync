/**
 * VS Code rsync extension — entry point.
 *
 * ## How VS Code extensions work
 *
 * `activate()` is called by VS Code when the extension is first needed (in our case,
 * when the user runs one of the rsync commands). It receives a `context` object that
 * tracks the extension's lifetime — anything we push into `context.subscriptions` is
 * automatically cleaned up (disposed) when the extension is deactivated, preventing
 * memory leaks.
 *
 * `deactivate()` is called when VS Code shuts down or the extension is disabled.
 * It's a no-op here because `context.subscriptions` already handles cleanup.
 *
 * ## Architecture
 *
 * This extension uses the **VS Code Tasks API** (vscode.tasks) rather than raw
 * child_process. Tasks give us native terminal output, task history, and standard
 * presentation without manual stream piping.
 *
 * Flow for both commands:
 * 1. Validate required user settings (remoteHost, remotePath)
 * 2. Validate workspace state (folder open, active editor for file sync)
 * 3. Build rsync arguments
 * 4. Wrap them in a vscode.Task with a ShellExecution
 * 5. Execute the task — output appears in the integrated terminal
 * 6. onDidEndTaskProcess fires → show a success/error notification
 */

import * as vscode from 'vscode';
// `path` is a Node.js built-in module for file path manipulation.
// We use it to compute relative paths and join path segments portably.
import * as path from 'path';

// ---- Status bar ----

/** The status bar item that reflects the current sync state. */
let statusBarItem: vscode.StatusBarItem;
/** Timeout handle for reverting the success indicator back to idle. */
let successTimeout: NodeJS.Timeout | undefined;

/**
 * Read the display name for the remote from configuration.
 *
 * Uses `rsync.remoteName` if set, otherwise falls back to `rsync.remoteHost`.
 * Returns 'rsync' if neither is configured.
 */
function getRemoteDisplayName(): string {
	const config = vscode.workspace.getConfiguration('rsync');
	const remoteName = config.get<string>('remoteName', '').trim();
	if (remoteName) {
		return `rsync to ${remoteName}`;
	}
	const remoteHost = config.get<string>('remoteHost', '').trim();
	if (remoteHost) {
		return `rsync to ${remoteHost}`;
	}
	return 'rsync';
}

function setSyncStatus(state: 'idle' | 'running' | 'success' | 'error'): void {
	if (successTimeout) {
		clearTimeout(successTimeout);
		successTimeout = undefined;
	}
	const name = getRemoteDisplayName();
	switch (state) {
		case 'idle':
			statusBarItem.text = `$(sync) ${name}`;
			statusBarItem.tooltip = `${name}: Ready`;
			statusBarItem.color = undefined;
			break;
		case 'running':
			statusBarItem.text = `$(sync~spin) ${name}`;
			statusBarItem.tooltip = `${name}: Syncing...`;
			statusBarItem.color = undefined;
			break;
		case 'success':
			statusBarItem.text = `$(pass) ${name}`;
			statusBarItem.tooltip = `${name}: Sync completed`;
			statusBarItem.color = '#73c991';
			successTimeout = setTimeout(() => setSyncStatus('idle'), 3000);
			break;
		case 'error':
			statusBarItem.text = `$(error) ${name}`;
			statusBarItem.tooltip = `${name}: Sync failed — click to retry`;
			statusBarItem.color = '#f14c4c';
			break;
	}
}

/**
 * Called by VS Code when the extension is activated.
 *
 * @param context - The extension context. Anything added to `context.subscriptions`
 *   is automatically disposed when the extension is deactivated.
 */
export function activate(context: vscode.ExtensionContext) {
	// ---- Status bar item ----
	// Placed on the left side, next to the Problems'
	// Warnings indicators.
	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		10,
	);
	statusBarItem.command = 'rsync.syncCurrentFile';
	setSyncStatus('idle');
	statusBarItem.show();

	// ---- Task lifecycle listeners ----
	// `onDidStartTask` fires when task execution begins — we use it to
	// flip the status bar into "running" state.
	const startListener = vscode.tasks.onDidStartTask((e) => {
		if (e.execution.task.definition.type === 'rsync') {
			setSyncStatus('running');
		}
	});

	// `onDidEndTaskProcess` fires when the shell process exits.
	const endListener = vscode.tasks.onDidEndTaskProcess((e) => {
		// Only handle tasks created by this extension
		if (e.execution.task.definition.type !== 'rsync') {
			return;
		}
		if (e.exitCode === 0) {
			setSyncStatus('success');
		} else {
			setSyncStatus('error');
			vscode.window.showErrorMessage(
				`rsync: "${e.execution.task.name}" failed with exit code ${e.exitCode}. See terminal for details.`,
			);
		}
	});

	/**
	 * Auto-sync on save: when the user saves a document and `rsync.syncOnSave`
	 * is enabled, sync that file to the remote host automatically.
	 *
	 * A debounce timer (`rsync.syncOnSaveDelay`, default 500 ms) ensures
	 * rsync runs after all save-triggered activity has settled — formatters,
	 * code actions, and other extensions that may trigger additional saves.
	 *
	 * Validation is silent — no error popups on every save. If config is
	 * missing the user will notice when they manually run a sync command.
	 */
	const saveTimeouts = new Map<string, NodeJS.Timeout>();

	const onSaveListener = vscode.workspace.onDidSaveTextDocument((document) => {
		const config = vscode.workspace.getConfiguration('rsync');
		if (!config.get<boolean>('syncOnSave', false)) {
			return;
		}

		const key = document.uri.toString();
		const existing = saveTimeouts.get(key);
		if (existing) {
			clearTimeout(existing);
		}

		const delay = config.get<number>('syncOnSaveDelay', 500);
		saveTimeouts.set(key, setTimeout(() => {
			saveTimeouts.delete(key);
			syncFile(document);
		}, delay));
	});

	/**
	 * Register our two commands with VS Code.
	 *
	 * `vscode.commands.registerCommand(commandId, handler)` returns a Disposable.
	 * Pushing it into `context.subscriptions` ensures the command is unregistered
	 * when the extension deactivates — so VS Code won't try to call a dead handler.
	 *
	 * The command IDs ("rsync.syncCurrentFile", "rsync.syncProject") MUST match
	 * the `contributes.commands` entries in package.json exactly.
	 */
	const taskProvider = vscode.tasks.registerTaskProvider('rsync', {
		provideTasks: () => [],
		resolveTask: (task: vscode.Task): vscode.Task | undefined => task,
	});

	context.subscriptions.push(
		statusBarItem,
		startListener,
		endListener,
		vscode.Disposable.from(
			onSaveListener,
			{ dispose: () => { for (const t of saveTimeouts.values()) { clearTimeout(t); } } },
		),
		taskProvider,
		vscode.commands.registerCommand('rsync.syncCurrentFile', syncCurrentFile),
		vscode.commands.registerCommand('rsync.syncProject', syncProject),
		vscode.commands.registerCommand('rsync.config', configWorkspace),
	);
}

/**
 * Called by VS Code when the extension is deactivated.
 * No manual cleanup needed — `context.subscriptions` takes care of everything.
 */
export function deactivate() { }

// ---- Command implementations ----

/**
 * Core implementation shared by the `rsync.syncCurrentFile` command and the
 * `syncOnSave` listener.
 *
 * Syncs a single document to the remote host, preserving its directory
 * structure relative to the workspace root.
 *
 * Unlike `syncCurrentFile`, this function validates silently — it returns
 * early without showing error notifications. This makes it safe to call
 * from automated triggers like `onDidSaveTextDocument` without spamming
 * the user with popups on every save.
 *
 * @param document - The text document to sync
 */
async function syncFile(document: vscode.TextDocument) {
	// Validate required configuration silently
	const cfg = validateConfig();
	if (!cfg) {
		return;
	}

	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return;
	}

	const filePath = document.uri.fsPath;

	// Compute the file's path relative to the workspace root.
	const relativePath = path.relative(workspaceRoot, filePath);

	// If the relative path starts with "..", the file is outside the workspace
	if (relativePath.startsWith('..')) {
		return;
	}

	// Skip files that match rsync.exclude patterns.  Without this check
	// saving a file inside node_modules/ or .venv/ would wastefully spawn
	// an rsync process even though rsync itself would exclude it.
	const config = vscode.workspace.getConfiguration('rsync');
	const exclude = config.get<string[]>('exclude', []);
	if (isExcluded(relativePath, exclude)) {
		return;
	}

	// Extract the directory portion of the relative path so rsync places
	// the file in the correct subdirectory on the remote.
	const destDir = path.dirname(relativePath);

	// Construct the rsync destination with trailing `/`
	const dest = `${cfg.remoteHost}:${path.join(cfg.remotePath, destDir)}/`;

	// Build the argument list: extraOptions + source file + destination
	const args = [...cfg.extraOptions, filePath, dest];

	const task = createRsyncTask('Sync Current File', args);
	await vscode.tasks.executeTask(task);
}

/**
 * `rsync.syncCurrentFile` command handler.
 *
 * Syncs the file currently open in the active editor to the remote host,
 * preserving its directory structure relative to the workspace root.
 *
 * Example: If the workspace is `/project` and the active file is
 * `/project/src/utils/helper.ts`, the file is synced to:
 *   `<remoteHost>:<remotePath>/src/utils/helper.ts`
 *
 * Validation (each step shows an error notification and aborts on failure):
 * 1. Required settings are configured (remoteHost, remotePath)
 * 2. A workspace folder is open
 * 3. An editor is active (a file is open)
 * 4. The file is inside the workspace
 *
 * Delegates to `syncFile()` for the actual sync logic.
 */
async function syncCurrentFile() {
	// Validate required configuration (remoteHost, remotePath) — loud, with
	// error notifications so the user knows why the command didn't work.
	const cfg = validateConfig();
	if (!cfg) {
		return;
	}

	// Ensure a workspace folder is open
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return;
	}

	// Get the currently focused text editor.
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage('rsync: No active editor.');
		return;
	}

	// Check that the file is inside the workspace before delegating
	const filePath = editor.document.uri.fsPath;
	const relativePath = path.relative(workspaceRoot, filePath);
	if (relativePath.startsWith('..')) {
		vscode.window.showErrorMessage('rsync: The active file is outside the workspace.');
		return;
	}

	await syncFile(editor.document);
}

/**
 * `rsync.syncProject` command handler.
 *
 * Syncs the entire workspace folder to the remote host. Uses the exclusion
 * patterns from the `rsync.exclude` setting to skip files that shouldn't be
 * transferred.
 *
 * Validation (each step shows an error notification and aborts on failure):
 * 1. Required settings are configured (remoteHost, remotePath)
 * 2. A workspace folder is open
 *
 * @async — uses `await` to wait for task execution to start
 */
async function syncProject() {
	const cfg = validateConfig();
	if (!cfg) {
		return;
	}

	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return;
	}

	// Read additional settings that only apply to project sync
	const config = vscode.workspace.getConfiguration('rsync');
	const exclude = config.get<string[]>('exclude', []);

	// IMPORTANT: A trailing `/` on the source tells rsync to copy the *contents*
	// of the directory, not the directory itself.
	//   `/project/` → remote gets the files inside /project
	//   `/project`  → remote gets a /project folder containing the files
	const source = workspaceRoot + (workspaceRoot.endsWith('/') ? '' : '/');

	// Destination in rsync format: user@host:/path/to/remote/
	const dest = `${cfg.remoteHost}:${cfg.remotePath}`;

	// Compose the argument list:
	// 1. Start with the user's extraOptions (e.g., "-az", "--delete")
	// 2. Append `--exclude <pattern>` for each exclusion pattern
	// 3. Append the source directory and destination
	const args = [...cfg.extraOptions];
	for (const pattern of exclude) {
		args.push('--exclude', pattern);
	}
	args.push(source, dest);

	const task = createRsyncTask('Sync Project', args);
	await vscode.tasks.executeTask(task);
}

/**
 * `rsync.config` command handler.
 *
 * Interactively prompts the user for rsync settings and writes them to the
 * workspace's `.vscode/settings.json` file. This is the setup command users
 * run once per project to configure remote host/path before syncing.
 *
 * Flow:
 * 1. Prompt for `remoteHost` (required) — pre-filled with any current value
 * 2. Prompt for `remotePath` (required) — pre-filled with any current value
 * 3. Ask whether to configure advanced options (rsync path, excludes, flags)
 * 4. Write all collected values to workspace-level configuration
 *
 * Writes to `ConfigurationTarget.Workspace` so settings are scoped to the
 * current workspace and don't pollute the user's global settings.
 */
async function configWorkspace() {
	const config = vscode.workspace.getConfiguration('rsync');

	// ---- Required: remoteHost ----
	const curHost = config.get<string>('remoteHost', '');
	const remoteHost = await vscode.window.showInputBox({
		title: 'rsync: Configure Workspace',
		prompt: 'Remote host (e.g., user@example.com)',
		placeHolder: 'user@example.com',
		value: curHost,
		validateInput: (value) => {
			if (!value.trim()) {
				return 'Remote host is required.';
			}
			return undefined; // undefined means valid
		},
	});
	if (remoteHost === undefined) {
		return; // user cancelled
	}

	// ---- Required: remotePath ----
	const curPath = config.get<string>('remotePath', '');
	const remotePath = await vscode.window.showInputBox({
		title: 'rsync: Configure Workspace',
		prompt: 'Destination path on remote (e.g., /home/user/project/)',
		placeHolder: '/home/user/project/',
		value: curPath,
		validateInput: (value) => {
			if (!value.trim()) {
				return 'Remote path is required.';
			}
			return undefined;
		},
	});
	if (remotePath === undefined) {
		return; // user cancelled
	}

	// Write the required settings immediately
	await config.update('remoteHost', remoteHost.trim(), vscode.ConfigurationTarget.Workspace);
	await config.update('remotePath', remotePath.trim(), vscode.ConfigurationTarget.Workspace);

	// ---- Optional: advanced settings ----
	const choice = await vscode.window.showQuickPick(
		['Done', 'Configure advanced options'],
		{ title: 'rsync: Basic settings saved. Configure advanced options?' },
	);
	if (choice === 'Configure advanced options') {
		await promptAdvancedOptions(config);
	}

	vscode.window.showInformationMessage(
		`rsync: Workspace configured — syncing to ${remoteHost.trim()}:${remotePath.trim()}`,
	);
}

/**
 * Prompt the user for optional advanced rsync settings and write them to
 * workspace configuration.
 */
async function promptAdvancedOptions(config: vscode.WorkspaceConfiguration) {
	// remoteName
	const curName = config.get<string>('remoteName', '');
	const remoteName = await vscode.window.showInputBox({
		title: 'rsync: Advanced — Remote Display Name',
		prompt: 'Display name shown in the status bar (e.g., production)',
		placeHolder: 'production',
		value: curName,
	});
	if (remoteName !== undefined) {
		await config.update('remoteName', remoteName.trim(), vscode.ConfigurationTarget.Workspace);
	}

	// rsyncPath
	const curRsyncPath = config.get<string>('rsyncPath', 'rsync');
	const rsyncPath = await vscode.window.showInputBox({
		title: 'rsync: Advanced — rsync Path',
		prompt: 'Path to the rsync binary (default: rsync)',
		placeHolder: 'rsync',
		value: curRsyncPath,
	});
	if (rsyncPath !== undefined) {
		await config.update('rsyncPath', rsyncPath.trim() || 'rsync', vscode.ConfigurationTarget.Workspace);
	}

	// extraOptions (comma-separated)
	const curOptions = config.get<string[]>('extraOptions', ['-az', '--delete']).join(', ');
	const optionsInput = await vscode.window.showInputBox({
		title: 'rsync: Advanced — Extra Options',
		prompt: 'Extra rsync flags (comma-separated, e.g., -az, --delete)',
		placeHolder: '-az, --delete',
		value: curOptions,
	});
	if (optionsInput !== undefined) {
		const extraOptions = optionsInput
			.split(',')
			.map(s => s.trim())
			.filter(s => s.length > 0);
		await config.update('extraOptions', extraOptions, vscode.ConfigurationTarget.Workspace);
	}

	// exclude patterns (comma-separated)
	const curExclude = config.get<string[]>('exclude', []).join(', ');
	const excludeInput = await vscode.window.showInputBox({
		title: 'rsync: Advanced — Exclude Patterns',
		prompt: 'Exclusion patterns (comma-separated, e.g., node_modules, .venv)',
		placeHolder: 'e.g., .vscode, node_modules, .venv, .DS_Store, dist, build, *.log',
		value: curExclude,
	});
	if (excludeInput !== undefined) {
		const exclude = excludeInput
			.split(',')
			.map(s => s.trim())
			.filter(s => s.length > 0);
		await config.update('exclude', exclude, vscode.ConfigurationTarget.Workspace);
	}

	// syncOnSave
	const curSyncOnSave = config.get<boolean>('syncOnSave', false);
	const syncOnSaveChoice = await vscode.window.showQuickPick(
		['Yes', 'No'],
		{
			title: 'rsync: Advanced — Sync on Save',
			placeHolder: curSyncOnSave ? 'Yes' : 'No',
		},
	);
	if (syncOnSaveChoice !== undefined) {
		await config.update('syncOnSave', syncOnSaveChoice === 'Yes', vscode.ConfigurationTarget.Workspace);
	}
}

// ---- Helpers ----

/**
 * Shape of the validated configuration object returned by `validateConfig`.
 *
 * In TypeScript, an `interface` defines the shape (contract) of an object.
 * This is purely a compile-time check — it doesn't exist at runtime.
 */
interface RsyncConfig {
	/** Remote host in rsync format, e.g. "user@example.com" */
	remoteHost: string;
	/** Destination path on the remote, e.g. "/var/www/project/" */
	remotePath: string;
	/** Extra flags passed to every rsync invocation, e.g. ["-az", "--delete"] */
	extraOptions: string[];
}

/**
 * Read and validate the required rsync settings from VS Code configuration.
 *
 * VS Code stores settings in a hierarchical key-value store. Users set them
 * in their settings.json or workspace settings. `getConfiguration('rsync')`
 * reads all keys under the "rsync." prefix.
 *
 * @returns A validated `RsyncConfig` object, or `null` if required settings
 *   are missing (an error notification is already shown to the user).
 *
 * Why return null instead of throwing?
 *   Missing config is an expected, recoverable state — the user just needs to
 *   fill in settings. Throwing an error would trigger a less user-friendly
 *   error dialog and look like a bug.
 */
function validateConfig(): RsyncConfig | null {
	// `getConfiguration('rsync')` reads all settings whose keys start with "rsync."
	// defined in package.json's `contributes.configuration` section.
	const config = vscode.workspace.getConfiguration('rsync');

	// `config.get<T>(key, defaultValue)` reads a single setting value.
	// The type parameter `<string>` tells TypeScript what type to expect.
	// `.trim()` removes leading/trailing whitespace the user may have added.
	const remoteHost = config.get<string>('remoteHost', '').trim();
	const remotePath = config.get<string>('remotePath', '').trim();
	const extraOptions = config.get<string[]>('extraOptions', ['-az', '--delete']);

	if (!remoteHost) {
		vscode.window.showErrorMessage(
			'rsync: Remote host is not configured. Set "rsync.remoteHost" in settings.',
		);
		return null;
	}
	if (!remotePath) {
		vscode.window.showErrorMessage(
			'rsync: Remote path is not configured. Set "rsync.remotePath" in settings.',
		);
		return null;
	}

	return { remoteHost, remotePath, extraOptions };
}

/**
 * Get the filesystem path of the first workspace folder.
 *
 * A "workspace folder" is the root folder opened in VS Code. The extension
 * only supports single-root workspaces (it uses `folders[0]`).
 *
 * @returns The absolute filesystem path as a string, or `null` if no folder
 *   is open (an error notification is shown in that case).
 */
function getWorkspaceRoot(): string | null {
	// `workspaceFolders` is undefined when no folder is open (e.g., VS Code
	// started with `code .` but the window hasn't loaded yet, or the user
	// closed all folders).
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		vscode.window.showErrorMessage('rsync: No workspace folder is open.');
		return null;
	}

	// `Uri.fsPath` converts a VS Code URI (which uses a `file://` scheme) to
	// a platform-native absolute filesystem path.
	return folders[0].uri.fsPath;
}

/**
 * Create a VS Code Task that runs rsync via the shell.
 *
 * ## How VS Code Tasks work
 *
 * A `vscode.Task` is a description of "run this thing":
 * 1. **TaskDefinition** — a `{ type, ... }` object that identifies the task
 *    category. We use `{ type: 'rsync' }` so we can distinguish our tasks in
 *    the `onDidEndTaskProcess` listener.
 * 2. **Scope** — where the task applies. `TaskScope.Workspace` means it's
 *    available across the entire workspace.
 * 3. **Name** — a human-readable label shown in the terminal and notifications.
 * 4. **Source** — the extension or component that created the task.
 * 5. **Execution** — what to actually run. `ShellExecution` runs a command
 *    through the system shell (like typing it into the terminal).
 *
 * ## Presentation options
 *
 * - `reveal: Silent` — don't auto-show the terminal; let the user open it
 *   themselves if they want to see the output.
 * - `clear: true` — clear the terminal before each run so old output doesn't
 *   mix with new output.
 * - `focus: false` — don't steal keyboard focus from the editor.
 *
 * @param name - Display name for the task (appears in terminal and notifications)
 * @param args - Arguments to pass to the rsync binary
 * @returns A configured vscode.Task ready to be executed
 */
function createRsyncTask(name: string, args: string[]): vscode.Task {
	const config = vscode.workspace.getConfiguration('rsync');
	const rsyncPath = config.get<string>('rsyncPath', 'rsync');

	// Create a standard Shell execution
	const execution = new vscode.ShellExecution(rsyncPath, args);

	const task = new vscode.Task(
		// Custom 'rsync' type — backed by taskDefinitions in package.json
		// and a TaskProvider registered in activate().
		{ type: 'rsync' },
		vscode.TaskScope.Workspace,
		name,
		'rsync', // source — identifies which extension created this task
		execution
	);

	// Control how the task's terminal behaves
	task.presentationOptions = {
		reveal: vscode.TaskRevealKind.Silent, // don't pop open the terminal
		clear: true,                           // clear terminal from previous run
		focus: false,                          // keep focus in the editor
	};

	return task;
}

/**
 * Test whether a string matches a single rsync-style glob pattern.
 *
 * Convert glob tokens to their regex equivalents:
 * - `**` matches anything including `/`
 * - `*`  matches anything except `/`
 * - `?`  matches one non-slash character
 * - `[...]` is kept as-is (valid regex character class)
 *
 * @param str     - The string to test (normalised to `/` separators)
 * @param pattern - A single rsync exclude pattern
 * @returns True if the string matches the pattern
 */
function matchGlob(str: string, pattern: string): boolean {
	let regexStr = '^';
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === '*') {
			if (pattern[i + 1] === '*') {
				// `**` matches anything, including `/`
				if (pattern[i + 2] === '/') {
					// `**/` — optionally matches a directory prefix
					regexStr += '(.*/)?';
					i += 3;
				} else {
					regexStr += '.*';
					i += 2;
				}
			} else {
				// `*` matches anything except `/`
				regexStr += '[^/]*';
				i++;
			}
		} else if (ch === '?') {
			regexStr += '[^/]';
			i++;
		} else if (ch === '[') {
			// Character class — pass through (valid regex)
			const end = pattern.indexOf(']', i);
			if (end !== -1) {
				regexStr += pattern.substring(i, end + 1);
				i = end + 1;
			} else {
				regexStr += '\\[';
				i++;
			}
		} else if ('.+^${}()|\\'.includes(ch)) {
			regexStr += '\\' + ch;
			i++;
		} else {
			regexStr += ch;
			i++;
		}
	}
	regexStr += '$';

	try {
		return new RegExp(regexStr).test(str);
	} catch {
		return false;
	}
}

/**
 * Determine whether a file (identified by its workspace-relative path) matches
 * any of the rsync exclude patterns.
 *
 * Models rsync's exclusion semantics:
 * - Patterns containing `/` (after normalisation) are matched against the
 *   **full relative path**.
 * - Patterns without `/` are matched against **each path segment**.  This
 *   handles both file-name patterns (`*.log`) and directory-name patterns
 *   (`node_modules`, `.venv`) — when rsync encounters a directory whose name
 *   matches an exclude pattern it skips the entire subtree.
 * - A trailing `/` on a pattern restricts it to directories only.
 *
 * @param relativePath - File path relative to workspace root (may contain
 *   backslashes on Windows; normalised internally)
 * @param excludePatterns - Array of rsync exclude patterns from config
 * @returns True if the file should be excluded from syncing
 */
function isExcluded(relativePath: string, excludePatterns: string[]): boolean {
	if (excludePatterns.length === 0) {
		return false;
	}

	// Normalise path separators for consistent matching
	const normalised = relativePath.replace(/\\/g, '/');
	const segments = normalised.split('/');

	return excludePatterns.some(pattern => {
		// Normalise the pattern
		let p = pattern;

		// Trailing `/` means directories only
		const dirOnly = p.endsWith('/');
		if (dirOnly) {
			p = p.slice(0, -1);
		}

		// Leading `/` anchors to the transfer root — strip it since we
		// always match from the workspace root.
		if (p.startsWith('/')) {
			p = p.slice(1);
		}

		const hasSlash = p.includes('/');

		if (hasSlash) {
			// Pattern with `/`: match against the full path
			return matchGlob(normalised, p);
		}

		if (dirOnly) {
			// Bare pattern ending in `/` (e.g. "dist/"): only match
			// directory segments, not the file name.
			return segments.slice(0, -1).some(seg => matchGlob(seg, p));
		}

		// Pattern without `/`: match against every path segment so a
		// directory pattern like `node_modules` catches files inside it.
		return segments.some(seg => matchGlob(seg, p));
	});
}
