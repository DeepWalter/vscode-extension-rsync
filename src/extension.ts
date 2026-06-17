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

/**
 * Called by VS Code when the extension is activated.
 *
 * @param context - The extension context. Anything added to `context.subscriptions`
 *   is automatically disposed when the extension is deactivated.
 */
export function activate(context: vscode.ExtensionContext) {
	/**
	 * Listen for task completion events from VS Code's task system.
	 *
	 * `onDidEndTaskProcess` fires whenever ANY task finishes. We filter by
	 * `task.definition.type === 'rsync'` to only react to our own tasks.
	 *
	 * The event payload (`e`) includes:
	 *   - `e.execution.task` — the vscode.Task that ran
	 *   - `e.exitCode`      — the process exit code (0 = success)
	 */
	const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
		// Only handle tasks created by this extension (see createRsyncTask below)
		if (e.execution.task.definition.type !== 'rsync') {
			return;
		}
		if (e.exitCode === 0) {
			vscode.window.showInformationMessage(
				`rsync: "${e.execution.task.name}" completed successfully.`,
			);
		} else {
			vscode.window.showErrorMessage(
				`rsync: "${e.execution.task.name}" failed with exit code ${e.exitCode}. See terminal for details.`,
			);
		}
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
		disposable,
		taskProvider,
		vscode.commands.registerCommand('rsync.syncCurrentFile', syncCurrentFile),
		vscode.commands.registerCommand('rsync.syncProject', syncProject),
	);
}

/**
 * Called by VS Code when the extension is deactivated.
 * No manual cleanup needed — `context.subscriptions` takes care of everything.
 */
export function deactivate() { }

// ---- Command implementations ----

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
 * @async — uses `await` to wait for task execution to start
 */
async function syncCurrentFile() {
	// Validate required configuration (remoteHost, remotePath)
	const cfg = validateConfig();
	if (!cfg) {
		return;
	}

	// Ensure a workspace folder is open (we need it to compute the relative path)
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return;
	}

	// Get the currently focused text editor. This is null if no file is open
	// (e.g., the user is viewing the Welcome page or Settings UI).
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage('rsync: No active editor.');
		return;
	}

	// `document.uri.fsPath` gives us the absolute file path on disk.
	// (On Windows this uses backslashes; on macOS/Linux, forward slashes.)
	const filePath = editor.document.uri.fsPath;

	// Compute the file's path relative to the workspace root.
	// e.g., workspaceRoot = "/project", filePath = "/project/src/foo.ts"
	//       → relativePath = "src/foo.ts"
	const relativePath = path.relative(workspaceRoot, filePath);

	// If the relative path starts with "..", the file is outside the workspace
	// (e.g., opened via "File > Open…" without being in the workspace tree).
	if (relativePath.startsWith('..')) {
		vscode.window.showErrorMessage('rsync: The active file is outside the workspace.');
		return;
	}

	// Extract the directory portion of the relative path so rsync places the file
	// in the correct subdirectory on the remote.
	// e.g., "src/foo.ts" → destDir = "src"
	const destDir = path.dirname(relativePath);

	// Construct the rsync destination: user@host:/remote/path/src/
	// `path.join` handles the separator between remotePath and destDir portably.
	// Trailing `/` tells rsync the destination is a directory.
	const dest = `${cfg.remoteHost}:${path.join(cfg.remotePath, destDir)}/`;

	// Build the full argument list: [...extraOptions, sourceFile, destination]
	// The spread operator `...cfg.extraOptions` expands the array in place.
	// e.g., if extraOptions = ["-az", "--delete"], then args = ["-az", "--delete", "/project/src/foo.ts", "user@host:/remote/src/"]
	const args = [...cfg.extraOptions, filePath, dest];

	const task = createRsyncTask('Sync Current File', args);
	await vscode.tasks.executeTask(task);
}

/**
 * `rsync.syncProject` command handler.
 *
 * Syncs the entire workspace folder to the remote host. Uses the exclusion
 * patterns from the `rsync.exclude` setting (default: .git, node_modules, out,
 * .vscode-test) to skip files that shouldn't be transferred.
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
	/** Path to the rsync binary, defaults to "rsync" */
	rsyncPath: string;
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
	const rsyncPath = config.get<string>('rsyncPath', 'rsync').trim();
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

	return { remoteHost, remotePath, rsyncPath, extraOptions };
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
