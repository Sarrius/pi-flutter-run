/// <reference types="node" />

import { spawn, execFile, type ChildProcess } from "child_process";
import type { FlutterConfig } from "./launch-parser.js";

export interface FlutterRunResult {
	/** The spawned Flutter process */
	process: ChildProcess;
	/** Parsed VM Service URI (e.g., http://127.0.0.1:54321/xxx/) */
	vmServiceUri: Promise<string>;
	/** DevTools URL, if Flutter prints one shortly after launch */
	devToolsUrl: Promise<string | null>;
	/** Accumulated output lines for display */
	outputBuffer: string[];
}

export interface FlutterDevice {
	id: string;
	name: string;
	platform: string;
	emulator: boolean;
}

// ── URI Extraction ─────────────────────────────────────

// Dart VM Service URI: http://IP:PORT/RANDOM/ — no query params, always has trailing slash.
// The negative lookahead (?!\?) ensures we don't match DevTools URLs with query params.
const VM_SERVICE_RE = /(https?:\/\/[\w.-]+:\d+\/[A-Za-z0-9_=\-/]+\/)(?!\?)/;
const DEVTOOLS_RE =
	/(?:DevTools|debugger and profiler).*?(https?:\/\/[\w./:\-?=&#]+)/;
const BUILD_FAILED_RE = /BUILD FAILED/;

// Patterns that indicate the app cannot be launched (code signing, entitlements, etc.)
// These fire BEFORE the 120s timeout for immediate user feedback.
const LAUNCH_FAILED_RES = [
	/Unable to launch/i,
	/invalid code signature/i,
	/inadequate entitlements/i,
	/profile has not been explicitly trusted/i,
	/Error launching application/i,
	/The Dart VM Service was not discovered after/i,
	/Failed to (spawn|launch|start)/i,
	/No supported devices found/i,
	/Could not run/i,
];

// Flutter 3.38+ outputs "VM Service" (capital S). Detection must be case-insensitive.
const VM_SERVICE_TEXT_RE =
	/(?:Dart )?VM [Ss]ervice.*?(https?:\/\/[\w.-]+:\d+\/[A-Za-z0-9_=\-/]+\/)/;

function isProcessAlive(proc: ChildProcess): boolean {
	return proc.exitCode === null && proc.signalCode === null && !proc.killed;
}

export function normalizeVmServiceHttpUri(uri: string): string {
	return uri.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/ws\/?$/, "/");
}

function parseMachineEvents(line: string): any[] {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return [];
	try {
		const parsed = JSON.parse(trimmed);
		const events = Array.isArray(parsed) ? parsed : [parsed];
		return events.filter(
			(event) => event && typeof event === "object" && "event" in event,
		);
	} catch {
		return [];
	}
}

// ── Command Builder ────────────────────────────────────

export interface FlutterRunOptions {
	deviceId?: string;
	cwd?: string;
}

export function buildFlutterCommand(
	config: FlutterConfig,
	options: FlutterRunOptions = {},
): {
	command: string;
	args: string[];
	env: Record<string, string>;
} {
	const args = ["run"];

	// Mode
	if (config.mode === "release") {
		args.push("--release");
	} else {
		args.push("--debug");
	}

	// Machine mode — provides structured JSON events for reliable URI extraction
	args.push("--machine");

	// Device
	if (options.deviceId) {
		args.push("-d", options.deviceId);
	}

	// Target
	args.push("-t", config.program);

	// Flavor and dart-defines
	args.push(...config.flutterArgs);

	return {
		command: "flutter",
		args,
		env: { ...process.env, ...config.envVars } as Record<string, string>,
	};
}

// ── Device Listing ─────────────────────────────────────

export async function listDevices(): Promise<FlutterDevice[]> {
	return new Promise((resolve) => {
		execFile(
			"flutter",
			["devices", "--machine"],
			{ timeout: 30_000 },
			(err, stdout) => {
				if (err || !stdout) {
					// Fallback to non-machine output
					execFile(
						"flutter",
						["devices"],
						{ timeout: 30_000 },
						(_err2, stdOut2) => {
							if (!stdOut2) return resolve([]);
							const lines = stdOut2.split("\n");
							const devices: FlutterDevice[] = [];
							let inDeviceSection = false;
							for (const line of lines) {
								if (
									line.includes("connected device") ||
									line.includes("Connected devices")
								) {
									inDeviceSection = true;
									continue;
								}
								if (inDeviceSection && line.trim()) {
									// Parse: "iPhone 15 (mobile) • 12345-67890 • ios • iOS 17.0"
									const parts = line.split("•").map((p) => p.trim());
									if (parts.length >= 3) {
										const namePart = parts[0].replace(/\s*\(mobile\)\s*/, "");
										devices.push({
											id: parts[1],
											name: namePart,
											platform: parts[2].split(" ")[0].toLowerCase(),
											emulator:
												parts[0].includes("simulator") ||
												parts[0].includes("emulator") ||
												parts[0].includes("(mobile)"),
										});
									}
								}
							}
							resolve(devices);
						},
					);
					return;
				}
				try {
					const parsed = JSON.parse(stdout);
					resolve(
						(parsed || []).map((d: any) => ({
							id: d.id,
							name: d.name,
							platform: d.targetPlatform || d.platform || "unknown",
							emulator: d.emulator ?? false,
						})),
					);
				} catch {
					resolve([]);
				}
			},
		);
	});
}

// ── Process Management ─────────────────────────────────

export function startFlutterRun(
	config: FlutterConfig,
	options: FlutterRunOptions = {},
): FlutterRunResult {
	const { command, args, env } = buildFlutterCommand(config, options);
	const outputBuffer: string[] = [];

	let vmServiceResolve: (uri: string) => void;
	let vmServiceReject: (err: Error) => void;
	const vmServiceUri = new Promise<string>((resolve, reject) => {
		vmServiceResolve = resolve;
		vmServiceReject = reject;
	});

	let devToolsResolve: ((url: string | null) => void) | null = null;
	const devToolsUrl = new Promise<string | null>((resolve) => {
		devToolsResolve = resolve;
	});

	let vmServiceFound = false;
	let vmServiceSettled = false;
	const resolveVmService = (uri: string) => {
		if (vmServiceSettled) return;
		vmServiceSettled = true;
		vmServiceFound = true;
		vmServiceResolve(normalizeVmServiceHttpUri(uri));
	};
	const rejectVmService = (err: Error) => {
		if (vmServiceSettled) return;
		vmServiceSettled = true;
		vmServiceReject(err);
	};

	const proc = spawn(command, args, {
		env,
		stdio: ["pipe", "pipe", "pipe"],
		cwd: options.cwd || process.env.FLUTTER_PROJECT_DIR || process.cwd(),
	});

	let stdoutBuffer = "";

	let devToolsFound = false;

	function emitLine(line: string): void {
		lastOutputAt = Date.now();
		// In --machine mode, lines may be JSON objects or arrays like [{...}].
		// Parse without string slicing so array-wrapped events do not break URI detection.
		const machineEvents = parseMachineEvents(line);
		if (machineEvents.length > 0) {
			for (const event of machineEvents) {
				handleMachineEvent(event);
				outputBuffer.push(`[flutter] machine event: ${event.event}`);
			}
			return;
		}

		// Plain text output
		outputBuffer.push(line);

		// Extract DevTools URL first (more specific pattern)
		if (!devToolsFound) {
			const dtMatch = line.match(DEVTOOLS_RE);
			if (dtMatch && dtMatch[1] && devToolsResolve) {
				devToolsFound = true;
				devToolsResolve(dtMatch[1]);
			}
		}

		// Extract VM Service URI from text — backup for when machine events aren't parsed
		if (!vmServiceFound) {
			const vmMatch = line.match(VM_SERVICE_RE);
			if (vmMatch && vmMatch[1]) {
				resolveVmService(vmMatch[1]);
			}
		}

		// Detect build failure
		if (BUILD_FAILED_RE.test(line)) {
			rejectVmService(new Error("Build failed. Check output for details."));
		}

		// Detect launch failures from human-readable lines
		for (const re of LAUNCH_FAILED_RES) {
			if (re.test(line)) {
				rejectVmService(
					new Error(
						`Launch failed: ${line}\n\nFull output:\n${outputBuffer.slice(-20).join("\n")}`,
					),
				);
				return;
			}
		}

		// Extract VM Service URI from human-readable lines (case-insensitive, Flutter 3.38+ compat)
		if (!vmServiceFound) {
			const vmTextMatch = line.match(VM_SERVICE_TEXT_RE);
			if (vmTextMatch && vmTextMatch[1]) {
				resolveVmService(vmTextMatch[1]);
			}
		}
	}

	function handleMachineEvent(event: any): void {
		// app.debugPort: contains the VM service WebSocket URI
		if (!vmServiceFound && event.event === "app.debugPort") {
			const uri = event.params?.wsUri ?? event.params?.uri;
			if (uri) {
				resolveVmService(uri);
			}
		}

		// app.webLaunchUrl: contains the DevTools URL
		if (!devToolsFound && event.event === "app.webLaunchUrl") {
			const url = event.params?.url;
			if (url && devToolsResolve) {
				devToolsFound = true;
				devToolsResolve(url);
			}
		}

		// app.stop: if error, reject. Also reject if VM service never started (app crashed).
		if (event.event === "app.stop") {
			if (event.params?.error) {
				rejectVmService(new Error(`Flutter error: ${event.params.error}`));
			} else if (!vmServiceFound) {
				rejectVmService(
					new Error(
						`App stopped before VM service started. The app may have crashed on launch.\nLast output:\n${outputBuffer.slice(-15).join("\n")}`,
					),
				);
			}
		}

		// Severe errors
		if (event.level === "error" || event.level === "severe") {
			const errMsg = event.message || JSON.stringify(event);
			rejectVmService(new Error(errMsg));
		}
	}

	proc.stdout?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		stdoutBuffer += text;
		const parts = stdoutBuffer.split("\n");
		stdoutBuffer = parts.pop() || "";

		for (const part of parts) {
			const trimmed = part.trim();
			if (trimmed) emitLine(trimmed);
		}
	});

	proc.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString().trim();
		if (text) {
			lastOutputAt = Date.now();
			outputBuffer.push(`[stderr] ${text}`);
		}
	});

	proc.on("error", (err) => {
		rejectVmService(new Error(`Failed to spawn flutter: ${err.message}`));
		devToolsResolve?.(null);
	});

	proc.on("close", (code) => {
		if (stdoutBuffer.trim()) {
			const trimmed = stdoutBuffer.trim();
			emitLine(trimmed);
		}
		devToolsResolve?.(null);
		if (code !== 0 && code !== null) {
			rejectVmService(
				new Error(
					`Flutter exited with code ${code}.\nLast output:\n${outputBuffer.slice(-15).join("\n")}`,
				),
			);
		} else if (!vmServiceFound) {
			// Process exited cleanly but VM service was never found
			// (e.g., app crashed silently, flutter exited on its own, etc.)
			rejectVmService(
				new Error(
					`Flutter exited (code ${code}) without VM service starting.\nLast output:\n${outputBuffer.slice(-15).join("\n")}`,
				),
			);
		}
	});

	// Build/launch progress watcher. Do not fail only because Flutter is quiet:
	// Gradle/Xcode can legitimately spend multiple minutes without stdout.
	// Real failures are handled by explicit error patterns or process exit.
	const QUIET_WARNING_MS = 120_000;
	let lastOutputAt = Date.now();
	let lastQuietWarningAt = 0;

	const progressInterval = setInterval(() => {
		if (vmServiceFound) return;

		const quietForMs = Date.now() - lastOutputAt;
		const shouldWarnQuiet =
			quietForMs >= QUIET_WARNING_MS &&
			Date.now() - lastQuietWarningAt >= QUIET_WARNING_MS;
		if (shouldWarnQuiet && isProcessAlive(proc)) {
			lastQuietWarningAt = Date.now();
			outputBuffer.push(
				`── Flutter is still running but has produced no output for ${Math.floor(quietForMs / 1000)}s. Build may simply be slow; waiting. ──`,
			);
		}
	}, 15_000);

	const devToolsTimeout = setTimeout(() => {
		devToolsResolve?.(null);
	}, 15_000);

	function cleanupVmTimers(): void {
		clearInterval(progressInterval);
	}

	vmServiceUri.then(cleanupVmTimers).catch(cleanupVmTimers);
	devToolsUrl.finally(() => clearTimeout(devToolsTimeout));

	return {
		process: proc,
		vmServiceUri,
		devToolsUrl,
		outputBuffer,
	};
}

export function stopFlutterRun(proc: ChildProcess): void {
	if (!isProcessAlive(proc)) return;

	// Graceful quit via stdin
	try {
		proc.stdin?.write("q\n");
	} catch {
		// stdin may not be available
	}

	// Fallback: SIGTERM after 3s
	setTimeout(() => {
		if (isProcessAlive(proc)) {
			proc.kill("SIGTERM");
			// Force kill after another 2s
			setTimeout(() => {
				if (isProcessAlive(proc)) proc.kill("SIGKILL");
			}, 2000);
		}
	}, 3000);
}

export function hotReload(proc: ChildProcess): void {
	if (!isProcessAlive(proc)) return;
	try {
		proc.stdin?.write("r\n");
	} catch {
		// ignore
	}
}

export function hotRestart(proc: ChildProcess): void {
	if (!isProcessAlive(proc)) return;
	try {
		proc.stdin?.write("R\n");
	} catch {
		// ignore
	}
}
