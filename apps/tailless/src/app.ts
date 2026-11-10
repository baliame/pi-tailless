/** Frontend command orchestration; all agent operations go through ACP. */
import { resolve } from "node:path";
import { AcpClient } from "./client.ts";
import { COMMANDS } from "./commands.ts";
import type { Config } from "./config.ts";
import { discoverExtensions } from "./extensions.ts";
import { array, message, object, RpcError, string } from "./json.ts";
import type { ClientProtocolModule } from "./modules.ts";
import { FrontendUI } from "./ui.ts";

/** Run an independently configured ACP terminal frontend. */
export class FrontendApp {
	readonly client = new AcpClient();
	readonly ui: FrontendUI;
	private readonly config: Config;
	private paths: string[];
	constructor(config: Config, modules: ClientProtocolModule[] = []) {
		this.config = config;
		for (const module of modules) {
			for (const name of Object.keys(module.commands ?? {}))
				if (COMMANDS.includes(name)) throw new Error(`Native command already exists: ${name}`);
			this.client.use(module);
		}
		for (const name of config.experimental ?? [])
			if (!this.client.modules.some((module) => module.id === name))
				throw new Error(`Missing experimental composition: ${name}`);
		this.ui = new FrontendUI(this.client, { keybindings: config.keybindings });
		this.paths = [...new Set([...config.extensions, ...discoverExtensions(resolve(".pi-acp/extensions"))])];
		this.ui.onSubmit = (text) => {
			void this.submit(text).catch((error) => {
				if (!this.ui.getEditorText() && !(error instanceof RpcError && error.code === -32800))
					this.ui.setEditorText(text);
				this.ui.notify(message(error));
			});
		};
		this.ui.onExit = () => {
			void this.stop();
		};
	}

	/** Load local capabilities before initiating the peer handshake. */
	async start(resume?: string, attach?: string): Promise<void> {
		if (resume && attach) throw new Error("Choose --resume or --attach");
		this.ui.setTheme(this.config.theme);
		for (const path of this.paths) await this.ui.extensions.load(path);
		this.ui.start();
		try {
			await this.connect(resume, attach);
		} catch (error) {
			this.ui.notify(message(error));
		}
	}

	/** Dispose local extensions and restore the terminal without claiming remote cancellation. */
	async stop(): Promise<void> {
		this.client.disconnect();
		await this.ui.extensions.dispose();
		this.ui.stop();
	}

	private async connect(resume?: string, attach?: string): Promise<void> {
		await this.client.connect(this.config.launch);
		const methods = this.client.getAuthMethods();
		if (methods.length)
			this.ui.notify(
				`Authentication available: ${methods.map((value) => String(this.client.version === 2 ? object(value).methodId : object(value).id)).join(", ")}. Use /login <id> if required.`,
			);
		if (attach) {
			const command = this.client.modules.find((module) => module.commands?.attach)?.commands?.attach;
			if (!command) throw new Error("Experimental attach is not enabled");
			await command(attach, this.client, this.ui);
		} else if (resume) await this.client.resume(resume, this.config.peerCwd);
		else await this.client.newSession(this.config.peerCwd);
	}
	private async submit(text: string): Promise<void> {
		if (!text.trim()) return;
		if (!text.startsWith("/")) {
			const id = this.client.model.visible;
			if (!id) throw new Error("No active session. Use /connect or /new.");
			await this.client.prompt(id, text);
			return;
		}
		const [command, ...parts] = text.slice(1).split(" ");
		const args = parts.join(" ").trim();
		const session = this.client.model.visible;
		switch (command) {
			case "help":
				this.ui.notify(
					[...COMMANDS, ...this.client.modules.flatMap((module) => Object.keys(module.commands ?? {}))]
						.map((name) => `/${name}`)
						.join(" "),
				);
				break;
			case "connect":
				await this.connect();
				break;
			case "disconnect":
				this.client.disconnect();
				break;
			case "new":
				await this.client.newSession(this.config.peerCwd);
				break;
			case "sessions": {
				const sessions = await this.client.listSessions();
				const options = sessions.map((value) => object(value));
				const selected = await this.ui.select(
					"Sessions",
					options.map((entry) => string(entry.sessionId)),
				);
				if (selected) {
					const entry = options.find((entry) => entry.sessionId === selected)!;
					await this.client.resume(selected, string(entry.cwd));
				}
				break;
			}
			case "resume":
				await this.client.resume(args, this.config.peerCwd);
				break;
			case "switch": {
				if (!this.client.model.sessions.get(args)?.active) throw new Error("Session is not active. Use /resume.");
				this.client.model.visible = args;
				this.client.model.changed();
				break;
			}
			case "close":
				if (session) await this.client.closeSession(session);
				break;
			case "login":
				await this.client.login(args);
				await this.client.newSession(this.config.peerCwd);
				break;
			case "logout":
				await this.client.logout();
				break;
			case "config": {
				if (!session) throw new Error("No session");
				if (!args) {
					const options = this.client.model.get(session).config.map((value) => object(value));
					const key = this.client.version === 2 ? "configId" : "id";
					const id = await this.ui.select(
						"Session configuration",
						options.map((option) => string(option[key])),
					);
					if (!id) break;
					const option = options.find((value) => value[key] === id)!;
					const values =
						option.type === "boolean"
							? ["true", "false"]
							: array(option.options).flatMap((value) => {
									const item = object(value);
									return item.options
										? array(item.options).map((value) => string(object(value).value))
										: [string(item.value)];
								});
					const value = await this.ui.select(String(option.name ?? id), values);
					if (value !== undefined)
						await this.client.configure(session, id, option.type === "boolean" ? value === "true" : value);
					break;
				}
				const [id, ...rest] = args.split(" ");
				const value = rest.join(" ");
				await this.client.configure(session, id, value === "true" ? true : value === "false" ? false : value);
				break;
			}
			case "theme":
				if (args !== "dark" && args !== "light") throw new Error("Use /theme dark or /theme light");
				this.ui.setTheme(args);
				break;
			case "reload":
				for (const path of this.paths) await this.ui.extensions.load(path);
				this.ui.refresh();
				break;
			case "tasks": {
				const capability = this.client.capability("com.example/tasks");
				if (
					!capability ||
					typeof capability !== "object" ||
					Array.isArray(capability) ||
					capability.version !== 1
				) {
					this.ui.notify("Task API unavailable");
					break;
				}
				this.ui.notify(
					JSON.stringify(await this.client.request("_com.example/tasks/list", { sessionId: session ?? "" })),
				);
				break;
			}
			case "quit":
				await this.stop();
				break;
			default: {
				const protocol = this.client.modules.find((module) => module.commands?.[command])?.commands?.[command];
				if (protocol) {
					await protocol(args, this.client, this.ui);
					break;
				}
				const local = this.ui.extensions.commands.get(command);
				if (local) await local.value.run(args);
				else {
					const known =
						session && this.client.model.get(session).commands.some((value) => object(value).name === command);
					if (known && session) await this.client.prompt(session, text);
					else throw new Error(`Unknown command /${command}`);
				}
			}
		}
	}
}
