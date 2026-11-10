/** Retained sessions reject a changed workspace and replay history without prompting. */
import { createInterface } from "node:readline";

const version = process.argv.includes("--v1") ? 1 : 2;
const saved = { sessionId: "retained", cwd: "/peer/saved" };
const methods = [];
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (!request.method) continue;
	methods.push(request.method);
	const result = (value) => send({ id: request.id, result: value });
	switch (request.method) {
		case "initialize":
			result({
				protocolVersion: version,
				...(version === 1
					? {
							agentInfo: { name: "session-fixture", version: "1" },
							agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
						}
					: { info: { name: "session-fixture", version: "1" }, capabilities: { session: {} } }),
			});
			break;
		case "session/new":
			result({ sessionId: "new" });
			break;
		case "session/list":
			result({ sessions: [{ sessionId: "new", cwd: "/peer/default" }, saved] });
			break;
		case "session/load":
		case "session/resume":
			if (request.params.sessionId !== saved.sessionId || request.params.cwd !== saved.cwd) {
				send({ id: request.id, error: { code: -32602, message: "Session workspace cannot change" } });
				break;
			}
			send({
				method: "session/update",
				params: {
					sessionId: saved.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						...(version === 2 ? { messageId: "saved-answer" } : {}),
						content: { type: "text", text: "Retained conversation" },
					},
				},
			});
			result({});
			break;
		case "_com.example/requests":
			result({ methods });
			break;
		default:
			if (request.id !== undefined) send({ id: request.id, error: { code: -32601, message: "Method not found" } });
	}
}
