#!/usr/bin/env node
/** Launch the standalone frontend with product-local settings. */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { FrontendApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { multiClientAttach } from "./experimental/multi-client-attach.ts";
import { promptDelivery } from "./experimental/prompt-delivery.ts";
import { message } from "./json.ts";
import type { ClientProtocolModule } from "./modules.ts";

const { values } = parseArgs({
	options: {
		config: { type: "string", short: "c" },
		resume: { type: "string" },
		attach: { type: "string" },
		help: { type: "boolean", short: "h" },
	},
});
if (values.help) {
	console.log(
		"pi-tailless --config <file> [--resume <session-id> | --attach <session-id>]\nDefault config: .pi-acp/config.json\n--attach requires the configured multi-client-attach experiment.\nThe configured command supplies an ACP agent or external connector over stdio.",
	);
} else {
	try {
		if (values.resume && values.attach) throw new Error("Choose --resume or --attach");
		const config = readConfig(resolve(values.config ?? ".pi-acp/config.json"));
		const modules: ClientProtocolModule[] = (config.experimental ?? []).map((name) => {
			if (name === "multi-client-attach") return multiClientAttach();
			if (name === "prompt-delivery") return promptDelivery();
			throw new Error(`Unknown experiment: ${name}`);
		});
		const app = new FrontendApp(config, modules);
		process.once("SIGINT", () => {
			void app.stop();
		});
		process.once("SIGTERM", () => {
			void app.stop();
		});
		await app.start(values.resume, values.attach);
	} catch (error) {
		console.error(message(error));
		process.exitCode = 1;
	}
}
