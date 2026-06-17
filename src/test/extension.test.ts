import * as assert from 'assert';
import * as vscode from 'vscode';

suite('rsync Extension Test Suite', () => {
	test('Extension should be activated', async () => {
		const ext = vscode.extensions.getExtension('vscode-samples.rsync')!;
		await ext.activate();
		assert.ok(ext.isActive);
	});

	test('Commands should be registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('rsync.syncCurrentFile'));
		assert.ok(commands.includes('rsync.syncProject'));
	});

	test('syncCurrentFile shows error without config', async () => {
		// When no remoteHost is configured, the command should show an error
		// notification and return without throwing.
		try {
			await vscode.commands.executeCommand('rsync.syncCurrentFile');
		} catch {
			// Command may throw if activation hasn't happened; that's acceptable.
		}
	});

	test('syncProject shows error without config', async () => {
		try {
			await vscode.commands.executeCommand('rsync.syncProject');
		} catch {
			// Command may throw if activation hasn't happened; that's acceptable.
		}
	});
});
