/**
 * S-02 disposable spike: process identity + public-surface touch test.
 * Loaded via `pi -e ./spike.ts`. Writes facts to SPIKE_LOG (default
 * `.scratch/pi-subagents/spike-logs/latest.json`).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LOG = process.env.SPIKE_LOG ?? ".scratch/pi-subagents/spike-logs/latest.json";

type UiProbe = {
	type: string;
	threw: boolean;
	error?: string;
	unsubType?: string;
};

function probeUi(fn: () => unknown): UiProbe {
	try {
		const result = fn();
		return {
			type: "function",
			threw: false,
			unsubType: typeof result,
		};
	} catch (error) {
		return {
			type: "function",
			threw: true,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function writeLog(data: unknown): void {
	mkdirSync(dirname(LOG), { recursive: true });
	writeFileSync(LOG, `${JSON.stringify(data, null, 2)}\n`);
}

export default function (pi: ExtensionAPI) {
	const factory = {
		phase: "factory",
		extensionPid: process.pid,
		ppid: process.ppid,
		sendUserMessage: typeof pi.sendUserMessage,
		sendMessage: typeof pi.sendMessage,
		appendEntry: typeof pi.appendEntry,
		registerTool: typeof pi.registerTool,
		registerCommand: typeof pi.registerCommand,
	};
	writeLog({ factory });

	pi.on("session_start", (_event, ctx) => {
		const setWidget = probeUi(() => {
			ctx.ui.setWidget("spike", [`spike-ok pid=${process.pid}`]);
		});
		const setStatus = probeUi(() => {
			ctx.ui.setStatus("spike", `spike-ok pid=${process.pid}`);
		});
		const onTerminalInput = probeUi(() => {
			const unsub = ctx.ui.onTerminalInput(() => undefined);
			if (typeof unsub === "function") unsub();
			return unsub;
		});

		writeLog({
			factory,
			session: {
				extensionPid: process.pid,
				ppid: process.ppid,
				mode: ctx.mode,
				hasUI: ctx.hasUI,
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			},
			ui: {
				setWidget,
				setStatus,
				onTerminalInput,
			},
			publicSurface: {
				sendUserMessage: typeof pi.sendUserMessage,
				appendEntry: typeof pi.appendEntry,
			},
		});
	});
}
