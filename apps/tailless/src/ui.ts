/** Pi-derived terminal composition and local interaction facilities for ACP consumers. */
import {
	type AutocompleteProvider,
	type Component,
	Container,
	Editor,
	type EditorComponent,
	Image,
	Input,
	type Keybinding,
	type KeybindingsConfig,
	KeybindingsManager,
	type KeyId,
	Markdown,
	type OverlayOptions,
	ProcessTerminal,
	SelectList,
	setKeybindings,
	type Terminal,
	Text,
	type TUI,
	TUI_KEYBINDINGS,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { AcpClient } from "./client.ts";
import { COMMANDS } from "./commands.ts";
import { ExtensionHost, type UI } from "./extensions.ts";
import { elicitForm } from "./form.ts";
import { array, type Json, object, optionalObject, string } from "./json.ts";
import { contentText, type Entity } from "./model.ts";
import { getEditorTheme, getMarkdownTheme, loadTheme, setTheme, type Theme, theme } from "./theme.ts";
import { AssistantMessageComponent } from "./ui/assistant-message.ts";
import { UserMessageComponent } from "./ui/user-message.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"app.interrupt": true;
		"app.exit": true;
		"app.clear": true;
		"app.tools.expand": true;
		"app.thinking.toggle": true;
	}
}
const APP_KEYBINDINGS = {
	"app.interrupt": { defaultKeys: "escape" as KeyId, description: "Interrupt remote foreground work" },
	"app.exit": { defaultKeys: "ctrl+d" as KeyId, description: "Exit with an empty editor" },
	"app.clear": { defaultKeys: "ctrl+c" as KeyId, description: "Clear editor" },
	"app.tools.expand": { defaultKeys: "ctrl+o" as KeyId, description: "Expand tool output" },
	"app.thinking.toggle": { defaultKeys: "ctrl+t" as KeyId, description: "Toggle reasoning" },
};

/** Compose the real pi editor/renderer with version-independent ACP state. */
export class FrontendUI implements UI {
	readonly client: AcpClient;
	readonly tui: TUI;
	readonly extensions: ExtensionHost;
	onSubmit: (text: string) => void = () => {};
	onExit: () => void = () => {};
	private editor: EditorComponent;
	private transcript = new Container();
	private above = new Container();
	private below = new Container();
	private header = new Container();
	private footer = new Container();
	private editorSlot = new Container();
	private widgets = new Map<string, { component: Component; placement: string }>();
	private statuses = new Map<string, string>();
	private headerComponent?: Component;
	private footerComponent?: Component;
	private keybindings: KeybindingsManager;
	private userKeys: KeybindingsConfig;
	private toolsExpanded = true;
	private hideThinking = false;
	private dialogs = Promise.resolve();
	private lifetime = new AbortController();
	private keyRevision = -1;
	private stopped = false;
	private notices: string[] = [];
	private autocompleteFactories: ((current: AutocompleteProvider) => AutocompleteProvider)[] = [];
	private terminal: Terminal;
	private currentAutocomplete: AutocompleteProvider = {
		triggerCharacters: ["/"],
		getSuggestions: async (lines, line, col) => {
			const prefix = lines[line].slice(0, col);
			if (!/^\/[\w-]*$/.test(prefix)) return null;
			const session = this.client.model.visible ? this.client.model.get(this.client.model.visible) : undefined;
			const names = [
				...COMMANDS,
				...this.client.modules.flatMap((module) => Object.keys(module.commands ?? {})),
				...this.extensions.commands.keys(),
				...(session?.commands ?? []).map((value) => string(object(value).name)),
			];
			const items = [...new Set(names)]
				.filter((name) => `/${name}`.startsWith(prefix))
				.map((name) => ({ value: `/${name}`, label: `/${name}` }));
			return items.length ? { items, prefix } : null;
		},
		applyCompletion: (lines, line, col, item, prefix) => {
			const value = `${lines[line].slice(0, col - prefix.length)}${item.value} ${lines[line].slice(col)}`;
			return {
				lines: lines.map((text, index) => (index === line ? value : text)),
				cursorLine: line,
				cursorCol: col - prefix.length + item.value.length + 1,
			};
		},
	};

