/** Authentication, cancellation and local-resource boundary checks. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { AcpClient } from "../src/client.ts";

for (const version of [1, 2] as const) {
	test(`v${version} authentication uses advertised methods and cancellation settles foreground work`, async (t) => {
		const client = new AcpClient();
		t.after(() => client.disconnect());
		await client.connect({
			command: process.execPath,
			args: [resolve("examples/fixture-peer.mjs"), "--auth", ...(version === 1 ? ["--v1"] : [])],
			timeoutMs: 5000,
		});
		await assert.rejects(client.newSession("/remote/project"), /Authentication required/);
		await assert.rejects(client.login("unadvertised"), /not advertised/);
		await client.login("fixture-login");
		const id = await client.newSession("/remote/project");
		const running = new Promise<void>((resolve) => {
			client.model.onChange = () => {
				if (client.model.get(id).state === "running") resolve();
			};
		});
		const prompt = client.prompt(id, "hang");
		await running;
		const idle = new Promise<void>((resolve) => {
			client.model.onChange = () => {
				if (client.model.get(id).state === "idle") resolve();
			};
		});
		client.cancel(id);
		await prompt;
		await idle;
		assert.equal(client.model.get(id).stopReason, "cancelled");
	});
}
test("unadvertised local command delegation returns an error without executing a command", async (t) => {
	const client = new AcpClient();
	t.after(() => client.disconnect());
	await client.connect({ command: process.execPath, args: [resolve("examples/fixture-peer.mjs")], timeoutMs: 5000 });
	assert.deepEqual(await client.request("_com.example/tasks/local-operation", {}), {
		error: { code: -32601, message: "Method not found" },
	});
});
test("remote cwd is independent from the local filesystem and must still be absolute", async (t) => {
	const client = new AcpClient();
	t.after(() => client.disconnect());
	await client.connect({ command: process.execPath, args: [resolve("examples/fixture-peer.mjs")], timeoutMs: 5000 });
	await assert.rejects(client.newSession("relative/path"), /absolute/);
	assert.equal(await client.newSession("/this/path/does/not/exist/locally"), "fixture-1");
});
