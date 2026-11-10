/** Optional queue-only delivery client with insertion-timed input presentation. */
import { optionalObject } from "../json.ts";
import type { ClientProtocolModule } from "../modules.ts";

export const deliveryRevision = "ee193af58f211a1cbfde30029d5283f9c94c554c";

/** Select FIFO delivery while leaving baseline prompt dispatch independent. */
export function promptDelivery(): ClientProtocolModule {
	return {
		id: "prompt-delivery",
		profile: { delivery: { revision: deliveryRevision, profile: 1 } },
		fields: { delivery: { const: "queue" } },
		prompt: async (id, text, client) => {
			if (client.version === 2) {
				if (!optionalObject(optionalObject(optionalObject(client.peerCapabilities.session).prompt).delivery).queue)
					throw new Error("Queued prompt delivery unavailable");
				await client.submitPrompt(id, text, { delivery: "queue" }, "remote");
			} else {
				const shared = client.modules.some((module) => module.id === "multi-client-attach");
				if (shared) client.requireProtocol(client.modules.find((module) => module.id === "multi-client-attach")!);
				await client.submitPrompt(id, text, {}, shared ? "remote" : "local");
			}
		},
	};
}
