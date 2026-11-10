// Deterministic ACP test peer, not a production harness or control plane.
import { StringDecoder } from "node:string_decoder";

const version = process.argv.includes("--v1") ? 1 : process.argv.includes("--unsupported") ? 9 : 2;
const legacy = process.argv.includes("--legacy");
const permission = process.argv.includes("--permission");
let sequence = 0;
let session = "fixture-main";
let initialized = false;
let authenticated = false;
let pendingPrompt;
let buffer = "";
const decoder = new StringDecoder("utf8");
const pending = new Map();
const send = (record) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...record })}\n`);
const update = (value) => send({ method: "session/update", params: { sessionId: session, update: value } });
const text = (role, messageId, value) =>
	update({
		sessionUpdate: `${role}_message_chunk`,
		...(version === 2 ? { messageId } : {}),
		content: { type: "text", text: value },
	});

async function handle(record) {
	if (record.method === undefined) {
		pending.get(record.id)?.(record.error ? { error: record.error } : record.result);
		pending.delete(record.id);
		return;
	}
	const params = record.params ?? {};
	const result = (value) => send({ id: record.id, result: value });
	const error = (code, message) => send({ id: record.id, error: { code, message } });
	if (record.method === "initialize") {
		if (legacy && params.protocolVersion !== 1) {
			error(-32602, "This fixture requires v1");
			return;
		}
		initialized = true;
		const capabilities = {
			_meta: process.argv.includes("--no-tasks") ? {} : { "com.example/tasks": { version: 1 } },
		};
		if (version === 1) Object.assign(capabilities, { loadSession: true, sessionCapabilities: { list: {} } });
		else Object.assign(capabilities, { session: {} });
		result({
			protocolVersion: version,
			...(version === 1
				? { agentCapabilities: capabilities, agentInfo: { name: "fixture", version: "1" } }
				: { capabilities, info: { name: "fixture", version: "1" } }),
			authMethods: process.argv.includes("--auth")
				? [
						{
							...(version === 2 ? { methodId: "fixture-login", type: "agent" } : { id: "fixture-login" }),
							name: "Fixture login",
						},
					]
				: [],
		});
		return;
	}
	if (!initialized) {
		error(-32600, "Initialize required");
		return;
	}
	if (record.method === "session/new") {
		if (process.argv.includes("--auth") && !authenticated) {
			error(-32000, "Authentication required");
			return;
		}
		session = `fixture-${++sequence}`;
		result({ sessionId: session, configOptions: [], availableCommands: [] });
		return;
	}
	if (record.method === "session/list") {
		result({ sessions: [{ sessionId: session, cwd: "/srv/project", title: "Fixture" }] });
		return;
	}
	if (record.method === "session/resume" || record.method === "session/load") {
		session = params.sessionId;
		text("agent", "retained", "Retained answer");
		if (version === 2) update({ sessionUpdate: "state_update", state: "idle" });
		result({});
		return;
	}
	if (record.method === "session/prompt") {
		pendingPrompt = record.id;
		const userId = `user-${++sequence}`;
		if (version === 2) {
			update({ sessionUpdate: "state_update", state: "running" });
			text("user", userId, params.prompt[0].text);
			result({ messageId: userId });
		}
		if (params.prompt[0].text === "hang") return;
		if (params.prompt[0].text === "malformed") {
			update({ sessionUpdate: "agent_message_chunk", messageId: "broken", content: { type: "text" } });
			return;
		}
		if (permission) {
			const answer = await new Promise((resolve) => {
				pending.set("permission-1", resolve);
				send({
					id: "permission-1",
					method: "session/request_permission",
					params: {
						sessionId: session,
						...(version === 2
							? { title: "Read test file" }
							: {
									toolCall: { toolCallId: "tool-1", title: "Read test file", kind: "read", status: "pending" },
								}),
						options: [
							{ optionId: "once", name: "Allow once", kind: "allow_once" },
							{ optionId: "deny", name: "Deny", kind: "reject_once" },
						],
					},
				});
			});
			text("agent", "permission-answer", JSON.stringify(answer));
		}
		setTimeout(() => {
			text("agent", "answer", "Hello\u2028world ");
			text("agent", "answer", "from ACP");
			update({
				sessionUpdate: version === 2 ? "tool_call_update" : "tool_call",
				toolCallId: "tool-1",
				title: "Read test file",
				kind: "read",
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: "3 assertions passed" } }],
			});
			if (version === 2) update({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
			else result({ stopReason: "end_turn" });
		}, 30);
		return;
	}
	if (record.method === "session/cancel") {
		if (version === 2) update({ sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" });
		else if (pendingPrompt !== undefined) send({ id: pendingPrompt, result: { stopReason: "cancelled" } });
		return;
	}
	if (record.method === "authenticate" || record.method === "auth/login") {
		authenticated = true;
		result({});
		return;
	}
	if (record.method === "auth/logout") {
		authenticated = false;
		result({});
		return;
	}
	if (record.method === "session/close") {
		result({});
		return;
	}
	if (record.method === "session/set_config_option") {
		result({ configOptions: [] });
		return;
	}
	if (record.method === "_com.example/tasks/list") {
		result({ tasks: [{ id: "inspect", title: "Inspect failing test", status: "running" }] });
		return;
	}
	if (record.method === "_com.example/tasks/callback") {
		const value = await new Promise((resolve) => {
			pending.set("callback-1", resolve);
			send({ id: "callback-1", method: "_com.example/ui/ping", params: { text: "ping" } });
		});
		result(value);
		return;
	}
	if (record.method === "_com.example/tasks/local-operation") {
		const value = await new Promise((resolve) => {
			pending.set("local-1", resolve);
			send({ id: "local-1", method: "terminal/create", params: { command: "forbidden", sessionId: session } });
		});
		result(value);
		return;
	}
	if (record.id !== undefined) error(-32601, "Method not found");
}
process.stdin.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.trim()) void handle(JSON.parse(line));
		newline = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));
