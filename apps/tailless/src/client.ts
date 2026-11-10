/** Version-specific ACP session operations and capability API access. */
import { isDeepStrictEqual } from "node:util";
import { array, type Json, type ObjectValue, object, optionalObject, RpcError, string } from "./json.ts";
import { SessionModel } from "./model.ts";
import type { ClientProtocolModule } from "./modules.ts";
import { type Launch, type RequestHandler, RpcConnection } from "./rpc.ts";
import { WireSchema } from "./schema.ts";

export interface Interaction {
	permission: (params: ObjectValue, signal: AbortSignal) => Promise<Json>;
	form: (params: ObjectValue, signal: AbortSignal) => Promise<Json>;
}

/** One peer connection with native and extension consumers sharing dispatch. */
export class AcpClient {
	readonly model = new SessionModel();
	readonly declarations: ObjectValue = {};
	peerCapabilities: ObjectValue = {};
	version: 1 | 2 = 2;
	connected = false;
	reconnectRequired = false;
	onDiagnostic: (text: string) => void = () => {};
	onStatus: () => void = () => {};
	onCustomRequest: RequestHandler = async () => {
		throw new RpcError(-32601, "Method not found");
	};
	onCustomNotification: (method: string, params: Json) => void = () => {};
	interaction: Interaction = {
		permission: async () => ({ outcome: { outcome: "cancelled" } }),
		form: async () => ({ action: "cancel" }),
	};
	private rpc?: RpcConnection;
	private schema?: WireSchema;
	private schemas = new Map<1 | 2, WireSchema>();
	private replaying = new Set<string>();
	private authMethods: Json[] = [];
	private generation = 0;
	private advertised = "{}";
	private protocolModules: ClientProtocolModule[] = [];

	/** Read optional protocol registrations without importing their implementations. */
	get modules(): readonly ClientProtocolModule[] {
		return this.protocolModules;
	}

	/** Register fixed draft methods, schemas and dispatch before initialization. */
	use(module: ClientProtocolModule): void {
		if (this.rpc) throw new Error("Reconnect to change protocol modules");
		if (this.modules.some((entry) => entry.id === module.id)) throw new Error(`Duplicate module: ${module.id}`);
		for (const entry of this.modules) {
			if (entry.prompt && module.prompt) throw new Error("Duplicate prompt policy");
			if (entry.echo && module.echo) throw new Error("Duplicate echo policy");
			for (const key of ["methods", "fields", "updates", "commands", "profile"] as const)
				for (const name of Object.keys(module[key] ?? {}))
					if (name in (entry[key] ?? {})) throw new Error(`Duplicate protocol registration: ${name}`);
		}
		for (const method of Object.keys(module.methods ?? {}))
			if (
				[
					"initialize",
					"session/new",
					"session/load",
					"session/resume",
					"session/list",
					"session/prompt",
					"session/cancel",
					"session/close",
					"session/set_config_option",
					"session/update",
					"session/request_permission",
					"elicitation/create",
				].includes(method)
			)
				throw new Error(`Cannot replace a baseline method: ${method}`);
		this.protocolModules.push(module);
		if (module.profile)
			this.declare("com.example/experimental-acp", {
				...optionalObject(this.declarations["com.example/experimental-acp"]),
				...module.profile,
			});
	}

	/** Invoke a method declared by an installed protocol module. */
	async protocolRequest(method: string, params: ObjectValue): Promise<ObjectValue> {
		const module = this.modules.find((entry) => method in (entry.methods ?? {}));
		if (!module) throw new Error(`Protocol method unavailable: ${method}`);
		this.requireProtocol(module);
		this.schema!.validate(`draft:${method}:request`, params);
		const result = object(await this.transport().request(method, params));
		this.schema!.validate(`draft:${method}:response`, result);
		module.methods![method]!.apply?.(params, result, this);
		return result;
	}

	/** Require the explicitly selected, version-pinned peer profile. */
	requireProtocol(module: ClientProtocolModule): void {
		const profile = optionalObject(this.capability("com.example/experimental-acp"));
		for (const [key, expected] of Object.entries(module.profile ?? {}))
			if (!isDeepStrictEqual(profile[key], expected))
				throw new Error(`Experimental ${module.id} unavailable or profile mismatch`);
	}

