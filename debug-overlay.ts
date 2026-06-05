import {
	matchesKey,
	truncateToWidth,
	type Component,
} from "@earendil-works/pi-tui";
import type {
	Breakpoint,
	DebugState,
	StackFrame,
	Variable,
	VmServiceClient,
} from "./vm-service.js";

export interface DebugControls {
	onContinue: () => void;
	onStepOver: () => void;
	onStepInto: () => void;
	onStepOut: () => void;
	onHotReload: () => void;
	onHotRestart: () => void;
	onQuit: () => void;
	onClose: () => void;
	onAddBreakpoint: (file: string, line: number) => void;
	onRemoveBreakpoint: (id: string) => void;
	onToggleExceptionMode: () => void;
	onCopyOutput: (text: string) => void;
	onAskAgent: (prompt: string) => void;
	onPastePrompt: (prompt: string) => void;
	onChatMode: () => void;
	onRenderRequested?: () => void;
}

interface OutputLine {
	text: string;
	id: number;
}

function isPageUp(data: string): boolean {
	return data === "\u001b[5~" || data === "\u001b[5;2~";
}

function isPageDown(data: string): boolean {
	return data === "\u001b[6~" || data === "\u001b[6;2~";
}

function isLikelyErrorLine(text: string): boolean {
	return /(?:Exception|Error|ERROR|FAILED|Failed|NoSuchMethodError|LateInitializationError|PlatformException|RenderFlex overflowed|Another exception was thrown|Gradle task .* failed|Lost connection to device|SocketException)/.test(text);
}

/**
 * Full debug overlay component.
 * Sections:
 *   1. Status + toolbar
 *   2. Breakpoints
 *   3. Flutter output (scrollable)
 *   4. Call stack (when paused)
 *   5. Variables (when paused)
 */
export class DebugOverlayComponent implements Component {
	// State
	private state: DebugState = "unknown";
	private breakpoints: Breakpoint[] = [];
	private frames: StackFrame[] = [];
	private variables: Variable[] = [];
	private selectedFrame = 0;
	private outputLines: OutputLine[] = [];
	private outputScrollOffset = 0;
	private lineIdCounter = 0;
	private exceptionMode: "None" | "Unhandled" | "All" = "Unhandled";
	private errorCount = 0;
	private lastErrorStartIndex: number | null = null;

	// Input mode
	private mode: "normal" | "addBp" | "removeBp" | "evaluate" | "selectLogs" = "normal";
	private inputBuffer = "";
	private evalResult = "";
	private lastNotification = "";
	private showHelp = true;
	private selectedLogCursor = 0;
	private selectedLogAnchor: number | null = null;
	private notificationTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly createdAt = Date.now();
	private readonly spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

	// Subscriptions
	private unsubStatus: (() => void) | null = null;
	private unsubBp: (() => void) | null = null;

	// Cache
	private cachedWidth = 0;
	private cachedLines: string[] = [];

	// Bounds
	private maxHeight = 30;
	private maxOutputLines = 2000;

	constructor(
		private vmService: VmServiceClient,
		private controls: DebugControls,
	) {
		// Status changes
		this.unsubStatus = vmService.onStatusChange((status) => {
			this.state = status.state;
			this.invalidate();
			if (status.state === "paused") {
				void this.refreshDiagnostics();
			} else {
				this.frames = [];
				this.variables = [];
				this.evalResult = "";
				this.controls.onRenderRequested?.();
			}
		});

		// Breakpoint changes
		this.unsubBp = vmService.onBreakpointsChanged((event) => {
			this.breakpoints = event.all;
			this.invalidate();
			this.controls.onRenderRequested?.();
		});
	}

	// ── Public methods ──

	addOutputLine(text: string): void {
		const wasFollowingBottom = this.outputScrollOffset === 0;
		this.outputLines.push({ text, id: this.lineIdCounter++ });
		this.detectErrorLine(text);
		if (this.outputLines.length > this.maxOutputLines) {
			const trimmed = this.outputLines.length - this.maxOutputLines;
			this.outputLines = this.outputLines.slice(-this.maxOutputLines);
			this.selectedLogCursor = Math.max(0, this.selectedLogCursor - trimmed);
			if (this.selectedLogAnchor !== null) {
				this.selectedLogAnchor = Math.max(0, this.selectedLogAnchor - trimmed);
			}
			if (this.lastErrorStartIndex !== null) {
				this.lastErrorStartIndex = Math.max(0, this.lastErrorStartIndex - trimmed);
			}
		}
		if (wasFollowingBottom) {
			this.outputScrollOffset = 0;
		}
		this.invalidate();
		this.controls.onRenderRequested?.();
	}

