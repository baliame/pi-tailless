/** Public contracts for optional client protocol additions, independent of UI extensions. */
import type { AcpClient } from "./client.ts";
import type { UI } from "./extensions.ts";
import type { ObjectValue } from "./json.ts";

export interface ProtocolMethod {
	request(version: 1 | 2): ObjectValue;
	response(version: 1 | 2): ObjectValue;
	apply?(params: ObjectValue, result: ObjectValue, client: AcpClient): void;
}

export interface ClientProtocolModule {
	id: string;
	requires?: string[];
	profile?: ObjectValue;
	methods?: Record<string, ProtocolMethod>;
	fields?: Record<string, ObjectValue>;
	updates?: Record<
		string,
		{
			schema(version: 1 | 2): ObjectValue;
			apply(sessionId: string, update: ObjectValue, client: AcpClient): void;
		}
	>;
	prompt?(sessionId: string, text: string, client: AcpClient): Promise<void>;
	echo?: "remote";
	observe?(sessionId: string, update: ObjectValue, client: AcpClient): void;
	disconnected?(): void;
	commands?: Record<string, (args: string, client: AcpClient, ui: UI) => Promise<void>>;
}
