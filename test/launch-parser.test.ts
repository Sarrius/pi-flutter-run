import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDartPackageName, parseLaunchConfigs } from "../launch-parser.ts";

function project(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writeLaunchJson(projectDir: string, content: string): void {
	mkdirSync(join(projectDir, ".vscode"), { recursive: true });
	writeFileSync(join(projectDir, ".vscode", "launch.json"), content, "utf8");
}

test("getDartPackageName reads a Dart package name and ignores a missing pubspec", () => {
	const projectDir = project("pi-flutter-run-package-");
	try {
		assert.equal(getDartPackageName(projectDir), null);
		writeFileSync(join(projectDir, "pubspec.yaml"), "description: test\nname: sample_app\n", "utf8");
		assert.equal(getDartPackageName(projectDir), "sample_app");
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
	}
});

test("parseLaunchConfigs accepts JSONC, preserves string literals, and selects Dart configurations", () => {
	const projectDir = project("pi-flutter-run-launch-");
	const previousApiUrl = process.env.TEST_API_URL;
	try {
		process.env.TEST_API_URL = "https://example.test/api";
		writeLaunchJson(projectDir, `{
			// JSONC comments and trailing commas are valid in VS Code launch files.
			"configurations": [
				{
					"name": "Flutter prod // literal",
					"type": "dart",
					"flutterMode": "release",
					"program": "lib/main_prod.dart",
					"deviceId": "emulator-5554",
					"env": { "API_URL": "\${env:TEST_API_URL}" },
					"args": ["--dart-define", "APP_ENV=prod", "--flavor", "production", "--verbose",],
				},
				{ "name": "Node", "type": "node" },
			],
		}`);

		assert.deepEqual(parseLaunchConfigs(projectDir), [{
			name: "Flutter prod // literal",
			mode: "release",
			flavor: "production",
			env: "prod",
			program: "lib/main_prod.dart",
			args: ["--dart-define", "APP_ENV=prod", "--flavor", "production", "--verbose"],
			flutterArgs: ["--dart-define", "APP_ENV=prod", "--flavor", "production", "--verbose"],
			envVars: { API_URL: "https://example.test/api" },
			deviceId: "emulator-5554",
		}]);
	} finally {
		if (previousApiUrl === undefined) delete process.env.TEST_API_URL;
		else process.env.TEST_API_URL = previousApiUrl;
		rmSync(projectDir, { recursive: true, force: true });
	}
});

test("parseLaunchConfigs fails closed for missing or invalid launch files", () => {
	const projectDir = project("pi-flutter-run-invalid-");
	try {
		assert.deepEqual(parseLaunchConfigs(projectDir), []);
		writeLaunchJson(projectDir, "{ invalid json");
		assert.deepEqual(parseLaunchConfigs(projectDir), []);
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
	}
});