	private setNotification(msg: string): void {
		this.lastNotification = msg;
		if (this.notificationTimer) clearTimeout(this.notificationTimer);
		this.invalidate();
		this.controls.onRenderRequested?.();
		this.notificationTimer = setTimeout(() => {
			this.lastNotification = "";
			this.notificationTimer = null;
			this.invalidate();
			this.controls.onRenderRequested?.();
		}, 3000);
	}

	getOutputText(): string {
		return this.outputLines.map((line) => line.text).join("\n");
	}

	private detectErrorLine(text: string): void {
		if (!isLikelyErrorLine(text)) return;
		this.errorCount++;
		this.lastErrorStartIndex = Math.max(0, this.outputLines.length - 1);
	}

	getLatestErrorText(): string {
		if (this.lastErrorStartIndex === null) return "";
		return this.outputLines
			.slice(this.lastErrorStartIndex, this.lastErrorStartIndex + 80)
			.map((line) => line.text)
			.join("\n");
	}

	private jumpToLatestError(): void {
		if (this.lastErrorStartIndex === null) {
			this.setNotification("No detected Flutter error marker yet");
			return;
		}
		this.outputScrollOffset = Math.max(0, this.outputLines.length - this.lastErrorStartIndex - 1);
		this.setNotification("Jumped to latest detected error · ↓/PgDn returns toward bottom");
	}

	private enterLogSelection(): void {
		if (this.outputLines.length === 0) {
			this.setNotification("No logs to select yet");
			return;
		}
		this.mode = "selectLogs";
		this.selectedLogCursor = Math.max(0, this.outputLines.length - 1 - this.outputScrollOffset);
		this.selectedLogAnchor = null;
		this.setNotification("Select logs: move ↑↓, Enter start/end, A send, P paste, C copy, Esc cancel");
		this.invalidate();
	}

	private moveSelectedLogCursor(delta: number): void {
		if (this.outputLines.length === 0) return;
		this.selectedLogCursor = Math.max(
			0,
			Math.min(this.outputLines.length - 1, this.selectedLogCursor + delta),
		);
		this.outputScrollOffset = Math.max(0, this.outputLines.length - 1 - this.selectedLogCursor);
		this.invalidate();
		this.controls.onRenderRequested?.();
	}

	private getSelectedLogRange(): [number, number] | null {
		if (this.outputLines.length === 0) return null;
		const anchor = this.selectedLogAnchor ?? this.selectedLogCursor;
		return [Math.min(anchor, this.selectedLogCursor), Math.max(anchor, this.selectedLogCursor)];
	}

	private getSelectedLogText(): string {
		const range = this.getSelectedLogRange();
		if (!range) return "";
		const [start, end] = range;
		return this.outputLines
			.slice(start, end + 1)
			.map((line) => line.text)
			.join("\n");
	}

	private buildSelectedLogsPrompt(): string {
		const selectedLogs = this.getSelectedLogText();
		const range = this.getSelectedLogRange();
		const rangeText = range ? `${range[0] + 1}-${range[1] + 1}` : "none";
		return [
			"Проаналізуй вибраний користувачем фрагмент Flutter logs з /flutter-run.",
			"Знайди root cause, назви найбільш імовірний файл/рядок, запропонуй мінімальний safe fix.",
			"Не змінюй код без попереднього аналізу і плану.",
			"",
			`Debug state: ${this.state}, VM connected: ${this.vmService.connected}, selected log lines: ${rangeText}`,
			"\nSelected Flutter logs:\n```text\n" + selectedLogs + "\n```",
		].join("\n");
	}