	/** Validate and reduce standard or explicitly registered draft presentation. */
	applyUpdate(sessionId: string, update: ObjectValue, origin: "wire" | "history" = "wire"): void {
		const tag = string(update.sessionUpdate);
		const module = this.modules.find((entry) => tag in (entry.updates ?? {}));
		if (module) {
			this.requireProtocol(module);
			this.schema!.validate(`update:${tag}`, update);
			module.updates![tag]!.apply(sessionId, update, this);
		} else {
			this.schema!.update(update);
			this.model.apply(sessionId, update, this.version);
		}
		if (origin === "wire" && !this.replaying.has(sessionId))
			for (const module of this.modules) module.observe?.(sessionId, update, this);
	}

	/** Initialize v2 first, using a single bounded fresh-connection fallback for v1. */
	async connect(launch: Launch): Promise<void> {
		const pending = this.modules.slice();
		const ordered: ClientProtocolModule[] = [];
		while (pending.length) {
			const index = pending.findIndex((module) =>
				(module.requires ?? []).every((id) => ordered.some((entry) => entry.id === id)),
			);
			if (index < 0) throw new Error("Missing or cyclic protocol module dependencies");
			ordered.push(pending.splice(index, 1)[0]!);
		}
		this.protocolModules = ordered;
		this.schemas.clear();
		if (this.modules.length)
			for (const version of [1, 2] as const) this.schemas.set(version, this.compileSchema(version));
		this.disconnect();
		let firstError: unknown;
		try {
			const result = await this.initialize(launch, 2);
			if (result.protocolVersion === 2) return;
			if (result.protocolVersion !== 1) throw new Error("Unsupported ACP protocol version");
		} catch (error) {
			if (!(error instanceof RpcError) || ![-32022, -32602].includes(error.code)) {
				this.disconnect();
				throw error;
			}
			firstError = error;
		}
		this.onDiagnostic(firstError ? "Peer requires legacy v1 initialization" : "Negotiated ACP v1");
		this.disconnect();
		try {
			const result = await this.initialize(launch, 1);
			if (result.protocolVersion !== 1) throw new Error("Unsupported ACP protocol version");
		} catch (error) {
			this.disconnect();
			throw error;
		}
	}

	/** Terminate the connector, not the remote run. */
	disconnect(): void {
		this.generation++;
		const rpc = this.rpc;
		this.rpc = undefined;
		this.connected = false;
		this.peerCapabilities = {};
		this.replaying.clear();
		for (const module of this.modules) module.disconnected?.();
		rpc?.close();
		this.model.disconnect();
		this.onStatus();
	}

	/** Read the peer's custom API contract declaration. */
	capability(key: string): Json | undefined {
		return optionalObject(this.peerCapabilities._meta)[key];
	}

	/** Publish local declarations at the next initialization. */
	declare(key: string, value: Json | undefined): void {
		if (!/^[a-zA-Z0-9.-]+\/.+/.test(key)) throw new Error("Capability keys require a reverse-DNS namespace");
		if (value === undefined) delete this.declarations[key];
		else this.declarations[key] = value;
		if (this.connected) this.reconnectRequired = this.advertised !== JSON.stringify(this.declarations);
		this.onStatus();
	}

	/** Invoke a documented custom method; the API consumer owns its schema/version semantics. */
	request(method: string, params: Json, signal?: AbortSignal): Promise<Json> {
		if (!method.startsWith("_")) throw new Error("Custom ACP methods must begin with underscore");
		return this.transport().request(method, params, signal);
	}

	/** Emit a custom notification. */
	notify(method: string, params: Json): void {
		if (!method.startsWith("_")) throw new Error("Custom ACP methods must begin with underscore");
		this.transport().notify(method, params);
	}

	/** Create a conversation using the peer's directory syntax. */
	async newSession(cwd: string, mcpServers: Json[] = []): Promise<string> {
		this.requireSessions();
		this.checkCwd(cwd);
		this.checkMcp(mcpServers);
		const result = await this.call("session/new", { cwd, mcpServers }, "NewSessionResponse");
		const id = string(result.sessionId);
		this.model.activate(id, cwd, result);
		return id;
	}

	/** List peer-retained sessions when supported. */
	async listSessions(): Promise<Json[]> {
		this.requireSessions();
		if (this.version === 1 && !optionalObject(this.peerCapabilities.sessionCapabilities).list)
			throw new Error("Session listing unavailable");
		return array((await this.call("session/list", {}, "ListSessionsResponse")).sessions);
	}

	/** Replay an existing session and then synchronize its current state. */
	async resume(id: string, cwd: string): Promise<void> {
		this.requireSessions();
		this.checkCwd(cwd);
		if (this.version === 1 && !this.peerCapabilities.loadSession) throw new Error("Session loading unavailable");
		this.model.beginReplay(id);
		this.replaying.add(id);
		try {
			const result =
				this.version === 2
					? await this.call(
							"session/resume",
							{ sessionId: id, cwd, mcpServers: [], replayFrom: { type: "start" } },
							"ResumeSessionResponse",
						)
					: await this.call("session/load", { sessionId: id, cwd, mcpServers: [] }, "LoadSessionResponse");
			this.model.activate(id, cwd, result);
		} finally {
			this.replaying.delete(id);
		}
	}

