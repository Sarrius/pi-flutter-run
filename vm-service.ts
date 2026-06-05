/**
 * Full Dart VM Service Protocol client (JSON-RPC 2.0 over WebSocket).
 *
 * Coverage: breakpoints, variables, evaluation, exception modes, stack frames.
 * Protocol ref: https://github.com/dart-lang/sdk/blob/main/runtime/vm/service/service.md
 */

// Minimal WebSocket interface — avoids dependency on 'ws' types for pi-lens compatibility
interface WsSocket {
	on(event: "open" | "close" | "error", cb: (...args: unknown[]) => void): void;
	on(event: "message", cb: (data: unknown) => void): void;
	removeListener(event: string, cb: (...args: unknown[]) => void): void;
	send(data: string): void;
	close(): void;
}

function websocketMessageToString(raw: unknown): string {
	if (typeof raw === "string") return raw;
	if (raw instanceof Buffer) return raw.toString();
	if (raw && typeof raw === "object" && "data" in raw) {
		const data = (raw as { data: unknown }).data;
		return websocketMessageToString(data);
	}
	return String(raw);
}

// ── Types ──────────────────────────────────────────────

interface RpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: any;
	error?: { code: number; message: string; data?: any };
}

export type DebugState = "running" | "paused" | "unknown";

export interface DebugStatus {
	state: DebugState;
	isolateId?: string;
	breakpointInfo?: string;
}

export interface Breakpoint {
	id: string;
	breakpointNumber: number;
	location: {
		scriptUri: string;
		tokenPos: number;
		line?: number;
	};
	resolved: boolean;
}

export interface StackFrame {
	index: number;
	name: string;
	owner: string; // library or class
	location: string; // file:line
	scriptUri: string;
	line?: number;
}

export interface Variable {
	name: string;
	value: string;
	type: string;
}

export type ExceptionMode = "None" | "Unhandled" | "All";

export interface BreakpointsChangedEvent {
	added: Breakpoint[];
	removed: Breakpoint[];
	all: Breakpoint[];
}

export interface VmServiceClient {
	readonly status: DebugStatus;
	onStatusChange: (cb: (status: DebugStatus) => void) => () => void;
	onBreakpointsChanged: (
		cb: (event: BreakpointsChangedEvent) => void,
	) => () => void;

	connect(uri: string): Promise<void>;
	disconnect(): void;
	readonly connected: boolean;

	// Debug controls
	resume(): Promise<void>;
	pause(): Promise<void>;
	stepOver(): Promise<void>;
	stepInto(): Promise<void>;
	stepOut(): Promise<void>;

	// Breakpoints
	addBreakpoint(scriptUri: string, line: number): Promise<Breakpoint>;
	removeBreakpoint(breakpointId: string): Promise<void>;
	getBreakpoints(): Promise<Breakpoint[]>;
	setExceptionPauseMode(mode: ExceptionMode): Promise<void>;

	// Diagnostics
	getStackFrames(): Promise<StackFrame[]>;
	getVariables(frameIndex?: number): Promise<Variable[]>;
	evaluate(expression: string, frameIndex?: number): Promise<string>;
}

// ── Implementation ────────────────────────────────────