	constructor(client: AcpClient, options: { terminal?: Terminal; keybindings?: KeybindingsConfig } = {}) {
		this.client = client;
		this.terminal = options.terminal ?? new ProcessTerminal();
		this.userKeys = options.keybindings ?? {};
		this.keybindings = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS }, this.userKeys);
		setKeybindings(this.keybindings);
		this.tui = new TuiMainScreen(this.terminal);
		this.editor = this.makeEditor();
		this.editorSlot.addChild(this.editor);
		this.tui.addChild(this.header);
		this.tui.addChild(this.transcript);
		this.tui.addChild(this.above);
		this.tui.addChild(this.editorSlot);
		this.tui.addChild(this.below);
		this.tui.addChild(this.footer);
		this.extensions = new ExtensionHost({ ui: this, client, sessionId: () => client.model.visible });
		this.applyAutocomplete();
		client.model.onChange = () => this.refresh();
		client.onStatus = () => this.refresh();
		client.onDiagnostic = (text) => this.notify(text);
		client.interaction = {
			permission: async (params, signal): Promise<Json> => {
				const options = array(params.options).map((value) => object(value));
				const subject = optionalObject(params.toolCall ?? params.subject);
				const title = `${String(params.sessionId)} · ${String(params.title ?? subject.title ?? "Permission requested")}`;
				const selected = await this.choose(
					title,
					options.map((option) => ({ value: string(option.optionId), label: string(option.name) })),
					signal,
					String(params.description ?? ""),
				);
				return {
					outcome: selected === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: selected },
				};
			},
			form: (params, signal) => elicitForm(this, params, signal),
		};
		this.tui.addInputListener((data) => {
			if (this.tui.hasOverlay()) return undefined;
			this.syncKeys();
			for (const [id, registration] of this.extensions.shortcuts) {
				if (this.keybindings.matches(data, id as Keybinding)) {
					registration.value.run();
					return { consume: true };
				}
			}
			if (this.keybindings.matches(data, "app.interrupt")) {
				if (this.client.model.visible && this.client.connected) this.client.cancel(this.client.model.visible);
				return { consume: true };
			}
			if (this.keybindings.matches(data, "app.exit") && !this.editor.getText()) {
				this.onExit();
				return { consume: true };
			}
			if (this.keybindings.matches(data, "app.clear")) {
				this.editor.setText("");
				return { consume: true };
			}
			if (this.keybindings.matches(data, "app.tools.expand")) {
				this.toolsExpanded = !this.toolsExpanded;
				this.refresh();
				return { consume: true };
			}
			if (this.keybindings.matches(data, "app.thinking.toggle")) {
				this.hideThinking = !this.hideThinking;
				this.refresh();
				return { consume: true };
			}
			return undefined;
		});
	}

	get theme(): Theme {
		return theme;
	}
	/** Start terminal modes only after local extensions have loaded. */
	start(): void {
		this.refresh();
		this.tui.setFocus(this.editor);
		this.tui.start();
	}
	/** Restore the terminal and leave remote cancellation policy to the peer. */
	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.lifetime.abort();
		for (const { component } of this.widgets.values()) this.disposeComponent(component);
		this.widgets.clear();
		this.disposeComponent(this.headerComponent);
		this.disposeComponent(this.footerComponent);
		this.disposeComponent(this.editor);
		this.tui.stop();
	}
	/** Preserve the draft through connection state changes. */
	getEditorText(): string {
		return this.editor.getText();
	}
	setEditorText(text: string): void {
		this.editor.setText(text);
		this.tui.requestRender();
	}
	setTitle(text: string): void {
		this.terminal.setTitle(text);
	}
	notify(text: string): void {
		this.notices.push(text.trim());
		this.notices = this.notices.slice(-4);
		this.refresh();
	}
	setStatus(key: string, text: string | undefined): void {
		if (text === undefined) this.statuses.delete(key);
		else this.statuses.set(key, text);
		this.refresh();
	}
	setHeader(component: Component | undefined): void {
		this.disposeComponent(this.headerComponent);
		this.headerComponent = component;
		this.refresh();
	}
	setFooter(component: Component | undefined): void {
		this.disposeComponent(this.footerComponent);
		this.footerComponent = component;
		this.refresh();
	}
	setWidget(key: string, component: Component | string[] | undefined, placement = "aboveEditor"): void {
		const previous = this.widgets.get(key)?.component as (Component & { dispose?: () => void }) | undefined;
		previous?.dispose?.();
		if (component === undefined) this.widgets.delete(key);
		else
			this.widgets.set(key, {
				component: Array.isArray(component) ? new Text(component.join("\n"), 1, 0) : component,
				placement,
			});
		this.refresh();
	}
	setTheme(value: "dark" | "light" | Theme): void {
		setTheme(typeof value === "string" ? loadTheme(value) : value);
		this.tui.invalidate();
		this.refresh();
	}
	setEditorComponent(factory: ((tui: TUI) => EditorComponent) | undefined): void {
		const text = this.editor.getText();
		(this.editor as EditorComponent & { dispose?: () => void }).dispose?.();
		this.editor = factory ? factory(this.tui) : this.makeEditor();
		this.editor.setText(text);
		this.bindEditor();
		this.editorSlot.clear();
		this.editorSlot.addChild(this.editor);
		this.tui.setFocus(this.editor);
		this.refresh();
	}
	addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider): () => void {
		this.autocompleteFactories.push(factory);
		this.applyAutocomplete();
		return () => {
			this.autocompleteFactories = this.autocompleteFactories.filter((value) => value !== factory);
			this.applyAutocomplete();
		};
	}
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void {
		return this.tui.addInputListener(handler);
	}
	custom<T>(
		factory: (tui: TUI, done: (value: T) => void) => Component,
		options?: OverlayOptions & { signal?: AbortSignal },
	): Promise<T | undefined> {
		return this.modal<T | undefined>((done) => factory(this.tui, done), options, options?.signal);
	}
	select(title: string, options: string[], signal?: AbortSignal): Promise<string | undefined> {
		return this.choose(
			title,
			options.map((value) => ({ value, label: value })),
			signal,
		);
	}
	async confirm(title: string, text: string, signal?: AbortSignal): Promise<boolean> {
		return (
			(await this.choose(
				title,
				[
					{ value: "yes", label: "Confirm" },
					{ value: "no", label: "Cancel" },
				],
				signal,
				text,
			)) === "yes"
		);
	}
	input(title: string, prefill = "", signal?: AbortSignal): Promise<string | undefined> {
		return this.modal<string | undefined>(
			(done) => {
				const input = new Input();
				input.setValue(prefill);
				input.onSubmit = done;
				input.onEscape = () => done(undefined);
				return this.dialog(title, input);
			},
			undefined,
			signal,
			undefined,
		);
	}

	/** Refresh presentation without changing editor content or connection semantics. */
	refresh(): void {
		this.header.clear();
		this.transcript.clear();
		this.above.clear();
		this.below.clear();
		this.footer.clear();
		const session = this.client.model.visible ? this.client.model.get(this.client.model.visible) : undefined;
		this.header.addChild(
			this.headerComponent ??
				new Text(
					`${theme.bold("π ACP")} ${theme.fg("muted", this.client.connected ? `v${this.client.version} · ${session?.id ?? "no session"}` : "disconnected")}`,
					1,
					1,
				),
		);
		if (session) for (const entity of session.entities) this.transcript.addChild(this.renderEntity(entity));
		for (const notice of this.notices) this.transcript.addChild(new Text(theme.fg("warning", notice), 1, 0));
		for (const { component, placement } of this.widgets.values())
			(placement === "belowEditor" ? this.below : this.above).addChild(component);
		this.footer.addChild(
			this.footerComponent ??
				new Text(
					theme.fg(
						"muted",
						[
							session?.cwd ?? "",
							session?.state ?? "no session",
							this.client.modules.length ? "experimental" : "",
							...this.statuses.values(),
							session?.usage ? `usage ${JSON.stringify(session.usage)}` : "",
							this.client.reconnectRequired ? "capabilities changed: /connect" : "",
							"/help · Esc interrupt · Ctrl+D exit",
						]
							.filter(Boolean)
							.join(" · "),
					),
					1,
					0,
				),
		);
		this.tui.requestRender();
	}

	private renderEntity(entity: Entity): Component {
		const renderer = this.extensions.renderers.get(entity.kind)?.value;
		if (renderer) return renderer(entity);
		const data = entity.data;
		if (["user_message", "agent_message", "agent_thought"].includes(entity.kind)) {
			const content = array(data.content);
			const text = content.map(contentText).join("");
			if (entity.kind === "user_message") return new UserMessageComponent(text);
			const block = new Container();
			block.addChild(
				new AssistantMessageComponent(
					{
						content:
							entity.kind === "agent_thought"
								? [{ type: "thinking", thinking: text }]
								: [{ type: "text", text }],
					},
					this.hideThinking,
					getMarkdownTheme(),
					"Thinking…",
					1,
					this.extensions.transformers.map((entry) => entry.value),
				),
			);
			for (const value of content) {
				const item = object(value);
				if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string")
					block.addChild(
						new Image(item.data, item.mimeType, { fallbackColor: (value) => theme.fg("muted", value) }),
					);
			}
			return block;
		}
		if (entity.kind === "tool") {
			const title = `${String(data.status ?? "pending")} · ${String(data.title ?? data.name ?? "Tool")}`;
			const body = this.toolsExpanded ? array(data.content).map(contentText).join("\n") : "";
			return new Text(`${theme.fg("toolTitle", title)}${body ? `\n${body}` : ""}`, 1, 1);
		}
		if (entity.kind === "terminal")
			return new Text(`[Terminal ${entity.id}]\n${String(data.displayOutput ?? "")}`, 1, 0);
		if (entity.kind === "notice") return new Text(`${String(data.title)}\n${String(data.description ?? "")}`, 1, 1);
		if (entity.kind === "plan")
			return new Text(
				array(data.entries)
					.map((entry) => {
						const item = object(entry);
						return `${String(item.status)} · ${String(item.content)}`;
					})
					.join("\n"),
				1,
				1,
			);
		return new Markdown(
			data.summary ? array(data.summary).map(contentText).join("") : String(data.title ?? ""),
			1,
			0,
			getMarkdownTheme(),
		);
	}
	private makeEditor(): EditorComponent {
		const editor = new Editor(this.tui, getEditorTheme());
		editor.onSubmit = (text) => this.onSubmit(text);
		return editor;
	}
	private bindEditor(): void {
		this.editor.onSubmit = (text) => this.onSubmit(text);
		this.applyAutocomplete();
	}
	private applyAutocomplete(): void {
		let provider = this.currentAutocomplete;
		for (const factory of this.autocompleteFactories) provider = factory(provider);
		this.editor.setAutocompleteProvider?.(provider);
	}
	private syncKeys(): void {
		if (this.keyRevision === this.extensions.revision) return;
		this.keyRevision = this.extensions.revision;
		const definitions = { ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS };
		for (const [id, registration] of this.extensions.shortcuts)
			Object.assign(definitions, { [id]: { defaultKeys: registration.value.keys } });
		this.keybindings = new KeybindingsManager(definitions, this.userKeys);
		setKeybindings(this.keybindings);
	}
	private choose(
		title: string,
		options: { value: string; label: string }[],
		signal?: AbortSignal,
		description = "",
	): Promise<string | undefined> {
		return this.modal<string | undefined>(
			(done) => {
				const list = new SelectList(options, 8, getEditorTheme().selectList);
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);
				return this.dialog([title, description].filter(Boolean).join("\n"), list);
			},
			undefined,
			signal,
			undefined,
		);
	}
	private dialog(title: string, control: Component & { handleInput?: (data: string) => void }): Component {
		const box = new Container();
		box.addChild(new Text(theme.bold(title), 1, 1));
		box.addChild(control);
		return {
			render: (width) => box.render(width),
			invalidate: () => box.invalidate(),
			handleInput: (data) => {
				control.handleInput?.(data);
				this.tui.requestRender();
			},
		};
	}
	private disposeComponent(component: Component | undefined): void {
		(component as (Component & { dispose?: () => void }) | undefined)?.dispose?.();
	}
	private modal<T>(
		factory: (done: (value: T) => void) => Component,
		options?: OverlayOptions,
		signal?: AbortSignal,
		cancelled?: T,
	): Promise<T> {
		signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
		const result = this.dialogs.then(
			() =>
				new Promise<T>((resolve) => {
					if (signal?.aborted) {
						resolve(cancelled as T);
						return;
					}
					let handle: ReturnType<TUI["showOverlay"]> | undefined;
					let component: Component | undefined;
					let finished = false;
					const abort = () => done(cancelled as T);
					const done = (value: T) => {
						if (finished) return;
						finished = true;
						signal?.removeEventListener("abort", abort);
						handle?.hide();
						this.disposeComponent(component);
						resolve(value);
						this.tui.requestRender();
					};
					component = factory(done);
					if (finished) {
						this.disposeComponent(component);
						return;
					}
					if (signal?.aborted) {
						done(cancelled as T);
						return;
					}
					handle = this.tui.showOverlay(component, options ?? { width: "80%", anchor: "center" });
					signal?.addEventListener("abort", abort, { once: true });
				}),
		);
		this.dialogs = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}
