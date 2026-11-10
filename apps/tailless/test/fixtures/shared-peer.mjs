/** Draft fixture for frontend replay, pending input, pop races and schema failures. */
import { createInterface } from "node:readline";

const version = process.argv.includes("--v1") ? 1 : 2;
const methods = [];
let revision = 0;
const entries = [];
let stale = false;
const requests = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const error = (id, code, message, data) => send({ id, error: { code, message, ...(data ? { data } : {}) } });
const snapshot = () => ({ sessionId: "shared", revision, entries });
const update = (type, entryId) =>
	send({ method: "_com.example/shared-queue/update", params: { ...snapshot(), change: { type, entryId } } });
const profile = {
	attach: {
		revision: process.argv.includes("--mismatch") ? "other-revision" : "98e098b7ca7c289066d20f73411ce649081d378b",
		profile: 1,
	},
	delivery: { revision: "ee193af58f211a1cbfde30029d5283f9c94c554c", profile: 1 },
};
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (!request.method) continue;
	methods.push(request.method);
	const result = (value) => send({ id: request.id, result: value });
	switch (request.method) {
		case "initialize": {
			const meta = { "com.example/experimental-acp": profile, "com.example/shared-queue": { version: 1 } };
			result({
				protocolVersion: version,
				...(version === 2
					? {
							info: { name: "shared-fixture", version: "1" },
							capabilities: { session: { prompt: { delivery: { queue: {} } } }, _meta: meta },
						}
					: {
							agentInfo: { name: "shared-fixture", version: "1" },
							agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} }, _meta: meta },
						}),
			});
			break;
		}
		case "session/list":
			result({ sessions: [{ sessionId: "shared", cwd: "/peer/shared" }] });
			break;
		case "session/attach": {
			const history = [
				{
					type: "session_update",
					timestamp: "2026-11-09T00:00:00Z",
					update:
						version === 2
							? {
									sessionUpdate: "user_message",
									messageId: "hello",
									content: [{ type: "text", text: "Hello from Panda" }],
								}
							: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hello from Panda" } },
				},
				{
					type: "session_update",
					timestamp: "2026-11-09T00:00:01Z",
					update: {
						sessionUpdate: "agent_message_chunk",
						...(version === 2 ? { messageId: "answer" } : {}),
						content: { type: "text", text: "Shared conversation" },
					},
				},
			];
			result({
				sessionId: "shared",
				clientId: "fixture-client",
				connectedClients: [{ clientId: "panda", name: "Panda", version: "1" }],
				historyPolicy: "full",
				history,
			});
			break;
		}
		case "session/detach":
			result({ sessionId: "shared", status: "detached" });
			break;
		case "session/prompt": {
			if (process.argv.includes("--immediate")) {
				const content = request.params.prompt[0];
				send({
					method: "session/update",
					params: {
						sessionId: "shared",
						update:
							version === 1
								? { sessionUpdate: "user_message_chunk", content }
								: { sessionUpdate: "user_message", messageId: "immediate", content: [content] },
					},
				});
				if (version === 2) {
					send({
						method: "session/update",
						params: { sessionId: "shared", update: { sessionUpdate: "state_update", state: "running" } },
					});
					result({ messageId: "immediate" });
				}
				setTimeout(() => {
					if (version === 1) result({ stopReason: "end_turn" });
					else
						send({
							method: "session/update",
							params: {
								sessionId: "shared",
								update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
							},
						});
				}, 250);
				break;
			}
			const entry = {
				id: `waiting-${++revision}`,
				clientId: "fixture-client",
				prompt: request.params.prompt,
				receivedAt: "2026-11-09T00:00:02Z",
			};
			entries.push(entry);
			requests.set(entry.id, request.id);
			update("enqueue", entry.id);
			break;
		}
		case "_com.example/shared-queue/list":
			result(snapshot());
			break;
		case "_com.example/shared-queue/pop": {
			const head = entries[0];
			if (head) {
				entries.shift();
				revision++;
				error(requests.get(head.id), -32800, "Waiting message removed");
				update("pop", head.id);
			}
			if (stale) {
				stale = false;
				error(request.id, -32600, "Queue changed", { reason: "queue_changed" });
			} else result({ ...snapshot(), removed: head ?? null });
			break;
		}
		case "_com.example/testing/stale":
			stale = true;
			result({});
			break;
		case "_com.example/testing/malformed":
			result({});
			send({
				method: "session/update",
				params: { sessionId: "shared", update: { sessionUpdate: "prompt_received", prompt: [], sentBy: "other" } },
			});
			break;
		case "_com.example/testing/methods":
			result({ methods });
			break;
		default:
			if (request.id !== undefined) error(request.id, -32601, "Method not found");
	}
}