	/** Close v2 activity without deleting its retained session. */
	async closeSession(id: string): Promise<void> {
		if (this.version !== 2) throw new Error("Session close requires ACP v2");
		await this.call("session/close", { sessionId: id }, "CloseSessionResponse");
		this.model.get(id).active = false;
		this.model.changed();
	}

	/** Submit text. V2 acknowledgement never ends the foreground run. */
	async prompt(id: string, text: string): Promise<void> {
		const module = this.modules.find((entry) => entry.prompt);
		if (module) {
			this.requireProtocol(module);
			return module.prompt!(id, text, this);
		}
		const echo = this.modules.find((entry) => entry.echo);
		if (echo) this.requireProtocol(echo);
		return this.submitPrompt(id, text, {}, echo?.echo ?? "local");
	}

	/** Submit one turn with declared fields and the selected local echo policy. */
	async submitPrompt(id: string, text: string, fields: ObjectValue, echo: "local" | "remote"): Promise<void> {
		const session = this.model.get(id);
		if (!session.active) throw new Error("Session is not active");
		for (const [key, value] of Object.entries(fields)) this.schema!.validate(`field:${key}`, value);
		if (this.version === 1 && echo === "local") {
			if (session.state === "running") throw new Error("ACP v1 turn already pending");
			session.state = "running";
			this.model.apply(id, { sessionUpdate: "user_message_chunk", content: { type: "text", text } }, 1);
		}
		try {
			const result = await this.call(
				"session/prompt",
				{ sessionId: id, prompt: [{ type: "text", text }], ...fields },
				"PromptResponse",
			);
			if (this.version === 1) this.model.finishTurn(id, string(result.stopReason));
		} catch (error) {
			if (this.version === 1 && this.connected && !(error instanceof RpcError && error.code === -32800))
				this.model.finishTurn(id, "error");
			throw error;
		}
	}

	/** Explicitly cancel foreground work. */
	cancel(id: string): void {
		this.transport().notify("session/cancel", { sessionId: id });
		this.rpc?.abortInteractions(id);
	}

	/** Set a peer-provided session configuration option. */
	async configure(id: string, configId: string, value: string | boolean): Promise<void> {
		const option = this.model
			.get(id)
			.config.map((value) => object(value))
			.find((value) => (this.version === 2 ? value.configId : value.id) === configId);
		if (!option) throw new Error(`Configuration option not advertised: ${configId}`);
		const result = await this.call(
			"session/set_config_option",
			{
				sessionId: id,
				configId,
				value,
				...(this.version === 2
					? { type: typeof value === "boolean" ? "boolean" : "id" }
					: typeof value === "boolean"
						? { type: "boolean" }
						: {}),
			},
			"SetSessionConfigOptionResponse",
		);
		if (result.configOptions !== undefined) this.model.get(id).config = array(result.configOptions);
		this.model.onChange();
	}

	/** Authenticate only with an advertised agent-handled method. */
	async login(methodId: string): Promise<void> {
		const method = this.authMethods
			.map((value) => object(value))
			.find((value) => (this.version === 2 ? value.methodId : value.id) === methodId);
		if (!method) throw new Error("Authentication method not advertised");
		if (method.type && method.type !== "agent")
			throw new Error("Use an interactive external launcher for this authentication flow");
		await this.call(
			this.version === 1 ? "authenticate" : "auth/login",
			{ methodId },
			this.version === 1 ? "AuthenticateResponse" : "LoginAuthResponse",
		);
	}

	/** Expose advertised auth methods for frontend selection. */
	getAuthMethods(): Json[] {
		return this.authMethods;
	}

	/** End agent-handled authentication only where the peer advertises it. */
	async logout(): Promise<void> {
		if (this.version === 2) {
			if (!this.authMethods.length) throw new Error("Logout unavailable");
			await this.call("auth/logout", {}, "LogoutAuthResponse");
		} else {
			if (!optionalObject(this.peerCapabilities.auth).logout) throw new Error("Logout unavailable");
			await this.call("logout", {}, "LogoutResponse");
		}
		this.model.disconnect();
	}

