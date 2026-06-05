/// <reference types="node" />

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type OverlayHandle,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import type { ChildProcess } from "child_process";
import { execFile, spawnSync } from "child_process";

import { getDartPackageName, parseLaunchConfigs } from "./launch-parser.js";
import {
	startFlutterRun,
	stopFlutterRun,
	hotReload,
	hotRestart,
	listDevices,
} from "./flutter-runner.js";
import { createVmServiceClient } from "./vm-service.js";
import { DebugOverlayComponent } from "./debug-overlay.js";

export default function (pi: ExtensionAPI) {
	let currentProcess: ChildProcess | null = null;
	let vmService = createVmServiceClient();
	let debugOverlay: DebugOverlayComponent | null = null;
	let overlayHandle: OverlayHandle | null = null;
	let exceptionMode: "None" | "Unhandled" | "All" = "Unhandled";
	let requestOverlayRender = () => {};
	let finishOverlay: (() => void) | null = null;
	let sessionId = 0;

	function isProcessActive(proc: ChildProcess | null): proc is ChildProcess {
		return Boolean(
			proc && proc.exitCode === null && proc.signalCode === null && !proc.killed,
		);
	}

	function copyToClipboard(text: string): void {
		const candidates: Array<[string, string[]]> =
			process.platform === "darwin"
				? [["pbcopy", []]]
				: process.platform === "win32"
					? [["clip.exe", []]]
					: [
						["wl-copy", []],
						["xclip", ["-selection", "clipboard"]],
						["xsel", ["--clipboard", "--input"]],
					];

		for (const [command, args] of candidates) {
			const result = spawnSync(command, args, {
				input: text,
				encoding: "utf8",
				stdio: ["pipe", "ignore", "ignore"],
			});
			if (!result.error && result.status === 0) return;
		}
	}

	function hideOverlayToChat() {
		if (overlayHandle) {
			overlayHandle.setHidden(true);
			overlayHandle.unfocus();
		}
	}

	function closeOverlayOnly() {
		finishOverlay?.();
		finishOverlay = null;
		if (overlayHandle) {
			overlayHandle.hide();
			overlayHandle = null;
		}
	}

	function cleanup() {
		sessionId++;
		closeOverlayOnly();
		debugOverlay?.dispose();
		debugOverlay = null;
		if (currentProcess) {
			stopFlutterRun(currentProcess);
			currentProcess = null;
		}
		vmService.disconnect();
		vmService = createVmServiceClient();
		requestOverlayRender = () => {};
	}

	function showOverlay(ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]) {
		if (!debugOverlay) {
			ctx.ui.notify("No Flutter debug session is active", "warning");
			return;
		}
		if (overlayHandle) {
			if (overlayHandle.isHidden()) {
				overlayHandle.setHidden(false);
				overlayHandle.focus();
				ctx.ui.notify("Flutter debug cockpit reopened", "info");
			} else {
				overlayHandle.focus();
				ctx.ui.notify("Flutter debug cockpit is already open", "info");
			}
			return;
		}
		void ctx.ui
			.custom<void>(
				(tui, _theme, _kb, done) => {
					requestOverlayRender = () => tui.requestRender();
					finishOverlay = () => done(undefined);
					return debugOverlay!;
				},
				{
					overlay: true,
					onHandle: (handle) => {
						overlayHandle = handle;
					},
				},
			)
			.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Debug overlay failed: ${msg}`, "error");
			});
	}

	pi.registerTool(defineTool({
		name: "flutter_debug_state",
		label: "Flutter debug state",
		description: "Return compact state for the active /flutter-run debug session.",
		promptSnippet: "flutter_debug_state(): inspect active Flutter run/debug state",
		parameters: Type.Object({}),
		async execute() {
			const state = {
				running: isProcessActive(currentProcess),
				overlayOpen: Boolean(overlayHandle),
				vmConnected: vmService.connected,
				vmState: vmService.status.state,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
				details: state,
			};
		},
	}));

	pi.registerTool(defineTool({
		name: "flutter_debug_logs",
		label: "Flutter debug logs",
		description: "Return recent retained logs from the active /flutter-run debug session.",
		promptSnippet: "flutter_debug_logs(maxLines?): read recent Flutter logs from active /flutter-run",
		parameters: Type.Object({
			maxLines: Type.Optional(Type.Number({ description: "Max lines to return, capped at 120", default: 80 })),
		}),
		async execute(_id, params) {
			const maxLines = Math.max(1, Math.min(120, Math.floor(params.maxLines ?? 80)));
			const text = debugOverlay?.getOutputText().split("\n").slice(-maxLines).join("\n") ?? "No active Flutter debug logs.";
			return { content: [{ type: "text", text }], details: { maxLines } };
		},
	}));

	pi.registerTool(defineTool({
		name: "flutter_debug_latest_error",
		label: "Flutter latest error",
		description: "Return the latest detected Flutter/Dart/Gradle error block from /flutter-run.",
		promptSnippet: "flutter_debug_latest_error(): read latest detected Flutter error block",
		parameters: Type.Object({}),
		async execute() {
			const text = debugOverlay?.getLatestErrorText() || "No detected Flutter error marker yet.";
			return { content: [{ type: "text", text }], details: { hasError: Boolean(debugOverlay?.getLatestErrorText()) } };
		},
	}));

	pi.registerTool(defineTool({
		name: "flutter_debug_hot_reload",
		label: "Flutter hot reload",
		description: "Run hot reload for the active /flutter-run process.",
		promptSnippet: "flutter_debug_hot_reload(): hot reload active Flutter process",
		parameters: Type.Object({}),
		async execute() {
			if (!isProcessActive(currentProcess)) return { content: [{ type: "text", text: "No active Flutter process." }], details: { sent: false } };
			hotReload(currentProcess);
			return { content: [{ type: "text", text: "Hot reload sent." }], details: { sent: true } };
		},
	}));

	pi.registerTool(defineTool({
		name: "flutter_debug_hot_restart",
		label: "Flutter hot restart",
		description: "Run hot restart for the active /flutter-run process.",
		promptSnippet: "flutter_debug_hot_restart(): hot restart active Flutter process",
		parameters: Type.Object({}),
		async execute() {
			if (!isProcessActive(currentProcess)) return { content: [{ type: "text", text: "No active Flutter process." }], details: { sent: false } };
			hotRestart(currentProcess);
			return { content: [{ type: "text", text: "Hot restart sent." }], details: { sent: true } };
		},
	}));

	pi.registerTool(defineTool({
		name: "flutter_debug_stop",
		label: "Flutter stop",
		description: "Stop the active /flutter-run process and close the debug overlay.",
		promptSnippet: "flutter_debug_stop(): stop active Flutter process",
		parameters: Type.Object({}),
		async execute() {
			cleanup();
			return { content: [{ type: "text", text: "Flutter debug session stopped." }], details: { stopped: true } };
		},
	}));

	pi.registerCommand("flutter-run", {
		description:
			"Select a Flutter launch config, run the app with full debug controls",
		handler: async (_args, ctx) => {
		if (isProcessActive(currentProcess) && debugOverlay) {
				showOverlay(ctx);
				ctx.ui.notify("Reopened Flutter debug cockpit. Press m/Tab for chat mode.", "info");
				return;
			}

			// Parse launch.json and pubspec metadata
			const configs = parseLaunchConfigs(ctx.cwd);
			const packageName = getDartPackageName(ctx.cwd) ?? "";
			if (configs.length === 0) {
				ctx.ui.notify(
					"No Flutter (dart) configurations found in .vscode/launch.json",
					"error",
				);
				return;
			}

			// Build select items
			const items = configs.map((cfg) => ({
				value: cfg.name,
				label: `${cfg.name} [${cfg.flavor}]`,
				description: `${cfg.mode} · APP_ENV=${cfg.env} · ${cfg.program}`,
			}));

			// Show selection UI
			const selected = await ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) => {
					const container = new Container();

					container.addChild(
						new Text(
							theme.fg("accent", theme.bold("🚀 Flutter Run Configuration")),
							1,
							1,
						),
					);
					container.addChild(new Text("", 0, 0));

					const selectList = new SelectList(
						items,
						Math.min(items.length + 3, 12),
						{
							selectedPrefix: (t: string) => theme.fg("accent", t),
							selectedText: (t: string) => theme.fg("accent", t),
							description: (t: string) => theme.fg("muted", t),
							scrollInfo: (t: string) => theme.fg("dim", t),
							noMatch: (t: string) => theme.fg("warning", t),
						},
					);

					selectList.onSelect = (item: { value: string; label: string }) =>
						done(item.value);
					selectList.onCancel = () => done(null);
					container.addChild(selectList);

					container.addChild(new Text("", 0, 0));
					container.addChild(
						new Text(
							theme.fg("dim", "↑↓ navigate · enter select · esc cancel"),
							1,
							0,
						),
					);

					return {
						render: (w: number) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				},
			);

			if (!selected) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const config = configs.find((c) => c.name === selected);
			if (!config) {
				ctx.ui.notify(`Config "${selected}" not found`, "error");
				return;
			}

			// Select device when multiple devices are available; avoids flutter run hanging on stdin prompt.
			let deviceId: string | undefined;
			const devices = await listDevices();
			if (devices.length === 0) {
				ctx.ui.notify(
					"No Flutter devices found. Start an emulator/simulator or connect a device, then run /flutter-run again.",
					"error",
				);
				return;
			}
			if (devices.length === 1) {
				deviceId = devices[0].id;
			} else if (devices.length > 1) {
				const deviceItems = devices.map((device) => ({
					value: device.id,
					label: `${device.name} [${device.id}]`,
					description: `${device.platform}${device.emulator ? " · emulator" : ""}`,
				}));
				const selectedDevice = await ctx.ui.custom<string | null>(
					(tui, theme, _kb, done) => {
						const container = new Container();
						container.addChild(
							new Text(
								theme.fg("accent", theme.bold("📱 Flutter Device")),
								1,
								1,
							),
						);
						const selectList = new SelectList(
							deviceItems,
							Math.min(deviceItems.length + 2, 10),
							{
								selectedPrefix: (t: string) => theme.fg("accent", t),
								selectedText: (t: string) => theme.fg("accent", t),
								description: (t: string) => theme.fg("muted", t),
								scrollInfo: (t: string) => theme.fg("dim", t),
								noMatch: (t: string) => theme.fg("warning", t),
							},
						);
						selectList.onSelect = (item: {
							value: string;
							label: string;
							description?: string;
						}) => done(item.value);
						selectList.onCancel = () => done(null);
						container.addChild(selectList);
						container.addChild(
							new Text(
								theme.fg("dim", "↑↓ navigate · enter select · esc cancel"),
								1,
								0,
							),
						);
						return {
							render: (w: number) => container.render(w),
							invalidate: () => container.invalidate(),
							handleInput: (data: string) => {
								selectList.handleInput(data);
								tui.requestRender();
							},
						};
					},
				);
				if (!selectedDevice) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}
				deviceId = selectedDevice;
			}

			// Cleanup any previous run
			cleanup();
			const activeSessionId = ++sessionId;
			const isCurrentSession = () => activeSessionId === sessionId;

			// Start flutter run
			ctx.ui.notify(
				`Starting: ${config.name}${deviceId ? ` on ${deviceId}` : ""}...`,
				"info",
			);

			try {
				const result = startFlutterRun(config, { deviceId, cwd: ctx.cwd });
				currentProcess = result.process;

				let pollInterval: ReturnType<typeof setInterval> | undefined;
				let processClosed = false;
				let closedCode: number | null = null;
				const forwardOutput = () => {
					if (!isCurrentSession()) return;
					for (const line of result.outputBuffer) {
						debugOverlay?.addOutputLine(line);
					}
					result.outputBuffer.length = 0;
				};

				// Register close handler immediately; child process may exit before UI setup finishes.
				result.process.once("close", (code) => {
					if (!isCurrentSession()) return;
					processClosed = true;
					closedCode = code;
					currentProcess = null;
					if (pollInterval) clearInterval(pollInterval);
					forwardOutput();
					vmService.disconnect();
					debugOverlay?.addOutputLine(`── Flutter exited (code ${code}) ──`);
					ctx.ui.notify(`Flutter exited (code ${code})`, "info");
				});

				// Create debug overlay first (will update as we connect)
				debugOverlay = new DebugOverlayComponent(vmService, {
					onContinue: () => {
						if (vmService.connected) {
							if (vmService.status.state === "paused") {
								void vmService.resume();
							} else {
								void vmService.pause();
							}
						}
					},
					onStepOver: () => {
						void vmService.stepOver();
					},
					onStepInto: () => {
						void vmService.stepInto();
					},
					onStepOut: () => {
						void vmService.stepOut();
					},
					onHotReload: () => {
						if (currentProcess) {
							hotReload(currentProcess);
						}
					},
					onHotRestart: () => {
						if (currentProcess) {
							hotRestart(currentProcess);
						}
					},
					onQuit: () => {
						ctx.ui.notify("Stopping Flutter...", "info");
						finishOverlay?.();
						cleanup();
					},
					onClose: () => {
						hideOverlayToChat();
						ctx.ui.notify("Cockpit hidden. Use /flutter-run to reopen.", "info");
					},
					onAddBreakpoint: (file, line) => {
						if (!vmService.connected) return;
						// Need full script URI: search breakpoints for matching file
						void vmService.getBreakpoints().then(() => {
							// Try to find the script URI from existing breakpoints or just use the filename
							// VM Service needs full URI like "file:///path/to/lib/main.dart" or "package:myapp/main.dart"
							// We'll try both package: and file: URIs
							const normalizedFile = file.replace(/^lib\//, "");
							const candidates = [
								file.startsWith("package:") || file.startsWith("file://")
									? file
									: undefined,
								packageName
									? `package:${packageName}/${normalizedFile}`
									: undefined,
								`file://${ctx.cwd}/lib/${normalizedFile}`,
								`file://${ctx.cwd}/${file}`,
							].filter((uri): uri is string => Boolean(uri));
							void tryAddBreakpoint(candidates, line);
						});
					},
					onRemoveBreakpoint: (id) => {
						void vmService.removeBreakpoint(id);
					},
					onToggleExceptionMode: () => {
						const modes: Array<"None" | "Unhandled" | "All"> = [
							"None",
							"Unhandled",
							"All",
						];
						const idx = modes.indexOf(exceptionMode);
						exceptionMode = modes[(idx + 1) % modes.length];
						debugOverlay?.setExceptionMode(exceptionMode);
						void vmService.setExceptionPauseMode(exceptionMode);
						ctx.ui.notify(`Exception mode: ${exceptionMode}`, "info");
					},
					onCopyOutput: (text) => {
						copyToClipboard(text);
						ctx.ui.notify("Flutter logs copied to clipboard", "info");
					},
					onAskAgent: (prompt) => {
						try {
							if (ctx.isIdle()) {
								pi.sendUserMessage(prompt);
							} else {
								pi.sendUserMessage(prompt, { deliverAs: "followUp" });
							}
							ctx.ui.notify("Flutter diagnostic prompt sent to agent. Cockpit hidden; use /flutter-run to reopen.", "info");
							hideOverlayToChat();
						} catch (err) {
							ctx.ui.setEditorText(prompt);
							const msg = err instanceof Error ? err.message : String(err);
							ctx.ui.notify(`Could not send to agent; pasted into editor: ${msg}`, "warning");
							hideOverlayToChat();
						}
					},
					onPastePrompt: (prompt) => {
						hideOverlayToChat();
						ctx.ui.setEditorText(prompt);
						ctx.ui.notify("Flutter diagnostic prompt pasted into editor. Use /flutter-run to reopen cockpit.", "info");
					},
					onChatMode: () => {
						hideOverlayToChat();
						ctx.ui.notify("Flutter keeps running in chat mode. Use /flutter-run to reopen cockpit.", "info");
					},
					onRenderRequested: () => requestOverlayRender(),
				});

				showOverlay(ctx);

				// Poll output every 500ms while process is alive.
				if (!processClosed) {
					pollInterval = setInterval(() => {
						if (!isCurrentSession()) {
							if (pollInterval) clearInterval(pollInterval);
							return;
						}
						forwardOutput();
						requestOverlayRender();
					}, 500);
				} else {
					forwardOutput();
					debugOverlay.addOutputLine(
						`── Flutter exited (code ${closedCode}) ──`,
					);
				}

				// Continue the slow build/VM attach flow in the background so the command
				// returns immediately. This lets /flutter-run reopen a hidden cockpit while
				// Gradle/Xcode is still building instead of blocking until VM Service appears.
				ctx.ui.notify("Waiting for VM service...", "info");
				debugOverlay.addOutputLine("── Waiting for Flutter build ──");
				void (async () => {
					try {
						const vmUri = await result.vmServiceUri;
						if (!isCurrentSession()) return;
						ctx.ui.notify(`VM Service: ${vmUri}`, "info");
						debugOverlay?.addOutputLine(`── VM Service: ${vmUri} ──`);

						// Connect VM service
						await vmService.connect(vmUri);
						if (!isCurrentSession()) return;
						ctx.ui.notify("Debugger connected ✓", "info");
						debugOverlay?.addOutputLine("── Debugger connected ──");

						// Set initial exception mode
						void vmService.setExceptionPauseMode(exceptionMode);

						// Try to open DevTools
						try {
							const dtUrl = await result.devToolsUrl;
							if (!isCurrentSession()) return;
							if (dtUrl) {
								ctx.ui.notify(`DevTools: ${dtUrl}`, "info");
								debugOverlay?.addOutputLine(`── DevTools: ${dtUrl} ──`);
								execFile("open", [dtUrl]);
							}
						} catch {
							// DevTools URL not found
						}

						// Get breakpoints from server
						void vmService.getBreakpoints().then(() => {
							if (isCurrentSession()) requestOverlayRender();
						});
					} catch (err: unknown) {
						if (!isCurrentSession()) return;
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`Failed: ${msg}`, "error");
						debugOverlay?.addOutputLine(`── ERROR: ${msg} ──`);
					}
				})();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed: ${msg}`, "error");
				debugOverlay?.addOutputLine(`── ERROR: ${msg} ──`);
				// Don't cleanup — let user see error in overlay
			}

			// Helper to try multiple URIs for breakpoints
			async function tryAddBreakpoint(
				candidates: string[],
				line: number,
			): Promise<void> {
				for (const uri of candidates) {
					try {
						await vmService.addBreakpoint(uri, line);
						ctx.ui.notify(`Breakpoint added: ${uri}:${line}`, "info");
						debugOverlay?.addOutputLine(`── Breakpoint set: ${uri}:${line} ──`);
						return;
					} catch {
						// try next candidate
					}
				}
				ctx.ui.notify(
					`Failed to add breakpoint. Try full URI: file:///path/to/file.dart:${line}`,
					"warning",
				);
			}
		},
	});

	// Cleanup on session shutdown
	pi.on("session_shutdown", () => {
		cleanup();
	});
}
