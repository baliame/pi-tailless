/** Exercise native session selection against a peer enforcing retained workspaces. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { FrontendApp } from "../src/app.ts";
import { object } from "../src/json.ts";
import { MemoryTerminal } from "./memory-terminal.ts";

for (const version of [1, 2] as const) {
	for (const cancel of [false, true]) {
		test(
			`v${version} session picker ${cancel ? "cancels without resuming" : "resumes the selected workspace"}`,
			{
				timeout: 10000,
			},
			async (t) => {
				const launch = {
					command: process.execPath,
					args: [resolve("test/fixtures/session-peer.mjs"), ...(version === 1 ? ["--v1"] : [])],
					timeoutMs: 5000,
				};
				const app = new FrontendApp({
					launch,
					peerCwd: "/peer/default",
					extensions: [],
					keybindings: {},
					theme: "dark",
				});
				app.ui.tui.terminal = new MemoryTerminal();
				t.after(() => app.stop());
				await app.client.connect(launch);
				await app.client.newSession("/peer/default");
				const completed = Promise.withResolvers<void>();
				app.ui.notify = (message) => completed.reject(new Error(message));
				app.ui.select = async (_title, options) => {
					assert.deepEqual(options, ["new", "retained"]);
					if (cancel) completed.resolve();
					return cancel ? undefined : "retained";
				};
				app.client.model.onChange = () => {
					if (app.client.model.visible === "retained" && app.client.model.get("retained").active)
						completed.resolve();
				};
				app.ui.onSubmit("/sessions");
				await completed.promise;
				await setImmediate();
				const { methods } = object(await app.client.request("_com.example/requests", {}));
				assert(Array.isArray(methods));
				assert.equal(methods.includes("session/prompt"), false);
				assert.equal(
					methods.filter((method) => method === "session/load" || method === "session/resume").length,
					cancel ? 0 : 1,
				);
				if (cancel) assert.equal(app.client.model.visible, "new");
				else {
					assert.equal(app.client.model.get("retained").cwd, "/peer/saved");
					assert(JSON.stringify(app.client.model.get("retained").entities).includes("Retained conversation"));
				}
			},
		);
	}
}
