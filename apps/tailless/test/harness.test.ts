/** Optional external-peer checks: configure an already-running SDK harness through stdio. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { AcpClient } from "../src/client.ts";
import { object } from "../src/json.ts";
import { FrontendUI } from "../src/ui.ts";
import { MemoryTerminal } from "./memory-terminal.ts";

const endpoint = process.env.POC_HARNESS_ENTRY;
const url = process.env.POC_HARNESS_URL;
const cwd = process.env.POC_WORKSPACE;

function waitFor(client: AcpClient, predicate: () => boolean): Promise<void> {
	if (predicate()) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const previous = client.model.onChange;
		const timer = setTimeout(() => {
			client.model.onChange = previous;
			reject(new Error("Peer update timed out"));
		}, 10000);
		client.model.onChange = () => {
			previous();
			if (predicate()) {
				clearTimeout(timer);
				client.model.onChange = previous;
				resolve();
			}
		};
	});
}

test(
	"external SDK harness: UI extension, configuration, tools and persistent resume",
	{ skip: !endpoint || !url || !cwd, timeout: 30000 },
	async (t) => {
		const client = new AcpClient();
		const terminal = new MemoryTerminal();
		const ui = new FrontendUI(client, { terminal });
		t.after(async () => {
			client.disconnect();
			await ui.extensions.dispose();
			ui.stop();
		});
		ui.start();
		await ui.extensions.load(resolve("examples/tasks.ts"));
		const permission = client.interaction.permission;
		client.interaction.permission = async (params, signal) => {
			const result = permission(params, signal);
			await setImmediate();
			terminal.input("\r");
			return result;
		};
		const launch = { command: process.execPath, args: [endpoint!, "attach", "--url", url!], timeoutMs: 10000 };
		await client.connect(launch);
		assert.equal(client.version, 2);
		const id = await client.newSession(cwd!);
		assert.equal(object(client.capability("com.example/tasks")).version, 1);
		await client.configure(id, "thinking", "off");
		await client.prompt(id, "use a tool");
		await waitFor(
			client,
			() => client.model.get(id).state === "idle" && client.model.get(id).stopReason === "end_turn",
		);
		await ui.extensions.commands.get("task-widget")!.value.run("");
		ui.tui.requestRender(true);
		await setImmediate();
		assert(terminal.output.includes("Pi tool calls"));
		assert.deepEqual(await client.request("_com.example/tasks/callback", { sessionId: id }), {
			echoed: { text: "ping" },
		});

		const before = client.model.get(id).entities.length;
		ui.setEditorText("draft survives detach");
		client.disconnect();
		assert.equal(ui.getEditorText(), "draft survives detach");
		await client.connect(launch);
		await client.resume(id, cwd!);
		assert.equal(client.model.get(id).entities.length, before);
		await client.prompt(id, "second message");
		await waitFor(
			client,
			() =>
				client.model
					.get(id)
					.entities.some(
						(entry) => entry.kind === "agent_message" && JSON.stringify(entry.data).includes("User messages: 2"),
					) && client.model.get(id).state === "idle",
		);
		await client.closeSession(id);
		assert.equal(client.model.get(id).active, false);
	},
);

test(
	"official ACP sample agent streams tools and handles permission denial",
	{ skip: !process.env.POC_REFERENCE_AGENT || !cwd, timeout: 20000 },
	async (t) => {
		const client = new AcpClient();
		t.after(() => client.disconnect());
		client.interaction.permission = async () => ({ outcome: { outcome: "selected", optionId: "reject" } });
		await client.connect({ command: process.execPath, args: [process.env.POC_REFERENCE_AGENT!], timeoutMs: 10000 });
		assert.equal(client.version, 1);
		const id = await client.newSession(cwd!);
		await client.prompt(id, "Exercise the reference agent");
		assert.equal(client.model.get(id).state, "idle");
		const tools = client.model.get(id).entities.filter((entry) => entry.kind === "tool");
		assert.equal(tools.length, 2);
		assert.equal(tools.find((entry) => entry.id === "call_2")!.data.status, "failed");
	},
);
