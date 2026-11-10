/** Consume a documented task capability using a pi-derived local frontend extension. */
import type { ExtensionAPI } from "@pi-acp/frontend";

export default function tasks(api: ExtensionAPI): void {
	api.registerCommand("task-widget", "Show tasks from the peer's advertised API", async () => {
		const capability = api.client.capability("com.example/tasks");
		if (!capability || typeof capability !== "object" || Array.isArray(capability) || capability.version !== 1) {
			api.ui.setWidget("tasks", ["Task API unavailable or incompatible"]);
			return;
		}
		const result = await api.client.request("_com.example/tasks/list", { sessionId: api.sessionId() ?? "" });
		api.ui.setWidget("tasks", ["Tasks", JSON.stringify(result)]);
	});
	api.registerCapability("com.example/ui", { version: 1 });
	api.onRequest("_com.example/ui/ping", async (params) => ({ echoed: params }));
}
