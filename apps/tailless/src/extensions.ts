/** Frontend-local extension host; API contracts are independent of extension package identity. */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
	AutocompleteProvider,
	Component,
	EditorComponent,
	KeyId,
	OverlayOptions,
	TUI,
} from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import type { AcpClient } from "./client.ts";
import { COMMANDS } from "./commands.ts";
import { type Json, message, RpcError } from "./json.ts";
import type { Entity } from "./model.ts";
import type { MarkdownTransformer } from "./presentation.ts";
import type { Theme } from "./theme.ts";

export interface UI {
	select(title: string, options: string[], signal?: AbortSignal): Promise<string | undefined>;
	confirm(title: string, text: string, signal?: AbortSignal): Promise<boolean>;
	input(title: string, prefill?: string, signal?: AbortSignal): Promise<string | undefined>;
	notify(text: string): void;
	setWidget(key: string, component: Component | string[] | undefined, placement?: "aboveEditor" | "belowEditor"): void;
	setStatus(key: string, text: string | undefined): void;
	setHeader(component: Component | undefined): void;
	setFooter(component: Component | undefined): void;
	setTitle(text: string): void;
	custom<T>(
		factory: (tui: TUI, done: (value: T) => void) => Component,
		options?: OverlayOptions & { signal?: AbortSignal },
	): Promise<T | undefined>;
	getEditorText(): string;
	setEditorText(text: string): void;
	setEditorComponent(factory: ((tui: TUI) => EditorComponent) | undefined): void;
	addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider): () => void;
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	setTheme(value: "dark" | "light" | Theme): void;
	readonly theme: Theme;
}
export interface ExtensionContext {
	ui: UI;
	client: AcpClient;
	sessionId: () => string | undefined;
}
export interface ExtensionAPI extends ExtensionContext {
	registerCommand(name: string, description: string, handler: (args: string) => Promise<void> | void): void;
	registerShortcut(id: string, defaultKeys: KeyId | KeyId[], handler: () => void): void;
	registerCapability(name: string, value: Json): void;
	onRequest(method: string, handler: (params: Json, signal: AbortSignal) => Promise<Json>): void;
	onNotification(method: string, handler: (params: Json) => void): void;
	registerRenderer(kind: string, renderer: (entity: Entity) => Component): void;
	registerMarkdownTransformer(transformer: MarkdownTransformer): void;
	onDispose(cleanup: () => void | Promise<void>): void;
}
export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;
type Owned<T> = { owner: string; value: T };

/** Track ownership so reload disposes only the extension's registrations. */
export class ExtensionHost {
	revision = 0;
	readonly commands = new Map<string, Owned<{ description: string; run: (args: string) => void | Promise<void> }>>();
	readonly shortcuts = new Map<string, Owned<{ keys: KeyId | KeyId[]; run: () => void }>>();
	readonly renderers = new Map<string, Owned<(entity: Entity) => Component>>();
	readonly transformers: Owned<MarkdownTransformer>[] = [];
	private requests = new Map<string, Owned<(params: Json, signal: AbortSignal) => Promise<Json>>>();
	private notifications = new Map<string, Owned<(params: Json) => void>>();
	private cleanup = new Map<string, (() => void | Promise<void>)[]>();
	private capabilities = new Map<string, string>();
	private uiOwners = new Map<string, string>();
	private lifetimes = new Map<string, AbortController>();
	private readonly context: ExtensionContext;
	constructor(context: ExtensionContext) {
		this.context = context;
		context.client.onCustomRequest = async (method, params, signal) => {
			const handler = this.requests.get(method);
			if (!handler) throw new RpcError(-32601, "Method not found");
			return handler.value(params, signal);
		};
		context.client.onCustomNotification = (method, params) => {
			try {
				this.notifications.get(method)?.value(params);
			} catch (error) {
				context.ui.notify(message(error));
			}
		};
	}

	/** Load a trusted extension using a fresh jiti module cache. */
	async load(path: string): Promise<void> {
		const owner = resolve(path);
		await this.unload(owner);
		this.cleanup.set(owner, []);
		this.lifetimes.set(owner, new AbortController());
		const ui = this.ownedUI(owner);
		const api: ExtensionAPI = {
			...this.context,
			ui,
			registerCommand: (name, description, run) => {
				if (
					COMMANDS.includes(name) ||
					this.context.client.modules.some((module) => name in (module.commands ?? {}))
				)
					throw new Error(`Native command already exists: ${name}`);
				this.register(this.commands, name, owner, { description, run });
			},
			registerShortcut: (id, keys, run) => this.register(this.shortcuts, id, owner, { keys, run }),
			registerRenderer: (kind, renderer) => this.register(this.renderers, kind, owner, renderer),
			registerMarkdownTransformer: (transformer) => {
				this.transformers.push({ owner, value: transformer });
			},
			registerCapability: (name, value) => {
				const existing = this.capabilities.get(name);
				if (existing && existing !== owner) throw new Error(`Capability already registered: ${name}`);
				this.capabilities.set(name, owner);
				this.context.client.declare(name, value);
			},
			onRequest: (method, handler) => {
				this.customMethod(method);
				this.register(this.requests, method, owner, (params, signal) =>
					handler(params, AbortSignal.any([signal, this.lifetimes.get(owner)!.signal])),
				);
			},
			onNotification: (method, handler) => {
				this.customMethod(method);
				this.register(this.notifications, method, owner, handler);
			},
			onDispose: (cleanup) => {
				this.cleanup.get(owner)!.push(cleanup);
			},
		};
		try {
			const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
			const module = await jiti.import<{ default: ExtensionFactory }>(owner);
			if (typeof module.default !== "function") throw new Error("Extension must export a default factory");
			await module.default(api);
		} catch (error) {
			await this.unload(owner);
			ui.notify(`Extension ${owner}: ${message(error)}`);
		}
		this.revision++;
	}

