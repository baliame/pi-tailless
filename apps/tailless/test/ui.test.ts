/** Exercise the real pi TUI/editor and extension host with controlled terminal input. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import xterm from "@xterm/headless";
import { AcpClient } from "../src/client.ts";
import { FrontendUI } from "../src/ui.ts";
import { MemoryTerminal } from "./memory-terminal.ts";

test("pi-derived terminal renders conversation, preserves draft, resizes and returns explicit permission choices", async (t) => {
	const client = new AcpClient();
	const terminal = new MemoryTerminal();
	const ui = new FrontendUI(client, { terminal });
	t.after(() => {
		ui.stop();
		client.disconnect();
	});
	ui.start();
	ui.setEditorText("Preserved draft");
	client.model.activate("session", "/remote/project", {});
	client.model.apply(
		"session",
		{ sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "Streamed answer" } },
		2,
	);
	ui.tui.requestRender(true);
	await setImmediate();
	assert(terminal.output.includes("Streamed answer"));
	assert.equal(ui.getEditorText(), "Preserved draft");
	terminal.resize(60, 20);
	ui.tui.requestRender(true);
	await setImmediate();
	const signal = new AbortController();
	const choice = ui.select("session · Test permission", ["Allow once", "Deny"], signal.signal);
	await setImmediate();
	terminal.input("\x1b[B");
	terminal.input("\r");
	assert.equal(await choice, "Deny");
	const cancelled = ui.input("Cancelled interaction", "", signal.signal);
	await setImmediate();
	signal.abort();
	assert.equal(await cancelled, undefined);
	client.disconnect();
	assert.equal(ui.getEditorText(), "Preserved draft");
	assert.equal(client.model.get("session").state, "disconnected");
	const screen = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true });
	t.after(() => screen.dispose());
	await new Promise<void>((done) => screen.write(terminal.output, done));
	const rendered = Array.from({ length: screen.buffer.active.length }, (_, index) =>
		screen.buffer.active.getLine(index)?.translateToString(true),
	).join("\n");
	assert(rendered.includes("Preserved draft"));
});

test("frontend extension consumes the same task API as native code and reload cleans registrations", async (t) => {
	const client = new AcpClient();
	const terminal = new MemoryTerminal();
	const ui = new FrontendUI(client, { terminal });
	t.after(async () => {
		client.disconnect();
		await ui.extensions.dispose();
		ui.stop();
	});
	const path = resolve("examples/tasks.ts");
	await ui.extensions.load(path);
	assert.equal(ui.extensions.commands.size, 1);
	await client.connect({ command: process.execPath, args: [resolve("examples/fixture-peer.mjs")], timeoutMs: 5000 });
	await client.newSession("/remote/project");
	const native = await client.request("_com.example/tasks/list", { sessionId: client.model.visible! });
	assert(native);
	await ui.extensions.commands.get("task-widget")!.value.run("");
	ui.start();
	ui.tui.requestRender(true);
	await setImmediate();
	assert(terminal.output.includes("Inspect failing test"));
	assert.deepEqual(await client.request("_com.example/tasks/callback", {}), { echoed: { text: "ping" } });
	await ui.extensions.load(path);
	assert.equal(ui.extensions.commands.size, 1);
	assert.equal(client.reconnectRequired, false);
	await ui.extensions.unload(path);
	assert.equal(ui.extensions.commands.size, 0);
	assert.equal(client.declarations["com.example/ui"], undefined);
	assert.equal(client.reconnectRequired, true);
});

test("extension unload cancels custom dialogs and removes configurable shortcuts", async (t) => {
	const client = new AcpClient();
	const terminal = new MemoryTerminal();
	const ui = new FrontendUI(client, { terminal, keybindings: { "test.extension": "ctrl+k" } });
	t.after(async () => {
		await ui.extensions.dispose();
		ui.stop();
	});
	const path = resolve("test/fixtures/dialog-extension.mjs");
	await ui.extensions.load(path);
	ui.start();
	terminal.input("\x0b");
	assert.equal(ui.getEditorText(), "extension shortcut");
	const pending = ui.extensions.commands.get("wait-dialog")!.value.run("");
	await setImmediate();
	assert(ui.tui.hasOverlay());
	await ui.extensions.unload(path);
	await pending;
	assert.equal(ui.tui.hasOverlay(), false);
	assert.equal(ui.extensions.shortcuts.size, 0);
});
