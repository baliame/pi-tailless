/** Deterministic end-to-end protocol checks through actual child-process stdio. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { AcpClient } from "../src/client.ts";
import { object } from "../src/json.ts";
import { SessionModel } from "../src/model.ts";
import { WireSchema } from "../src/schema.ts";

function launch(...args: string[]) {
	return { command: process.execPath, args: [resolve("examples/fixture-peer.mjs"), ...args], timeoutMs: 5000 };
}
function waitFor(client: AcpClient, predicate: () => boolean): Promise<void> {
	if (predicate()) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const previous = client.model.onChange;
		const timer = setTimeout(() => {
			client.model.onChange = previous;
			reject(new Error("State wait timed out"));
		}, 4000);
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

for (const version of [1, 2] as const) {
	test(`ACP v${version}: handshake, prompt, Unicode JSONL, tools, replay and capability calls`, async (t) => {
		const client = new AcpClient();
		t.after(() => client.disconnect());
		await client.connect(launch(...(version === 1 ? ["--v1"] : [])));
		assert.equal(client.version, version);
		const id = await client.newSession("/srv/project");
		const states: string[] = [];
		client.model.onChange = () => states.push(client.model.get(id).state);
		await client.prompt(id, "hello");
		if (version === 2) assert.equal(client.model.get(id).state, "running");
		await waitFor(client, () => client.model.get(id).state === "idle");
		assert(states.includes("running"));
		const entities = client.model.get(id).entities;
		assert.equal(entities.filter((entry) => entry.kind === "agent_message").length, 1);
		assert.equal(
			object((entities.find((entry) => entry.kind === "agent_message")!.data.content as object[])[0]).text,
			"Hello\u2028world from ACP",
		);
		assert.equal(entities.find((entry) => entry.kind === "tool")!.data.status, "completed");
		assert.equal(object(client.capability("com.example/tasks")).version, 1);
		assert.equal(
			(object(await client.request("_com.example/tasks/list", { sessionId: id })).tasks as object[]).length,
			1,
		);
		assert.equal((await client.listSessions()).length, 1);
		await client.resume(id, "/srv/project");
		await client.resume(id, "/srv/project");
		assert.equal(client.model.get(id).entities.length, 1);
		if (version === 2) {
			await client.closeSession(id);
			assert.equal(client.model.get(id).active, false);
		}
	});
	test(`ACP v${version}: permission request is serviced while prompt processing is pending`, async (t) => {
		const client = new AcpClient();
		t.after(() => client.disconnect());
		let asked = false;
		client.interaction.permission = async (params) => {
			asked = true;
			assert.equal(typeof params.sessionId, "string");
			return { outcome: { outcome: "selected", optionId: "deny" } };
		};
		await client.connect(launch("--permission", ...(version === 1 ? ["--v1"] : [])));
		const id = await client.newSession("/srv/project");
		await client.prompt(id, "inspect");
		await waitFor(client, () => client.model.get(id).state === "idle");
		assert(asked);
	});
}

test("legacy v1 initialization fallback is bounded and version-specific", async (t) => {
	const client = new AcpClient();
	t.after(() => client.disconnect());
	await client.connect(launch("--v1", "--legacy"));
	assert.equal(client.version, 1);
});
test("unsupported versions fail without claiming a connection", async () => {
	const client = new AcpClient();
	await assert.rejects(client.connect(launch("--unsupported")), /Unsupported ACP/);
	assert.equal(client.connected, false);
});
test("custom calls can run in both directions on the same connection", async (t) => {
	const client = new AcpClient();
	t.after(() => client.disconnect());
	client.onCustomRequest = async (method, params) => {
		assert.equal(method, "_com.example/ui/ping");
		return { echoed: params };
	};
	await client.connect(launch());
	assert.deepEqual(await client.request("_com.example/tasks/callback", {}), { echoed: { text: "ping" } });
});
test("missing capabilities and changed declarations remain explicit", async (t) => {
	const client = new AcpClient();
	t.after(() => client.disconnect());
	client.declare("com.example/ui", { version: 1 });
	await client.connect(launch("--no-tasks"));
	assert.equal(client.capability("com.example/tasks"), undefined);
	assert.equal(client.reconnectRequired, false);
	client.declare("com.example/ui", { version: 2 });
	assert.equal(client.reconnectRequired, true);
});
test("malformed recognized content disconnects instead of falling through to unknown display", async (t) => {
	const client = new AcpClient();
	t.after(() => client.disconnect());
	await client.connect(launch());
	const id = await client.newSession("/srv/project");
	await client.prompt(id, "malformed");
	await waitFor(client, () => !client.connected);
	assert.equal(client.model.get(id).state, "disconnected");
});
test("v2 entity IDs include kind, patches preserve metadata removals, background updates do not imply running", () => {
	const model = new SessionModel();
	model.apply(
		"s",
		{ sessionUpdate: "agent_thought_chunk", messageId: "same", content: { type: "text", text: "Reason" } },
		2,
	);
	model.apply(
		"s",
		{ sessionUpdate: "agent_message_chunk", messageId: "same", content: { type: "text", text: "Answer" } },
		2,
	);
	model.apply("s", { sessionUpdate: "tool_call_update", toolCallId: "t", _meta: { a: 1, b: 2 } }, 2);
	model.apply("s", { sessionUpdate: "tool_call_update", toolCallId: "t", _meta: { a: null } }, 2);
	assert.equal(model.get("s").entities.length, 3);
	assert.deepEqual(model.get("s").entities[2].data._meta, { b: 2 });
	assert.equal(model.get("s").state, "idle");
});
test("pinned schemas reject malformed recognized variants", () => {
	const schema = new WireSchema(2);
	assert.throws(
		() => schema.update({ sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text" } }),
		/Invalid ACP/,
	);
});

test("terminal base64 chunks preserve split UTF-8 and replacement snapshots; compaction chunks append content", () => {
	const model = new SessionModel();
	const bytes = Buffer.from("€");
	model.apply(
		"s",
		{ sessionUpdate: "terminal_output_chunk", terminalId: "t", data: bytes.subarray(0, 1).toString("base64") },
		2,
	);
	model.apply(
		"s",
		{ sessionUpdate: "terminal_output_chunk", terminalId: "t", data: bytes.subarray(1).toString("base64") },
		2,
	);
	assert.equal(model.get("s").entities[0].data.displayOutput, "€");
	model.apply(
		"s",
		{
			sessionUpdate: "terminal_update",
			terminalId: "t",
			output: { data: Buffer.from("snapshot").toString("base64") },
		},
		2,
	);
	assert.equal(model.get("s").entities[0].data.displayOutput, "snapshot");
	model.apply(
		"s",
		{ sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: { type: "text", text: "Summary" } },
		2,
	);
	assert.deepEqual(model.get("s").entities[1].data.summary, [{ type: "text", text: "Summary" }]);
});

test("new connections do not inherit an old peer's sessions or capability claims", async (t) => {
	const client = new AcpClient();
	t.after(() => client.disconnect());
	await client.connect(launch());
	const first = await client.newSession("/srv/project");
	await client.prompt(first, "hello");
	await waitFor(client, () => client.model.get(first).state === "idle");
	client.disconnect();
	assert.equal(client.capability("com.example/tasks"), undefined);
	await client.connect(launch());
	const second = await client.newSession("/srv/project");
	assert.equal(first, second);
	assert.equal(client.model.get(second).entities.length, 0);
	await assert.rejects(client.configure(second, "unknown", "value"), /not advertised/);
});
