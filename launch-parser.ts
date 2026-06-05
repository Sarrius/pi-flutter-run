/// <reference types="node" />

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface FlutterConfig {
	name: string;
	mode: string; // "debug" | "release"
	flavor: string;
	env: string; // "dev" | "sim" | "prod"
	program: string;
	args: string[];
	envVars: Record<string, string>;
	flutterArgs: string[];
}

/**
 * Parse a VS Code launch.json and return Flutter (dart) configurations.
 * Resolves env vars like ${env:VAR} and ${env:PATH}.
 */
export function getDartPackageName(projectDir: string): string | null {
	const pubspecPath = path.join(projectDir, "pubspec.yaml");
	if (!fs.existsSync(pubspecPath)) return null;
	const content = fs.readFileSync(pubspecPath, "utf-8");
	const match = content.match(/^name:\s*([A-Za-z0-9_]+)\s*$/m);
	return match?.[1] ?? null;
}

export function parseLaunchConfigs(projectDir: string): FlutterConfig[] {
	const launchPath = path.join(projectDir, ".vscode", "launch.json");

	if (!fs.existsSync(launchPath)) {
		return [];
	}

	const raw = JSON.parse(fs.readFileSync(launchPath, "utf-8"));
	const configs: FlutterConfig[] = [];

	for (const cfg of raw.configurations || []) {
		if (cfg.type !== "dart") continue;

		// Resolve env vars
		const envVars: Record<string, string> = {};
		if (cfg.env) {
			for (const [key, val] of Object.entries(
				cfg.env as Record<string, string>,
			)) {
				envVars[key] = resolveEnvVar(val as string);
			}
		}

		// Extract --dart-define and --flavor from args
		const args: string[] = cfg.args || [];
		const flutterArgs: string[] = [];
		let flavor = "";
		let env = "";

		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--dart-define" && i + 1 < args.length) {
				const define = args[i + 1];
				if (define.startsWith("APP_ENV=")) {
					env = define.slice("APP_ENV=".length);
				}
				flutterArgs.push("--dart-define", define);
				i++;
			} else if (args[i] === "--flavor" && i + 1 < args.length) {
				flavor = args[i + 1];
				flutterArgs.push("--flavor", flavor);
				i++;
			} else {
				flutterArgs.push(args[i]);
			}
		}

		configs.push({
			name: cfg.name,
			mode: cfg.flutterMode || "debug",
			flavor,
			env,
			program: cfg.program || "lib/main.dart",
			args: flutterArgs,
			envVars,
			flutterArgs,
		});
	}

	return configs;
}

/**
 * Resolve env var references like ${env:VAR_NAME} using process.env.
 */
function resolveEnvVar(value: string): string {
	return value.replace(/\$\{env:([^}]+)\}/g, (_, varName) => {
		if (varName === "PATH") return process.env.PATH || os.homedir();
		return process.env[varName] || "";
	});
}
