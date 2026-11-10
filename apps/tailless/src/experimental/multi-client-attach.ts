/** Optional client profile for the pinned equal-participant attachment proposal. */
import type { AcpClient } from "../client.ts";
import { array, type Json, type ObjectValue, object, string } from "../json.ts";
import type { ClientProtocolModule } from "../modules.ts";

export const attachRevision = "98e098b7ca7c289066d20f73411ce649081d378b";
const text = { type: "string" };
const participantSchema: ObjectValue = {
	type: "object",
	required: ["clientId", "name", "version"],
	properties: { clientId: text, name: text, version: text },
};

export interface AttachClientModule extends ClientProtocolModule {
	readonly revision: number;
	clients(sessionId: string): ReadonlyMap<string, string>;
}

/** Create attach/detach commands and draft update validators without a harness dependency. */
export function multiClientAttach(): AttachClientModule {
	const clients = new Map<string, Map<string, string>>();
	const empty = new Map<string, string>();
	let revision = 0;
	const remember = (sessionId: string, value: Json | undefined) => {
		const participant = object(value);
		let names = clients.get(sessionId);
		if (!names) {
			names = new Map();
			clients.set(sessionId, names);
		}
		names.set(string(participant.clientId), string(participant.name));
		revision++;
	};
	return {
		id: "multi-client-attach",
		echo: "remote",
		observe: (id, update, client) => {
			if (client.version !== 1 || !client.model.get(id).active) return;
			if (
				[
					"user_message_chunk",
					"agent_message_chunk",
					"agent_thought_chunk",
					"tool_call",
					"tool_call_update",
				].includes(string(update.sessionUpdate))
			) {
				client.model.get(id).state = "running";
				client.model.changed();
			}
		},
		get revision() {
			return revision;
		},
		clients: (id) => clients.get(id) ?? empty,
		disconnected: () => {
			clients.clear();
			revision++;
		},
		profile: { attach: { revision: attachRevision, profile: 1 } },
		methods: {
			"session/attach": {
				request: (): ObjectValue => ({
					type: "object",
					required: ["sessionId"],
					properties: {
						sessionId: text,
						historyPolicy: { enum: ["full", "pending_only", "none", "after_message"] },
						afterMessageId: text,
						clientId: text,
						clientInfo: {
							type: "object",
							required: ["name", "version"],
							properties: { name: text, version: text },
						},
					},
				}),
				response: (version): ObjectValue => ({
					type: "object",
					required: ["sessionId", "clientId", "connectedClients", "historyPolicy"],
					properties: {
						sessionId: text,
						clientId: text,
						connectedClients: { type: "array", items: participantSchema },
						historyPolicy: { enum: ["full", "pending_only", "none", "after_message"] },
						history: {
							type: "array",
							items: {
								oneOf: [
									{
										type: "object",
										required: ["type", "update", "timestamp"],
										properties: {
											type: { const: "session_update" },
											timestamp: text,
											update: { $ref: `urn:pi-acp:v${version}#/$defs/SessionUpdate` },
										},
									},
									{
										type: "object",
										required: ["type", "toolCallId", "status", "request"],
										properties: {
											type: { const: "permission_request" },
											toolCallId: text,
											status: { const: "pending" },
											request: {
												type: "object",
												required: ["method", "params"],
												properties: {
													method: { enum: ["session/request_permission", "elicitation/create"] },
													params: { type: "object" },
												},
											},
										},
									},
								],
							},
						},
					},
					anyOf: [
						{ properties: { historyPolicy: { const: "none" } }, not: { required: ["history"] } },
						{
							properties: { historyPolicy: { enum: ["full", "pending_only", "after_message"] } },
							required: ["history"],
						},
					],
				}),
				apply: (_params, result, client) => {
					const id = string(result.sessionId);
					clients.set(id, new Map());
					for (const actor of array(result.connectedClients)) remember(id, actor);
					clients.get(id)!.set(string(result.clientId), "you");
					revision++;
					if (result.historyPolicy === "full") client.model.beginReplay(id);
					for (const entry of array(result.history).map((entry) => object(entry)))
						if (entry.type === "session_update") client.applyUpdate(id, object(entry.update), "history");
					client.model.activate(id, client.model.get(id).cwd, result);
				},
			},
			"session/detach": {
				request: (): ObjectValue => ({ type: "object", required: ["sessionId"], properties: { sessionId: text } }),
				response: (): ObjectValue => ({
					type: "object",
					required: ["sessionId", "status"],
					properties: { sessionId: text, status: { const: "detached" } },
				}),
				apply: (_params, result, client) => {
					clients.delete(string(result.sessionId));
					revision++;
					client.model.get(string(result.sessionId)).active = false;
					client.model.changed();
				},
			},
		},
		updates: {
			prompt_received: {
				schema: (version) =>
					updateSchema("prompt_received", {
						prompt: { type: "array", items: { $ref: `urn:pi-acp:v${version}#/$defs/ContentBlock` } },
						sentBy: participantSchema,
						messageId: text,
					}),
				apply: (id, update, client) => {
					remember(id, update.sentBy);
					client.model.apply(
						id,
						{ sessionUpdate: "user_message", content: update.prompt!, messageId: update.messageId! },
						2,
					);
					if (client.version === 1) {
						client.model.get(id).state = "running";
						client.model.changed();
					}
				},
			},
			turn_complete: {
				schema: () =>
					updateSchema("turn_complete", {
						stopReason: { enum: ["end_turn", "cancelled", "error", "max_tokens"] },
					}),
				apply: (id, update, client) => {
					if (client.version === 1) client.model.finishTurn(id, string(update.stopReason));
				},
			},
			permission_resolved: {
				schema: () =>
					updateSchema("permission_resolved", {
						toolCallId: text,
						chosenOptionId: { type: ["string", "null"] },
						resolvedBy: participantSchema,
					}),
				apply: (id, update, client) => {
					remember(id, update.resolvedBy);
					client.model.changed();
				},
			},
			client_disconnected: {
				schema: () => updateSchema("client_disconnected", { client: participantSchema, timestamp: text }),
				apply: (id, update, client) => {
					clients.get(id)?.delete(string(object(update.client).clientId));
					revision++;
					client.model.changed();
				},
			},
		},
		commands: {
			attach: async (args, client, ui) => {
				const sessions = (await client.listSessions()).map((entry) => object(entry));
				const id =
					args ||
					(await ui.select(
						"Attach session",
						sessions.map((entry) => string(entry.sessionId)),
					));
				if (!id) return;
				const entry = sessions.find((entry) => entry.sessionId === id);
				if (entry) client.model.get(id).cwd = string(entry.cwd);
				await attachSession(client, id);
			},
			detach: async (args, client) => {
				const id = args || client.model.visible;
				if (!id) throw new Error("No session to detach");
				await client.protocolRequest("session/detach", { sessionId: id });
			},
		},
	};
}

/** Attach using the installed profile, optionally selecting a draft history policy. */
export async function attachSession(client: AcpClient, sessionId: string, options: ObjectValue = {}): Promise<void> {
	await client.protocolRequest("session/attach", { ...options, sessionId });
}

function updateSchema(tag: string, properties: Record<string, Json>): ObjectValue {
	return {
		type: "object",
		required: ["sessionUpdate", ...Object.keys(properties)],
		properties: { sessionUpdate: { const: tag }, ...properties },
	};
}