	private async initialize(launch: Launch, version: 1 | 2): Promise<ObjectValue> {
		const generation = this.generation;
		const rpc = new RpcConnection(launch);
		this.rpc = rpc;
		let initialized = false;
		rpc.onDiagnostic = (text) => this.onDiagnostic(text);
		rpc.onClose = (error) => {
			if (this.generation !== generation) return;
			this.connected = false;
			for (const module of this.modules) module.disconnected?.();
			this.model.disconnect();
			this.onDiagnostic(error.message);
			this.onStatus();
		};
		rpc.onNotification = (method, params) => {
			if (!initialized) throw new Error("Peer notification before initialize completed");
			if (method === "session/update") {
				const record = object(params);
				const update = object(record.update);
				const tag = string(update.sessionUpdate);
				if (!this.modules.some((module) => tag in (module.updates ?? {})))
					this.schema!.validate(this.version === 1 ? "SessionNotification" : "UpdateSessionNotification", params);
				this.applyUpdate(string(record.sessionId), update);
			} else if (method.startsWith("_")) this.onCustomNotification(method, params);
		};
		rpc.onRequest = async (method, params, signal, id) => {
			if (!initialized) throw new RpcError(-32600, "Initialize is required");
			if (method === "session/request_permission") {
				this.schema!.validate("RequestPermissionRequest", params);
				return this.interaction.permission(object(params), signal);
			}
			if (method === "elicitation/create") {
				this.schema!.validate("CreateElicitationRequest", params);
				if (object(params).mode !== "form") throw new RpcError(-32602, "Unadvertised elicitation mode");
				return this.interaction.form(object(params), signal);
			}
			if (method.startsWith("_")) return this.onCustomRequest(method, params, signal, id);
			throw new RpcError(-32601, "Method not found");
		};
		const info = { name: "pi-acp-frontend", version: "0.1.0" };
		const capabilities = {
			_meta: this.declarations,
			elicitation: { form: {} },
			...(version === 1 ? { session: { notices: {}, compaction: {} } } : {}),
		};
		const value = await rpc.request(
			"initialize",
			version === 2
				? { protocolVersion: 2, capabilities, info }
				: { protocolVersion: 1, clientCapabilities: capabilities, clientInfo: info },
		);
		const result = object(value);
		if (result.protocolVersion !== 1 && result.protocolVersion !== 2)
			throw new Error("Unsupported ACP protocol version");
		this.version = result.protocolVersion;
		this.schema = this.schemas.get(this.version) ?? this.compileSchema(this.version);
		this.schema.validate("InitializeResponse", value);
		this.peerCapabilities = optionalObject(this.version === 2 ? result.capabilities : result.agentCapabilities);
		this.authMethods = array(result.authMethods);
		this.advertised = JSON.stringify(this.declarations);
		this.model.sessions.clear();
		this.model.visible = undefined;
		initialized = true;
		this.connected = true;
		this.reconnectRequired = false;
		this.onStatus();
		return result;
	}

	private transport(): RpcConnection {
		if (!this.rpc || !this.connected) throw new Error("Not connected");
		return this.rpc;
	}
	private compileSchema(version: 1 | 2): WireSchema {
		const schema = new WireSchema(version);
		for (const module of this.modules) {
			for (const [name, method] of Object.entries(module.methods ?? {})) {
				schema.register(`draft:${name}:request`, method.request(version));
				schema.register(`draft:${name}:response`, method.response(version));
			}
			for (const [name, field] of Object.entries(module.fields ?? {})) schema.register(`field:${name}`, field);
			for (const [name, update] of Object.entries(module.updates ?? {}))
				schema.register(`update:${name}`, update.schema(version));
		}
		return schema;
	}
	private async call(method: string, params: ObjectValue, response: string): Promise<ObjectValue> {
		const result = await this.transport().request(method, params);
		this.schema!.validate(response, result);
		return object(result);
	}
	private requireSessions(): void {
		if (!this.connected) throw new Error("Not connected. Use /connect.");
		if (this.version === 2 && !this.peerCapabilities.session)
			throw new Error("Endpoint does not advertise session support");
	}
	private checkCwd(cwd: string): void {
		if (!/^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(cwd)) throw new Error("Peer cwd must be absolute in the peer's syntax");
	}
	private checkMcp(servers: Json[]): void {
		const capabilities =
			this.version === 2
				? optionalObject(optionalObject(this.peerCapabilities.session).mcp)
				: optionalObject(this.peerCapabilities.mcpCapabilities);
		for (const server of servers) {
			const type = object(server).type ?? "stdio";
			if (type !== "stdio" || this.version === 2) {
				if (!capabilities[string(type)]) throw new Error(`Peer MCP transport unsupported: ${String(type)}`);
			}
		}
	}
}