	buildAgentPrompt(): string {
		const latestError = this.getLatestErrorText();
		const recentLogs = this.outputLines
			.slice(-120)
			.map((line) => line.text)
			.join("\n");
		return [
			"Проаналізуй Flutter runtime/build error з /flutter-run.",
			"Знайди root cause, назви найбільш імовірний файл/рядок, запропонуй мінімальний safe fix.",
			"Не змінюй код без попереднього аналізу і плану.",
			"",
			`Debug state: ${this.state}, VM connected: ${this.vmService.connected}, errors detected: ${this.errorCount}`,
			latestError ? "\nLatest detected error:\n```text\n" + latestError + "\n```" : "\nLatest detected error: не знайдено явного error marker.",
			"\nRecent Flutter logs:\n```text\n" + recentLogs + "\n```",
		].join("\n");
	}

	// ── Component interface ──

	handleInput(data: string): void {
		// Modal modes
		if (this.mode === "addBp") {
			this.handleAddBreakpointInput(data);
			return;
		}
		if (this.mode === "removeBp") {
			this.handleRemoveBreakpointInput(data);
			return;
		}
		if (this.mode === "evaluate") {
			this.handleEvaluateInput(data);
			return;
		}
		if (this.mode === "selectLogs") {
			this.handleLogSelectionInput(data);
			return;
		}

		// h = hide cockpit and return keyboard to chat; ? = toggle quick help
		if (data === "h" && this.mode === "normal") {
			this.controls.onChatMode();
			return;
		}
		if (data === "?" && this.mode === "normal") {
			this.showHelp = !this.showHelp;
			this.invalidate();
			this.controls.onRenderRequested?.();
			return;
		}

		// Navigation in normal mode (↑ = older, ↓ = newer)
		if (matchesKey(data, "up")) {
			this.outputScrollOffset = Math.min(
				Math.max(0, this.outputLines.length - 1),
				this.outputScrollOffset + 1,
			);
			this.invalidate();
			return;
		}
		if (matchesKey(data, "down")) {
			this.outputScrollOffset = Math.max(0, this.outputScrollOffset - 1);
			this.invalidate();
			return;
		}
		if (isPageUp(data) || matchesKey(data, "shift+up")) {
			this.outputScrollOffset = Math.min(
				Math.max(0, this.outputLines.length - 1),
				this.outputScrollOffset + 10,
			);
			this.invalidate();
			return;
		}
		if (isPageDown(data) || matchesKey(data, "shift+down")) {
			this.outputScrollOffset = Math.max(0, this.outputScrollOffset - 10);
			this.invalidate();
			return;
		}

		// Frame selection when paused
		if (this.state === "paused" && matchesKey(data, "left")) {
			if (this.selectedFrame > 0) {
				this.selectedFrame--;
				void this.refreshVariables();
				this.invalidate();
			}
			return;
		}
		if (this.state === "paused" && matchesKey(data, "right")) {
			if (this.selectedFrame < this.frames.length - 1) {
				this.selectedFrame++;
				void this.refreshVariables();
				this.invalidate();
			}
			return;
		}

		// F5 = Continue/Pause (toggle)
		if (matchesKey(data, "f5")) {
			this.controls.onContinue();
			return;
		}

		// F10 = Step Over
		if (matchesKey(data, "f10")) {
			this.controls.onStepOver();
			return;
		}

		// F11 = Step Into
		if (matchesKey(data, "f11")) {
			this.controls.onStepInto();
			return;
		}

		// Shift+F11 = Step Out
		if (matchesKey(data, "shift+f11")) {
			this.controls.onStepOut();
			return;
		}

		// r = hot reload
		if (data === "r" && this.mode === "normal") {
			this.controls.onHotReload();
			this.setNotification("⟳ Hot reload triggered");
			return;
		}

		// R = hot restart
		if (data === "R" && this.mode === "normal") {
			this.controls.onHotRestart();
			this.setNotification("⟳ Hot restart triggered");
			return;
		}

		// b = add breakpoint mode
		if (data === "b" && this.mode === "normal") {
			this.mode = "addBp";
			this.inputBuffer = "";
			this.invalidate();
			return;
		}

		// d = remove breakpoint mode
		if (data === "d" && this.mode === "normal") {
			this.mode = "removeBp";
			this.inputBuffer = "";
			this.invalidate();
			return;
		}

		// e = evaluate expression
		if (data === "e" && this.state === "paused") {
			this.mode = "evaluate";
			this.inputBuffer = "";
			this.invalidate();
			return;
		}

		// s = select a custom log range for sending/copying
		if (data === "s" && this.mode === "normal") {
			this.enterLogSelection();
			return;
		}

		// a = ask agent about latest error and recent logs
		if (data === "a" && this.mode === "normal") {
			this.controls.onAskAgent(this.buildAgentPrompt());
			this.setNotification("Sent diagnostic prompt");
			return;
		}

		// p = close overlay and paste diagnostic prompt into chat editor for manual editing
		if (data === "p" && this.mode === "normal") {
			this.controls.onPastePrompt(this.buildAgentPrompt());
			return;
		}

		// m / Tab = hide cockpit, keep Flutter running, return keyboard to chat
		if ((data === "m" || matchesKey(data, "tab")) && this.mode === "normal") {
			this.controls.onChatMode();
			return;
		}

		// v = jump output viewport to latest detected error
		if (data === "v" && this.mode === "normal") {
			this.jumpToLatestError();
			return;
		}

		// y = copy latest detected error block
		if (data === "y" && this.mode === "normal") {
			const latestError = this.getLatestErrorText();
			if (latestError) {
				this.controls.onCopyOutput(latestError);
				this.setNotification("Copied latest detected error block to clipboard");
			} else {
				this.setNotification("No detected Flutter error marker yet");
			}
			return;
		}

		// c = copy retained Flutter output to clipboard
		if (data === "c" && this.mode === "normal") {
			this.controls.onCopyOutput(this.getOutputText());
			this.setNotification(`Copied ${this.outputLines.length} log lines to clipboard`);
			return;
		}

		// x = toggle exception mode
		if (data === "x") {
			this.controls.onToggleExceptionMode();
			return;
		}

		// q = quit
		if ((data === "q" || data === "Q") && this.mode === "normal") {
			this.controls.onQuit();
			return;
		}

		// Escape = close overlay or cancel mode
		if (matchesKey(data, "escape")) {
			if (this.mode !== "normal") {
				this.mode = "normal";
				this.inputBuffer = "";
				this.invalidate();
				this.controls.onRenderRequested?.();
			} else {
				this.controls.onClose();
			}
			return;
		}
	}