export function createVmServiceClient(): VmServiceClient {
	let socket: WsSocket | null = null;
	let nextId = 1;
	let connected = false;
	let isolateId: string | undefined;
	let currentState: DebugState = "unknown";
	let breakpoints: Breakpoint[] = [];
	const scriptLineCache = new Map<string, Map<number, number>>();

	const statusListeners = new Set<(s: DebugStatus) => void>();
	const bpListeners = new Set<(e: BreakpointsChangedEvent) => void>();

	// ── WebSocket helpers ──

	async function getWs(): Promise<{ new (url: string): WsSocket }> {
		try {
			const mod = await import("ws");
			return (mod.default || mod) as { new (url: string): WsSocket };
		} catch {
			throw new Error(
				"WebSocket library not found. Run: npm install in ~/.pi/agent/extensions/flutter-run/",
			);
		}
	}

	function notifyStatus() {
		for (const cb of statusListeners) {
			cb({ state: currentState, isolateId });
		}
	}

	function notifyBreakpoints(added: Breakpoint[], removed: Breakpoint[]) {
		for (const cb of bpListeners) {
			cb({ added, removed, all: [...breakpoints] });
		}
	}

	function sendRequest(
		method: string,
		params?: Record<string, any>,
	): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!socket || !connected) {
				reject(new Error("Not connected to VM service"));
				return;
			}

			const sock = socket;
			const id = nextId++;
			const payload = JSON.stringify({
				jsonrpc: "2.0",
				id,
				method,
				params: params || {},
			});

			function onMessage(raw: unknown) {
				const data = websocketMessageToString(raw);
				try {
					const msg = JSON.parse(data) as RpcResponse;
					if (msg.id !== id) return;
					sock.removeListener("message", onMessage);
					if (msg.error) {
						reject(new Error(`VM Service error: ${msg.error.message}`));
					} else {
						resolve(msg.result);
					}
				} catch {
					// Not our message, ignore
				}
			}

			sock.on("message", onMessage);
			sock.send(payload);
		});
	}

	function handleStreamEvent(msg: any): void {
		if (msg.method === "streamNotify" && msg.params) {
			const { streamId, event } = msg.params;
			if (streamId === "Debug") {
				if (event.kind === "Resume") {
					currentState = "running";
					notifyStatus();
				} else if (
					event.kind === "PauseBreakpoint" ||
					event.kind === "PauseStart" ||
					event.kind === "PauseException" ||
					event.kind === "PauseInterrupted"
				) {
					currentState = "paused";
					notifyStatus();
				}
			} else if (streamId === "Isolate") {
				if (event.kind === "Runnable") {
					currentState = "running";
					notifyStatus();
				}
			}
		}
	}

	// ── Connect / Disconnect ──

	async function connect(uri: string): Promise<void> {
		const WS = await getWs();
		disconnect();

		let wsUri = uri;
		if (wsUri.startsWith("http://")) {
			wsUri = wsUri.replace("http://", "ws://");
		}
		if (!wsUri.endsWith("/ws")) {
			wsUri = wsUri.replace(/\/$/, "") + "/ws";
		}

		return new Promise((resolve, reject) => {
			try {
				const ws = new (WS as any)(wsUri);
				socket = ws;

				ws.on("open", () => {
					connected = true;

					ws.on("message", (raw: unknown) => {
						const data = websocketMessageToString(raw);
						try {
							const msg = JSON.parse(data);
							handleStreamEvent(msg);
						} catch {
							// ignore parse errors
						}
					});

					// Get initial VM info — pick the first non-system user isolate
					sendRequest("getVM")
						.then((vm) => {
							const userIsolates =
								vm.isolates?.filter((i: any) => !i.isSystemIsolate) ?? [];
							if (
								userIsolates.length > 0 ||
								(vm.isolates && vm.isolates.length > 0)
							) {
								isolateId = userIsolates[0]?.id ?? vm.isolates[0].id;
								// Subscribe to streams
								return Promise.all([
									sendRequest("streamListen", { streamId: "Debug" }),
									sendRequest("streamListen", { streamId: "Isolate" }),
								]).then(() =>
									sendRequest("getIsolate", { isolateId }).then((iso) => {
										if (iso.pauseEvent) {
											currentState = "paused";
										} else {
											currentState = "running";
										}
										notifyStatus();
										resolve();
									}),
								);
							}
							resolve();
						})
						.catch(reject);
				});

				ws.on("error", (err: Error) => {
					reject(new Error(`VM Service connection error: ${err.message}`));
				});

				ws.on("close", () => {
					connected = false;
					socket = null;
					currentState = "unknown";
					notifyStatus();
				});
			} catch (err: any) {
				reject(new Error(`Failed to connect: ${err.message}`));
			}
		});
	}

	function disconnect(): void {
		if (socket) {
			try {
				socket.close();
			} catch {
				// ignore
			}
			socket = null;
		}
		connected = false;
		currentState = "unknown";
		breakpoints = [];
		notifyStatus();
	}

	// ── Debug controls ──

	async function resume(): Promise<void> {
		await sendRequest("resume", { isolateId });
	}

	async function pause(): Promise<void> {
		await sendRequest("pause", { isolateId });
	}

	async function stepOver(): Promise<void> {
		await sendRequest("resume", { isolateId, step: "Over" });
	}

	async function stepInto(): Promise<void> {
		await sendRequest("resume", { isolateId, step: "Into" });
	}

	async function stepOut(): Promise<void> {
		await sendRequest("resume", { isolateId, step: "Out" });
	}

	// ── Location helpers ──

	async function resolveLineForLocation(
		location: any,
	): Promise<number | undefined> {
		const tokenPos = location?.tokenPos;
		const scriptRef = location?.script;
		const scriptId = scriptRef?.id;
		if (typeof tokenPos !== "number" || !scriptId) return undefined;

		let lineMap = scriptLineCache.get(scriptId);
		if (!lineMap) {
			const script = await sendRequest("getObject", {
				isolateId,
				objectId: scriptId,
			});
			lineMap = new Map<number, number>();
			for (const row of script.tokenPosTable || []) {
				const line = row[0];
				for (let i = 1; i < row.length; i++) {
					const pos = row[i];
					if (typeof pos === "number") lineMap.set(pos, line);
				}
			}
			scriptLineCache.set(scriptId, lineMap);
		}

		return lineMap.get(tokenPos);
	}

	async function normalizeBreakpoint(
		raw: any,
		fallbackUri?: string,
		fallbackLine?: number,
	): Promise<Breakpoint> {
		const bpRaw = raw.breakpoint ?? raw;
		const location = bpRaw.location ??
			raw.location ?? {
				scriptUri: fallbackUri ?? "unknown",
				tokenPos: fallbackLine ?? 0,
			};
		const scriptUri =
			location.script?.uri ?? location.scriptUri ?? fallbackUri ?? "unknown";
		const line = await resolveLineForLocation(location).catch(
			() => fallbackLine,
		);
		return {
			id: bpRaw.id ?? raw.id,
			breakpointNumber:
				bpRaw.breakpointNumber ??
				raw.breakpointNumber ??
				breakpoints.length + 1,
			location: {
				scriptUri,
				tokenPos: location.tokenPos ?? fallbackLine ?? 0,
				line: line ?? fallbackLine,
			},
			resolved: bpRaw.resolved ?? raw.resolved ?? false,
		};
	}

	// ── Breakpoints ──

	async function addBreakpoint(
		scriptUri: string,
		line: number,
	): Promise<Breakpoint> {
		const result = await sendRequest("addBreakpointWithScriptUri", {
			isolateId,
			scriptUri,
			line,
		});
		const bp = await normalizeBreakpoint(result, scriptUri, line);
		breakpoints.push(bp);
		notifyBreakpoints([bp], []);
		return bp;
	}

	async function removeBreakpoint(breakpointId: string): Promise<void> {
		await sendRequest("removeBreakpoint", { isolateId, breakpointId });
		const idx = breakpoints.findIndex((bp) => bp.id === breakpointId);
		if (idx >= 0) {
			const removed = breakpoints.splice(idx, 1);
			notifyBreakpoints([], removed);
		}
	}

	async function getBreakpoints(): Promise<Breakpoint[]> {
		// Sync from server
		try {
			const result = await sendRequest("getIsolate", { isolateId });
			if (result.breakpoints) {
				breakpoints = await Promise.all(
					result.breakpoints.map((bp: any) => normalizeBreakpoint(bp)),
				);
			}
		} catch {
			// keep local list
		}
		return [...breakpoints];
	}

	async function setExceptionPauseMode(mode: ExceptionMode): Promise<void> {
		await sendRequest("setExceptionPauseMode", { isolateId, mode });
	}

	// ── Diagnostics ──

	async function getStackFrames(): Promise<StackFrame[]> {
		const result = await sendRequest("getStack", { isolateId });
		const frames: any[] = result.frames || [];
		return Promise.all(
			frames.map(async (f, i) => {
				const scriptUri = f.location?.script?.uri || "?";
				const fileName = scriptUri.split("/").pop() || scriptUri;
				const line = await resolveLineForLocation(f.location).catch(
					() => undefined,
				);
				return {
					index: i,
					name: f.code?.name || f.function?.name || "<unknown>",
					owner: f.code?.owner || f.function?.owner || "",
					location: line ? `${fileName}:${line}` : fileName,
					scriptUri,
					line,
				};
			}),
		);
	}

	async function getVariables(frameIndex: number = 0): Promise<Variable[]> {
		const frames = await sendRequest("getStack", { isolateId });
		const frameList: any[] = frames.frames || [];
		if (frameIndex >= frameList.length) return [];

		const frame = frameList[frameIndex];
		if (!frame) return [];

		const vars: Variable[] = [];

		// Get locals from each frame
		for (const v of frame.vars || []) {
			vars.push({
				name: v.name || "?",
				value: formatValue(v.value),
				type: v.value?.classRef?.name || v.value?.type || "?",
			});
		}

		return vars;
	}

	function formatValue(val: any): string {
		if (!val) return "null";
		if (val.type === "Bool")
			return String(val.valueAsString ?? val.identityHashCode ?? "false");
		if (val.type === "Int" || val.type === "Double")
			return val.valueAsString ?? String(val.value ?? "?");
		if (val.type === "String") {
			const s = val.valueAsString ?? "";
			return s.length > 80 ? `"${s.slice(0, 77)}..."` : `"${s}"`;
		}
		if (val.type === "List") return `List(${val.length ?? "?"})`;
		if (val.type === "Map") return `Map(${val.length ?? "?"})`;
		if (val.classRef) return `Instance of '${val.classRef.name}'`;
		if (val.type) return val.type;
		return val.valueAsString ?? `@${val.identityHashCode ?? "?"}`;
	}

	async function evaluate(
		expression: string,
		frameIndex: number = 0,
	): Promise<string> {
		const frames = await sendRequest("getStack", { isolateId });
		const frameList: any[] = frames.frames || [];
		if (frameIndex >= frameList.length) return "No frame selected";

		const frame = frameList[frameIndex];
		if (!frame) return "No frame";

		try {
			const result = await sendRequest("evaluateInFrame", {
				isolateId,
				frameIndex: frame.index ?? frameIndex,
				expression,
			});
			if (result.value) {
				return formatValue(result.value);
			}
			return JSON.stringify(result);
		} catch (err: any) {
			return `Error: ${err.message}`;
		}
	}

	// ── Public API ──

	return {
		get status(): DebugStatus {
			return { state: currentState, isolateId };
		},
		onStatusChange(cb) {
			statusListeners.add(cb);
			return () => statusListeners.delete(cb);
		},
		onBreakpointsChanged(cb) {
			bpListeners.add(cb);
			return () => bpListeners.delete(cb);
		},
		connect,
		disconnect,
		get connected() {
			return connected;
		},
		resume,
		pause,
		stepOver,
		stepInto,
		stepOut,
		addBreakpoint,
		removeBreakpoint,
		getBreakpoints,
		setExceptionPauseMode,
		getStackFrames,
		getVariables,
		evaluate,
	};
}
