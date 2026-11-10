/** Frontend presentation state, independent of model providers and harness implementations. */
import { StringDecoder } from "node:string_decoder";
import { array, type Json, type ObjectValue, object, optionalObject, string } from "./json.ts";

export interface Entity {
	id: string;
	kind: string;
	data: ObjectValue;
}
export interface Session {
	id: string;
	cwd: string;
	state: string;
	active: boolean;
	entities: Entity[];
	index: Map<string, Entity>;
	config: Json[];
	commands: Json[];
	usage?: Json;
	stopReason?: string;
}

/** Reduce protocol updates in receive order, preserving entity identity. */
export class SessionModel {
	readonly sessions = new Map<string, Session>();
	visible?: string;
	onChange: () => void = () => {};
	private legacy = new Map<string, { kind: string; id: string }>();
	private sequence = 0;
	private terminalDecoders = new WeakMap<Entity, StringDecoder>();
	private listeners = new Set<() => void>();

	/** Observe presentation changes without replacing the UI's callback. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Notify the UI and independently owned presentation consumers. */
	changed(): void {
		this.onChange();
		for (const listener of this.listeners) listener();
	}

	/** Acquire a session, including updates received before its creation response. */
	get(id: string): Session {
		let session = this.sessions.get(id);
		if (!session) {
			session = {
				id,
				cwd: "",
				state: "idle",
				active: false,
				entities: [],
				index: new Map(),
				config: [],
				commands: [],
			};
			this.sessions.set(id, session);
		}
		return session;
	}

	/** Activate a session without overwriting state that arrived before the response. */
	activate(id: string, cwd: string, result: ObjectValue): void {
		const session = this.get(id);
		session.cwd = cwd;
		session.active = true;
		if (result.configOptions !== undefined) session.config = array(result.configOptions);
		if (result.availableCommands !== undefined) session.commands = array(result.availableCommands);
		this.visible = id;
		this.changed();
	}

	/** Reset replayed presentation before a full load or resume. */
	beginReplay(id: string): void {
		const session = this.get(id);
		session.entities = [];
		session.index.clear();
		this.legacy.delete(id);
	}

	/** A transport failure makes all activity unknown, not cancelled. */
	disconnect(): void {
		for (const session of this.sessions.values()) {
			session.active = false;
			session.state = "disconnected";
		}
		this.changed();
	}

