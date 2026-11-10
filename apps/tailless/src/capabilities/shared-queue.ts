/** Independently loaded L3 queue commands and a presentation-only FIFO widget. */
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AttachClientModule } from "../experimental/multi-client-attach.ts";
import type { ExtensionAPI } from "../extensions.ts";
import { type Json, message, object, optionalObject } from "../json.ts";
import { contentText } from "../model.ts";

interface QueueEntry {
	id: string;
	clientId: string;
	prompt: Json[];
	receivedAt: string;
}

interface Snapshot {
	sessionId: string;
	revision: number;
	entries: QueueEntry[];
}

const text = { type: "string" };
const snapshotSchema = {
	type: "object",
	required: ["sessionId", "revision", "entries"],
	properties: {
		sessionId: text,
		revision: { type: "integer", minimum: 0 },
		entries: {
			type: "array",
			items: {
				type: "object",
				required: ["id", "clientId", "prompt", "receivedAt"],
				properties: {
					id: text,
					clientId: text,
					receivedAt: text,
					prompt: {
						type: "array",
						items: {
							oneOf: [
								{ type: "object", required: ["type", "text"], properties: { type: { const: "text" }, text } },
								{
									type: "object",
									required: ["type", "uri"],
									properties: { type: { const: "resource_link" }, uri: text, name: text },
								},
							],
						},
					},
				},
			},
		},
		change: {
			type: "object",
			required: ["type", "entryId"],
			properties: {
				type: { enum: ["enqueue", "start", "pop", "withdraw", "disconnect", "close"] },
				entryId: text,
				byClientId: text,
			},
		},
	},
};

/** Consume the queue API and public participant labels without importing a backend. */
export default function sharedQueue(api: ExtensionAPI): void {
	for (const id of ["multi-client-attach", "prompt-delivery"])
		if (!api.client.modules.some((module) => module.id === id)) throw new Error(`Shared queue requires ${id}`);
	// The dependency fixes this registration's type; reuse its service across loader boundaries.
	const attach = api.client.modules.find((module) => module.id === "multi-client-attach") as AttachClientModule;
	const ajv = new Ajv2020({ strict: false });
	const validate = ajv.compile<Snapshot>(snapshotSchema);
	const validatePop = ajv.compile<Snapshot & { removed: QueueEntry | null }>({
		...snapshotSchema,
		required: [...snapshotSchema.required, "removed"],
		properties: {
			...snapshotSchema.properties,
			removed: { oneOf: [snapshotSchema.properties.entries.items, { type: "null" }] },
		},
	});
	const snapshots = new Map<string, Snapshot>();
	const pending = new Map<string, Promise<Snapshot>>();
	const lifetime = new AbortController();
	const memberships = new Set<string>();
	let displayed = "";
	let disposed = false;
	api.registerCapability("com.example/shared-queue", { version: 1 });

	const available = () => optionalObject(api.client.capability("com.example/shared-queue")).version === 1;
	const render = () => {
		if (disposed) return;
		const id = api.sessionId();
		const snapshot = id && api.client.model.get(id).active ? snapshots.get(id) : undefined;
		const key = snapshot ? `${id}:${snapshot.revision}:${attach.revision}` : "";
		if (key === displayed) return;
		displayed = key;
		api.ui.setWidget(
			"queue",
			snapshot
				? [
						`Waiting · ${snapshot.entries.length} · revision ${snapshot.revision}`,
						...snapshot.entries.map(
							(entry, index) =>
								`${index + 1}. ${attach.clients(snapshot.sessionId).get(entry.clientId) ?? entry.clientId.slice(0, 8)}: ${entry.prompt.map(contentText).join(" ")}`,
						),
					]
				: undefined,
			"aboveEditor",
		);
	};
	const receive = (value: Json): Snapshot => {
		if (!validate(value)) throw new Error(`Invalid shared queue snapshot: ${JSON.stringify(validate.errors)}`);
		const snapshot = value;
		const id = snapshot.sessionId;
		const previous = snapshots.get(id);
		if (!previous || snapshot.revision > previous.revision) snapshots.set(id, snapshot);
		render();
		return snapshots.get(id)!;
	};
	const read = (id: string): Promise<Snapshot> => {
		if (!available()) return Promise.reject(new Error("Shared queue API unavailable"));
		const current = pending.get(id);
		if (current) return current;
		const result = api.client
			.request("_com.example/shared-queue/list", { sessionId: id }, lifetime.signal)
			.then((value) => {
				if (disposed) throw new Error("Queue extension disposed");
				return receive(value);
			})
			.finally(() => pending.delete(id));
		pending.set(id, result);
		return result;
	};
	const refresh = () => {
		if (!api.client.connected) {
			snapshots.clear();
			memberships.clear();
			render();
			return;
		}
		for (const session of api.client.model.sessions.values()) {
			if (!session.active) {
				memberships.delete(session.id);
				snapshots.delete(session.id);
				continue;
			}
			if (!memberships.has(session.id) && available()) {
				memberships.add(session.id);
				void read(session.id).catch((error) => {
					if (!disposed && api.client.connected) api.ui.notify(message(error));
				});
			}
		}
		render();
	};
	const session = () => {
		const id = api.sessionId();
		if (!id || !api.client.model.get(id).active) throw new Error("No attached session");
		return id;
	};
	api.onNotification("_com.example/shared-queue/update", (value) => {
		receive(value);
	});
	api.registerCommand("queue", "Inspect shared waiting input", async () => {
		await read(session());
	});
	api.registerCommand("queue-pop", "Remove the next waiting message without executing it", async () => {
		const id = session();
		const snapshot = snapshots.get(id) ?? (await read(id));
		const head = snapshot.entries[0];
		try {
			const result = await api.client.request(
				"_com.example/shared-queue/pop",
				{
					sessionId: id,
					expectedHeadId: head?.id ?? null,
				},
				lifetime.signal,
			);
			if (!validatePop(result)) throw new Error(`Invalid shared queue pop: ${JSON.stringify(validatePop.errors)}`);
			receive(result);
			api.ui.notify(result.removed === null ? "Queue is empty" : "Waiting message removed");
		} catch (error) {
			const failure = object(error);
			if (failure.code !== -32600 || optionalObject(failure.data).reason !== "queue_changed") throw error;
			await read(id);
			api.ui.notify("Queue changed; no message removed. Check the queue before trying again.");
		}
	});
	api.onDispose(api.client.model.subscribe(refresh));
	api.onDispose(() => {
		disposed = true;
		lifetime.abort();
		snapshots.clear();
		memberships.clear();
		api.ui.setWidget("queue", undefined);
	});
	refresh();
}
