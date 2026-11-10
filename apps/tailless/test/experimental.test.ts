/** Optional schemas, attach commands and the independent queue extension through real stdio. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { FrontendApp } from "../src/app.ts";
import { AcpClient } from "../src/client.ts";
import { multiClientAttach } from "../src/experimental/multi-client-attach.ts";
import { promptDelivery } from "../src/experimental/prompt-delivery.ts";
import { array, object } from "../src/json.ts";
import { MemoryTerminal } from "./memory-terminal.ts";

async function until(predicate: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 5000;
	while (!(await predicate())) {
		assert(Date.now() < deadline, "Timed out waiting for frontend state");
		await setTimeout(5);
	}
}

function setup(...args: string[]) {
	const launch = {
		command: process.execPath,
		args: [resolve("test/fixtures/shared-peer.mjs"), ...args],
		timeoutMs: 5000,
	};
	const app = new FrontendApp({ launch, peerCwd: "/peer/default", extensions: [], keybindings: {}, theme: "dark" }, [
		multiClientAttach(),
		promptDelivery(),
	]);
	app.ui.tui.terminal = new MemoryTerminal();
	return { app, launch };
}

for (const version of [1, 2] as const) {
	test(
		`v${version}: attach replay, queue pop, preserved draft and extension reload`,
		{ timeout: 15000 },
		async (t) => {
			const { app, launch } = setup(...(version === 1 ? ["--v1"] : []));
			t.after(() => app.stop());
			const notices: string[] = [];
			app.ui.notify = (value) => {
				notices.push(value);
			};
			const path = resolve("src/capabilities/shared-queue.ts");
			await app.ui.extensions.load(path);
			await app.client.connect(launch);
			const attach = app.client.modules.find((module) => module.id === "multi-client-attach")!;
			await attach.commands!.attach!("shared", app.client, app.ui);
			assert.equal(app.client.model.get("shared").cwd, "/peer/shared");
			assert.equal(
				app.client.model.get("shared").entities.filter((entity) => entity.kind === "user_message").length,
				1,
			);
			assert(JSON.stringify(app.client.model.get("shared").entities).includes("Hello from Panda"));
			app.ui.onSubmit("remove this waiting input");
			await until(
				async () =>
					array(
						object(await app.client.request("_com.example/shared-queue/list", { sessionId: "shared" })).entries,
					).length === 1,
			);
			await app.ui.extensions.commands.get("queue-pop")!.value.run("");
			await until(() => notices.includes("Waiting message removed"));
			assert.equal(app.ui.getEditorText(), "");
			app.ui.onSubmit("another waiting message");
			await until(
				async () =>
					array(
						object(await app.client.request("_com.example/shared-queue/list", { sessionId: "shared" })).entries,
					).length === 1,
			);
			app.ui.setEditorText("My newer draft");
			await app.client.request("_com.example/testing/stale", {});
			await app.ui.extensions.commands.get("queue-pop")!.value.run("");
			assert(notices.some((value) => value.includes("Queue changed; no message removed")));
			assert.equal(app.ui.getEditorText(), "My newer draft");
			assert(!JSON.stringify(app.client.model.get("shared").entities).includes("remove this waiting input"));
			await app.ui.extensions.load(path);
			assert(app.ui.extensions.commands.has("queue-pop"));
			assert.equal(app.client.reconnectRequired, false);
			const methods = array(object(await app.client.request("_com.example/testing/methods", {})).methods);
			assert.equal(methods.filter((name) => name === "session/attach").length, 1);
			assert.equal(methods.filter((name) => name === "_com.example/shared-queue/pop").length, 2);
			await app.ui.extensions.unload(path);
			assert.equal(app.ui.extensions.commands.has("queue-pop"), false);
			await attach.commands!.detach!("shared", app.client, app.ui);
			assert.equal(app.client.model.get("shared").active, false);
		},
	);
}

test("profile mismatch fails without a fallback new session", async (t) => {
	const { app, launch } = setup("--mismatch");
	t.after(() => app.stop());
	await app.client.connect(launch);
	await assert.rejects(app.client.protocolRequest("session/attach", { sessionId: "shared" }), /profile mismatch/);
	const methods = array(object(await app.client.request("_com.example/testing/methods", {})).methods);
	assert(!methods.includes("session/new"));
});

test("malformed known draft updates cannot use the baseline fallback", async (t) => {
	const { app, launch } = setup();
	t.after(() => app.stop());
	const notices: string[] = [];
	app.ui.notify = (text) => {
		notices.push(text);
	};
	await app.client.connect(launch);
	await app.client.request("_com.example/testing/malformed", {});
	await until(() => !app.client.connected);
	assert(notices.some((text) => text.includes("Invalid ACP update:prompt_received")));
});

for (const version of [1, 2] as const) {
	test(`v${version}: attach alone keeps one input echo and selected-version turn activity`, async (t) => {
		const client = new AcpClient();
		client.use(multiClientAttach());
		t.after(() => client.disconnect());
		await client.connect({
			command: process.execPath,
			args: [resolve("test/fixtures/shared-peer.mjs"), "--immediate", ...(version === 1 ? ["--v1"] : [])],
		});
		await client.protocolRequest("session/attach", { sessionId: "shared" });
		assert.equal(client.model.get("shared").state, "idle");
		const running = client.prompt("shared", "one input echo");
		await until(() => client.model.get("shared").state === "running");
		await running;
		await until(() => client.model.get("shared").state === "idle");
		const users = client.model.get("shared").entities.filter((entity) => entity.kind === "user_message");
		assert.equal(users.length, 2);
		assert.equal(JSON.stringify(users).split("one input echo").length - 1, 1);
	});
}