	/** Apply a schema-validated update from either ACP version. */
	apply(id: string, update: ObjectValue, version: 1 | 2): void {
		const session = this.get(id);
		const tag = string(update.sessionUpdate);
		if (tag === "state_update") {
			session.state = string(update.state);
			if (typeof update.stopReason === "string") session.stopReason = update.stopReason;
		} else if (tag === "config_option_update") session.config = array(update.configOptions);
		else if (tag === "available_commands_update") session.commands = array(update.availableCommands);
		else if (tag === "usage_update") session.usage = update;
		else if (tag.endsWith("message_chunk") || tag === "agent_thought_chunk") {
			const kind = tag.replace(/_chunk$/, "");
			let entityId = typeof update.messageId === "string" ? update.messageId : undefined;
			if (!entityId) {
				const previous = this.legacy.get(id);
				entityId = previous?.kind === kind ? previous.id : `legacy-${++this.sequence}`;
				this.legacy.set(id, { kind, id: entityId });
			}
			const entity = this.entity(session, kind, entityId);
			const content = object(update.content);
			const items = array(entity.data.content);
			const previous = items.at(-1);
			if (
				content.type === "text" &&
				previous &&
				typeof previous === "object" &&
				!Array.isArray(previous) &&
				previous.type === "text"
			) {
				previous.text = string(previous.text) + string(content.text);
			} else items.push(content);
			entity.data.content = items;
		} else if (["user_message", "agent_message", "agent_thought"].includes(tag)) {
			this.patch(this.entity(session, tag, string(update.messageId)), update);
		} else if (tag === "tool_call" || tag === "tool_call_update") {
			this.legacy.delete(id);
			this.patch(this.entity(session, "tool", string(update.toolCallId)), update);
		} else if (tag === "tool_call_content_chunk") {
			const entity = this.entity(session, "tool", string(update.toolCallId));
			entity.data.content = [...array(entity.data.content), update.content];
		} else if (tag === "terminal_update") {
			const entity = this.entity(session, "terminal", string(update.terminalId));
			this.patch(entity, update);
			if (update.output !== undefined) {
				const decoder = new StringDecoder("utf8");
				this.terminalDecoders.set(entity, decoder);
				entity.data.displayOutput =
					update.output === null ? "" : decoder.write(Buffer.from(string(object(update.output).data), "base64"));
			}
		} else if (tag === "terminal_output_chunk") {
			const entity = this.entity(session, "terminal", string(update.terminalId));
			let decoder = this.terminalDecoders.get(entity);
			if (!decoder) {
				decoder = new StringDecoder("utf8");
				this.terminalDecoders.set(entity, decoder);
			}
			entity.data.displayOutput =
				String(entity.data.displayOutput ?? "") + decoder.write(Buffer.from(string(update.data), "base64"));
		} else if (tag === "plan" || tag === "plan_update") {
			this.patch(this.entity(session, "plan", typeof update.planId === "string" ? update.planId : "plan"), update);
		} else if (tag === "compaction_update" || tag === "compaction_summary_chunk") {
			const entity = this.entity(session, "compaction", string(update.compactionId));
			if (tag === "compaction_summary_chunk") entity.data.summary = [...array(entity.data.summary), update.content];
			else this.patch(entity, update);
		} else if (tag === "notice") this.patch(this.entity(session, "notice", `notice-${++this.sequence}`), update);
		else if (tag === "session_info_update") this.patch(this.entity(session, "session-info", "info"), update);
		else if (version === 1 && tag === "current_mode_update") this.patch(this.entity(session, "mode", "mode"), update);
		this.changed();
	}

	/** Mark v1 completion using its response rather than treating v2 acceptance as completion. */
	finishTurn(id: string, reason: string): void {
		const session = this.get(id);
		session.state = "idle";
		session.stopReason = reason;
		this.legacy.delete(id);
		this.changed();
	}

	private entity(session: Session, kind: string, id: string): Entity {
		const key = `${kind}:${id}`;
		let entity = session.index.get(key);
		if (!entity) {
			entity = { id, kind, data: {} };
			session.index.set(key, entity);
			session.entities.push(entity);
		}
		return entity;
	}

	private patch(entity: Entity, update: ObjectValue): void {
		const oldMeta = optionalObject(entity.data._meta);
		for (const [key, value] of Object.entries(update)) {
			if (key !== "_meta" && key !== "sessionUpdate") entity.data[key] = value;
		}
		if (update._meta === null) delete entity.data._meta;
		else if (update._meta !== undefined) {
			for (const [key, value] of Object.entries(object(update._meta))) {
				if (value === null) delete oldMeta[key];
				else oldMeta[key] = value;
			}
			entity.data._meta = oldMeta;
		}
	}
}

/** Render a content item as a safe textual fallback when needed. */
export function contentText(value: Json): string {
	const item = object(value, "content item");
	if (item.type === "text") return string(item.text);
	if (item.type === "content") return contentText(item.content);
	if (item.type === "diff")
		return `${String(item.path)}\n---\n${String(item.oldText ?? "")}\n+++\n${String(item.newText)}`;
	if (item.type === "resource_link") return `${String(item.name ?? "Resource")}: ${String(item.uri)}`;
	if (item.type === "resource") return String(optionalObject(item.resource).text ?? optionalObject(item.resource).uri);
	if (item.type === "terminal") return `[Terminal ${String(item.terminalId)}]`;
	return `[${String(item.type ?? "Unsupported content")}${item.mimeType ? `: ${String(item.mimeType)}` : ""}]`;
}
