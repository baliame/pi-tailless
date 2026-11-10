/** Product-local configuration; remote directories are never resolved against local paths. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { KeybindingsConfig, KeyId } from "@earendil-works/pi-tui";
import { array, object, string } from "./json.ts";
import type { Launch } from "./rpc.ts";

export interface Config {
	launch: Launch;
	peerCwd: string;
	extensions: string[];
	keybindings: KeybindingsConfig;
	theme: "dark" | "light";
	experimental?: string[];
}

/** Read the user's explicit launcher and trusted local extension paths. */
export function readConfig(path: string): Config {
	const input = object(JSON.parse(readFileSync(path, "utf8")), "configuration");
	const endpoint = object(input.endpoint);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(object(endpoint.env ?? {})))
		env[key] = string(value, `environment ${key}`);
	const keys: KeybindingsConfig = {};
	for (const [key, value] of Object.entries(object(input.keybindings ?? {}))) {
		keys[key] = (Array.isArray(value) ? value.map((item) => string(item)) : string(value)) as KeyId | KeyId[];
	}
	const theme = input.theme ?? "dark";
	if (theme !== "dark" && theme !== "light") throw new Error("Theme must be dark or light");
	return {
		launch: {
			command: string(endpoint.command),
			args: array(endpoint.args).map((item) => string(item)),
			env,
			cwd: endpoint.cwd ? resolve(dirname(path), string(endpoint.cwd)) : undefined,
		},
		peerCwd: string(input.peerCwd, "absolute peerCwd"),
		extensions: array(input.extensions).map((item) => resolve(dirname(path), string(item))),
		keybindings: keys,
		theme,
		experimental: array(input.experimental).map((value) => string(value)),
	};
}