	/** Remove an extension's UI and method registrations before loading its replacement. */
	async unload(owner: string): Promise<void> {
		this.revision++;
		this.lifetimes.get(owner)?.abort();
		this.lifetimes.delete(owner);
		const actions = this.cleanup.get(owner) ?? [];
		this.cleanup.delete(owner);
		for (const cleanup of actions.reverse()) {
			try {
				await cleanup();
			} catch (error) {
				this.context.ui.notify(`Extension cleanup: ${message(error)}`);
			}
		}
		this.remove(this.commands, owner);
		this.remove(this.shortcuts, owner);
		this.remove(this.renderers, owner);
		this.remove(this.requests, owner);
		this.remove(this.notifications, owner);
		for (let i = this.transformers.length - 1; i >= 0; i--)
			if (this.transformers[i].owner === owner) this.transformers.splice(i, 1);
		for (const [name, registered] of this.capabilities) {
			if (registered === owner) {
				this.context.client.declare(name, undefined);
				this.capabilities.delete(name);
			}
		}
	}

	/** Dispose all loaded frontend extensions. */
	async dispose(): Promise<void> {
		for (const owner of [...this.cleanup.keys()]) await this.unload(owner);
	}

	private register<T>(registry: Map<string, Owned<T>>, name: string, owner: string, value: T): void {
		const existing = registry.get(name);
		if (existing) throw new Error(`Registration already exists: ${name}`);
		registry.set(name, { owner, value });
	}
	private remove<T>(registry: Map<string, Owned<T>>, owner: string): void {
		for (const [key, entry] of registry) if (entry.owner === owner) registry.delete(key);
	}
	private customMethod(method: string): void {
		if (!method.startsWith("_")) throw new Error("Expected custom ACP method");
	}
	private ownedUI(owner: string): UI {
		const base = this.context.ui;
		const owned: UI = {
			select: base.select.bind(base),
			confirm: base.confirm.bind(base),
			input: base.input.bind(base),
			notify: base.notify.bind(base),
			setWidget: base.setWidget.bind(base),
			setStatus: base.setStatus.bind(base),
			setHeader: base.setHeader.bind(base),
			setFooter: base.setFooter.bind(base),
			setTitle: base.setTitle.bind(base),
			custom: base.custom.bind(base),
			getEditorText: base.getEditorText.bind(base),
			setEditorText: base.setEditorText.bind(base),
			setEditorComponent: base.setEditorComponent.bind(base),
			addAutocompleteProvider: base.addAutocompleteProvider.bind(base),
			onTerminalInput: base.onTerminalInput.bind(base),
			setTheme: base.setTheme.bind(base),
			get theme() {
				return base.theme;
			},
		};
		const remember = (cleanup: () => void) => this.cleanup.get(owner)!.push(cleanup);
		const lifetime = this.lifetimes.get(owner)!;
		const combined = (signal?: AbortSignal) =>
			signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
		owned.select = (title, options, signal) => base.select(title, options, combined(signal));
		owned.confirm = (title, text, signal) => base.confirm(title, text, combined(signal));
		owned.input = (title, text, signal) => base.input(title, text, combined(signal));
		owned.custom = (factory, options) => base.custom(factory, { ...options, signal: combined(options?.signal) });
		const registered = new Set<string>();
		const once = (key: string, cleanup: () => void) => {
			if (!registered.has(key)) {
				registered.add(key);
				remember(cleanup);
			}
		};
		owned.setWidget = (key, component, placement) => {
			const name = `${owner}:${key}`;
			base.setWidget(name, component, placement);
			once(`widget:${name}`, () => base.setWidget(name, undefined));
		};
		owned.setStatus = (key, text) => {
			const name = `${owner}:${key}`;
			base.setStatus(name, text);
			once(`status:${name}`, () => base.setStatus(name, undefined));
		};
		owned.setHeader = (component) => {
			this.uiOwners.set("header", owner);
			base.setHeader(component);
			once("header", () => {
				if (this.uiOwners.get("header") === owner) {
					this.uiOwners.delete("header");
					base.setHeader(undefined);
				}
			});
		};
		owned.setFooter = (component) => {
			this.uiOwners.set("footer", owner);
			base.setFooter(component);
			once("footer", () => {
				if (this.uiOwners.get("footer") === owner) {
					this.uiOwners.delete("footer");
					base.setFooter(undefined);
				}
			});
		};
		owned.setEditorComponent = (factory) => {
			this.uiOwners.set("editor", owner);
			base.setEditorComponent(factory);
			once("editor", () => {
				if (this.uiOwners.get("editor") === owner) {
					this.uiOwners.delete("editor");
					base.setEditorComponent(undefined);
				}
			});
		};
		owned.onTerminalInput = (handler) => {
			const stop = base.onTerminalInput(handler);
			remember(stop);
			return stop;
		};
		owned.addAutocompleteProvider = (factory) => {
			const stop = base.addAutocompleteProvider(factory);
			remember(stop);
			return stop;
		};
		return owned;
	}
}

/** Discover explicit files or one directory level of trusted local extension modules. */
export function discoverExtensions(directory: string): string[] {
	try {
		return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			if (entry.isFile() && /\.(ts|js|mjs)$/.test(entry.name)) return [resolve(directory, entry.name)];
			if (entry.isDirectory())
				return ["index.ts", "index.js", "index.mjs"]
					.map((name) => resolve(directory, entry.name, name))
					.filter((path) => existsSync(path))
					.slice(0, 1);
			return [];
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