	private handleLogSelectionInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.mode = "normal";
			this.selectedLogAnchor = null;
			this.invalidate();
			this.controls.onRenderRequested?.();
			return;
		}
		if (matchesKey(data, "up")) {
			this.moveSelectedLogCursor(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.moveSelectedLogCursor(1);
			return;
		}
		if (isPageUp(data) || matchesKey(data, "shift+up")) {
			this.moveSelectedLogCursor(-10);
			return;
		}
		if (isPageDown(data) || matchesKey(data, "shift+down")) {
			this.moveSelectedLogCursor(10);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (this.selectedLogAnchor === null) {
				this.selectedLogAnchor = this.selectedLogCursor;
				this.setNotification("Selection start set · move to end, then A send / P paste / C copy");
			} else {
				const range = this.getSelectedLogRange();
				const count = range ? range[1] - range[0] + 1 : 0;
				this.setNotification(`Selection ready: ${count} log lines · A send · P paste · C copy`);
			}
			this.invalidate();
			this.controls.onRenderRequested?.();
			return;
		}
		if (data === "a" || data === "A") {
			this.controls.onAskAgent(this.buildSelectedLogsPrompt());
			this.mode = "normal";
			return;
		}
		if (data === "p" || data === "P") {
			this.controls.onPastePrompt(this.buildSelectedLogsPrompt());
			this.mode = "normal";
			return;
		}
		if (data === "c" || data === "C") {
			this.controls.onCopyOutput(this.getSelectedLogText());
			const range = this.getSelectedLogRange();
			const count = range ? range[1] - range[0] + 1 : 0;
			this.setNotification(`Copied ${count} selected log lines`);
			return;
		}
	}

	private handleAddBreakpointInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.mode = "normal";
			this.inputBuffer = "";
			this.invalidate();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			// Parse "file.dart:42"
			const trimmed = this.inputBuffer.trim();
			const match = trimmed.match(/^(.+):(\d+)$/);
			if (match) {
				this.controls.onAddBreakpoint(match[1], parseInt(match[2], 10));
				this.mode = "normal";
				this.inputBuffer = "";
			} else {
				this.setNotification("Format: file.dart:lineNumber");
			}
			this.invalidate();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.inputBuffer = this.inputBuffer.slice(0, -1);
			this.invalidate();
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.inputBuffer += data;
			this.invalidate();
		}
	}

	private handleRemoveBreakpointInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.mode = "normal";
			this.inputBuffer = "";
			this.invalidate();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const idx = parseInt(this.inputBuffer.trim(), 10);
			const bp = this.breakpoints[idx - 1]; // 1-indexed
			if (bp) {
				this.controls.onRemoveBreakpoint(bp.id);
			}
			this.mode = "normal";
			this.inputBuffer = "";
			this.invalidate();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.inputBuffer = this.inputBuffer.slice(0, -1);
			this.invalidate();
			return;
		}
		if (
			data.length === 1 &&
			data.charCodeAt(0) >= 48 &&
			data.charCodeAt(0) <= 57
		) {
			this.inputBuffer += data;
			this.invalidate();
		}
	}

	private handleEvaluateInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.mode = "normal";
			this.inputBuffer = "";
			this.invalidate();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			void this.vmService
				.evaluate(this.inputBuffer.trim(), this.selectedFrame)
				.then((result) => {
					this.evalResult = result;
					this.mode = "normal";
					this.invalidate();
					this.controls.onRenderRequested?.();
				});
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.inputBuffer = this.inputBuffer.slice(0, -1);
			this.invalidate();
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.inputBuffer += data;
			this.invalidate();
		}
	}

	// ── Rendering ──

	render(width: number): string[] {
		const connected = this.vmService.connected;
		// While Flutter is building/launching we intentionally bypass cache so the spinner and elapsed time animate.
		if (connected && this.cachedLines.length > 0 && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const w = Math.max(48, Math.min(width, 110));
		const isCompact = w < 72;
		const isWide = w >= 92;
		const lines: string[] = [];

		// ── Section 1: Header ──
		const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.createdAt) / 1000));
		const elapsedText = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
		const spinner = this.spinnerFrames[Math.floor(Date.now() / 120) % this.spinnerFrames.length];
		const statusIcon = !connected ? spinner : this.state === "paused" ? "⏸" : "▶";
		const statusText = !connected
			? "BUILDING"
			: this.state === "paused"
				? "PAUSED"
				: "RUNNING";
		const errorBadge = this.errorCount > 0 ? ` · ⚠ ${this.errorCount}` : "";
		const modeBadge = this.mode === "selectLogs" ? " · 🧩 SELECT" : "";
		const title = isCompact
			? ` 🐦 Flutter ${statusIcon} ${statusText}${errorBadge}${modeBadge} `
			: ` 🐦 Flutter Cockpit ${statusIcon} ${statusText} · VM ${connected ? "online" : "waiting"} · Exc ${this.exceptionMode}${errorBadge}${modeBadge} `;

		lines.push(
			truncateToWidth(
				`┌${title}${"─".repeat(Math.max(0, w - title.length - 1))}`,
				w,
			),
		);
		const primaryActions = this.mode === "selectLogs"
			? "│  🧩 Select logs: ↑↓ move · Enter start/end · A send · P paste · C copy · Esc cancel"
			: isCompact
				? "│  💬 h hide · 🧩 s select · 🤖 a send · ⚠ v error · 📋 c copy · ? help"
				: "│  💬 h Hide to chat   🧩 s Select logs   🤖 a Send logs   ⚠ v Latest error   📋 c Copy   ? Help";
		lines.push(truncateToWidth(primaryActions, w));

		if (!connected) {
			const lastMeaningfulOutput = [...this.outputLines]
				.reverse()
				.find((line) => !line.text.startsWith("[flutter] machine event:"))?.text;
			const buildLine = lastMeaningfulOutput
				? `│  🔨 ${spinner} Building / launching · ${elapsedText} · ${lastMeaningfulOutput}`
				: `│  🔨 ${spinner} Building / launching · ${elapsedText} · waiting for Flutter output...`;
			lines.push(truncateToWidth(buildLine, w));
		}

		if (this.lastNotification) {
			lines.push(truncateToWidth(`│  ⚡ ${this.lastNotification}`, w));
		}

		if (this.showHelp) {
			lines.push(truncateToWidth(`├─ Help / controls ${"─".repeat(Math.max(0, w - 19))}`, w));
			if (isCompact) {
				lines.push(truncateToWidth("│  💬 h hide to chat · /flutter-run reopen", w));
				lines.push(truncateToWidth("│  🧩 s select logs: Enter range · A send · P paste · C copy", w));
				lines.push(truncateToWidth("│  🤖 a auto-send logs · ⚠ v/y latest error · r/R reload/restart", w));
				lines.push(truncateToWidth("│  Esc hide · q stop Flutter · ? toggle help", w));
			} else if (isWide) {
				lines.push(truncateToWidth("│  💬 h / Esc  Hide cockpit, keep Flutter running, return keyboard to chat", w));
				lines.push(truncateToWidth("│  ↩ /flutter-run  Reopen this cockpit for the same running Flutter process", w));
				lines.push(truncateToWidth("│  🧩 s  Select exact log range: ↑↓/Pg move · Enter start/end · A send · P paste · C copy", w));
				lines.push(truncateToWidth("│  🤖 a  Auto-send latest error + recent logs   ⚠ v/y  View/copy latest error", w));
				lines.push(truncateToWidth("│  🔁 r/R  Hot reload/restart   🛑 q  Stop Flutter   ?  Toggle this help", w));
			} else {
				lines.push(truncateToWidth("│  💬 h/Esc hide to chat · /flutter-run reopen", w));
				lines.push(truncateToWidth("│  🧩 s select logs · A send · P paste · C copy", w));
				lines.push(truncateToWidth("│  🤖 a auto-send · ⚠ v/y error · 🔁 r/R reload/restart · 🛑 q stop", w));
			}
		}

		if (this.errorCount > 0) {
			lines.push(truncateToWidth(`│  ⚠ Latest error controls: v=view · y=copy · a=ask agent`, w));
		}

		// Modal mode indicator
		if (this.mode === "addBp") {
			lines.push(
				truncateToWidth(
					`│  Add breakpoint: ${this.inputBuffer}_  (file.dart:line → Enter, Esc to cancel)`,
					w,
				),
			);
		} else if (this.mode === "removeBp") {
			lines.push(
				truncateToWidth(
					`│  Remove breakpoint #: ${this.inputBuffer}_  (number → Enter, Esc to cancel)`,
					w,
				),
			);
		} else if (this.mode === "evaluate") {
			lines.push(
				truncateToWidth(
					`│  Evaluate: ${this.inputBuffer}_  (expression → Enter, Esc to cancel)`,
					w,
				),
			);
		} else if (this.mode === "selectLogs") {
			const range = this.getSelectedLogRange();
			const rangeText = range ? `${range[0] + 1}-${range[1] + 1}` : `${this.selectedLogCursor + 1}`;
			const count = range ? range[1] - range[0] + 1 : 1;
			lines.push(
				truncateToWidth(
					`│  🧩 Selecting logs: cursor ${this.selectedLogCursor + 1}/${this.outputLines.length} · range ${rangeText} (${count}) · A send · P paste · C copy · Esc cancel`,
					w,
				),
			);
		}

		// ── Section 2: Breakpoints ──
		lines.push(
			truncateToWidth(
				`├── Breakpoints (${this.breakpoints.length}) ─${"─".repeat(Math.max(0, w - 24))}`,
				w,
			),
		);
		if (this.breakpoints.length === 0) {
			lines.push(truncateToWidth("│  (none — press 'b' to add)", w));
		} else {
			for (let i = 0; i < this.breakpoints.length; i++) {
				const bp = this.breakpoints[i];
				const file =
					bp.location.scriptUri.split("/").pop() || bp.location.scriptUri;
				const line = bp.location?.line || "?";
				const resolved = bp.resolved ? "●" : "○";
				lines.push(
					truncateToWidth(`│  ${i + 1}. ${resolved} ${file}:${line}`, w),
				);
			}
		}

		// ── Section 3: Flutter Output ──
		const linesUsed = lines.length;
		const availableForOutput = Math.max(4, this.maxHeight - linesUsed - 8);
		const outputStart = Math.max(
			0,
			this.outputLines.length - availableForOutput - this.outputScrollOffset,
		);
		const outputEnd = Math.min(
			this.outputLines.length,
			outputStart + availableForOutput,
		);

		const selectionRange = this.mode === "selectLogs" ? this.getSelectedLogRange() : null;
		const outputTitle = this.mode === "selectLogs"
			? "├── Flutter Output / log selection "
			: "├── Flutter Output ";
		lines.push(
			truncateToWidth(
				`${outputTitle}${"─".repeat(Math.max(0, w - outputTitle.length))}`,
				w,
			),
		);
		const visible = this.outputLines.slice(outputStart, outputEnd);
		if (visible.length === 0) {
			lines.push(truncateToWidth("│  (waiting for output...)", w));
		}
		for (let i = 0; i < visible.length; i++) {
			const absoluteIndex = outputStart + i;
			const ol = visible[i];
			const isCursor = this.mode === "selectLogs" && absoluteIndex === this.selectedLogCursor;
			const isSelected = Boolean(
				selectionRange && absoluteIndex >= selectionRange[0] && absoluteIndex <= selectionRange[1],
			);
			const marker = isCursor ? "▶" : isSelected ? "█" : " ";
			const display =
				ol.text.length > w - 6 ? ol.text.slice(0, w - 9) + "..." : ol.text;
			lines.push(truncateToWidth(`│ ${marker} ${display}`, w));
		}

		// ── Section 4: Call Stack (when paused) ──
		if (this.state === "paused" && this.frames.length > 0) {
			lines.push(
				truncateToWidth(
					`├── Call Stack ─${"─".repeat(Math.max(0, w - 18))}`,
					w,
				),
			);
			const maxFrames = Math.min(this.frames.length, 8);
			for (let i = 0; i < maxFrames; i++) {
				const f = this.frames[i];
				const marker = i === this.selectedFrame ? "▶" : " ";
				const display = `${marker} ${f.name} @ ${f.location}`;
				lines.push(
					truncateToWidth(
						`│ ${display.length > w - 4 ? display.slice(0, w - 7) + "..." : display}`,
						w,
					),
				);
			}
		}

		// ── Section 5: Variables (when paused) ──
		if (this.state === "paused" && this.variables.length > 0) {
			lines.push(
				truncateToWidth(
					`├── Variables (frame ${this.selectedFrame}) ─${"─".repeat(Math.max(0, w - 27))}`,
					w,
				),
			);
			const maxVars = Math.min(this.variables.length, 10);
			for (let i = 0; i < maxVars; i++) {
				const v = this.variables[i];
				const display = `  ${v.name}: ${v.value}  (${v.type})`;
				lines.push(
					truncateToWidth(
						`│ ${display.length > w - 4 ? display.slice(0, w - 7) + "..." : display}`,
						w,
					),
				);
			}
			if (this.evalResult) {
				lines.push(truncateToWidth(`│  ── eval: ${this.evalResult}`, w));
			}
		}

		// ── Footer ──
		while (lines.length < this.maxHeight - 1) {
			lines.push(truncateToWidth("│", w));
		}
		lines.push(truncateToWidth(`└${"─".repeat(Math.max(0, w - 2))}┘`, w));
		lines.push("");

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.cachedLines = [];
	}

	dispose(): void {
		if (this.notificationTimer) clearTimeout(this.notificationTimer);
		if (this.unsubStatus) this.unsubStatus();
		if (this.unsubBp) this.unsubBp();
	}

	// ── Helpers ──

	setExceptionMode(mode: "None" | "Unhandled" | "All"): void {
		this.exceptionMode = mode;
		this.invalidate();
		this.controls.onRenderRequested?.();
	}

	private async refreshDiagnostics(): Promise<void> {
		try {
			this.frames = await this.vmService.getStackFrames();
			this.selectedFrame = 0;
			await this.refreshVariables();
		} catch {
			// ignore
		}
	}

	private async refreshVariables(): Promise<void> {
		try {
			this.variables = await this.vmService.getVariables(this.selectedFrame);
		} catch {
			this.variables = [];
		}
		this.invalidate();
		this.controls.onRenderRequested?.();
	}
}
