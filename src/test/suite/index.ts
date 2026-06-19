import * as path from 'path';
import * as fs from 'fs';

export async function run(): Promise<void> {
	// Create a Mocha instance. @vscode/test-electron bundles Mocha as a
	// transitive dependency; when running inside the Extension Development Host,
	// Mocha is available via VS Code's test infrastructure.
	const Mocha = require('mocha');
	const mocha = new Mocha({
		ui: 'tdd',
		color: true,
	});

	const testsRoot = path.resolve(__dirname, '..');

	// Discover all .test.js files recursively under the test output directory.
	function findTestFiles(dir: string): string[] {
		const results: string[] = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...findTestFiles(fullPath));
			} else if (entry.name.endsWith('.test.js')) {
				results.push(fullPath);
			}
		}
		return results;
	}

	const files = findTestFiles(testsRoot);
	files.forEach(f => mocha.addFile(f));

	return new Promise<void>((resolve, reject) => {
		mocha.run((failures: number) => {
			if (failures > 0) {
				reject(new Error(`${failures} tests failed.`));
			} else {
				resolve();
			}
		});
	});
}
