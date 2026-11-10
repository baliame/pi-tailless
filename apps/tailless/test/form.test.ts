/** Form validation checks cover constraints and explicit acceptance/cancellation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpClient } from "../src/client.ts";
import { elicitForm } from "../src/form.ts";
import { FrontendUI } from "../src/ui.ts";
import { MemoryTerminal } from "./memory-terminal.ts";

test("form validation retries invalid email/range and accepts strings, booleans and arrays", async (t) => {
	const ui = new FrontendUI(new AcpClient(), { terminal: new MemoryTerminal() });
	t.after(() => ui.stop());
	const inputs = ["invalid-email", "0", '["a"]', "user@example.com", "3", '["a","b"]'];
	ui.input = async () => inputs.shift();
	ui.select = async () => "true";
	ui.confirm = async () => true;
	let errors = 0;
	ui.notify = () => {
		errors++;
	};
	const result = await elicitForm(
		ui,
		{
			message: "Details",
			requestedSchema: {
				type: "object",
				required: ["email", "count", "enabled", "choices"],
				properties: {
					email: { type: "string", format: "email" },
					count: { type: "integer", minimum: 1 },
					enabled: { type: "boolean" },
					choices: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1 },
				},
			},
		},
		new AbortController().signal,
	);
	assert(errors > 0);
	assert.deepEqual(result, {
		action: "accept",
		content: { email: "user@example.com", count: 3, enabled: true, choices: ["a", "b"] },
	});
});
test("cancelling a form never returns accept", async (t) => {
	const ui = new FrontendUI(new AcpClient(), { terminal: new MemoryTerminal() });
	t.after(() => ui.stop());
	ui.input = async () => undefined;
	assert.deepEqual(
		await elicitForm(
			ui,
			{ message: "Input", requestedSchema: { type: "object", properties: { text: { type: "string" } } } },
			new AbortController().signal,
		),
		{ action: "cancel" },
	);
});
