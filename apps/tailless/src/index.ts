/** Public frontend host API for native code and trusted local extensions. */
export { FrontendApp } from "./app.ts";
export { AcpClient } from "./client.ts";
export { type Config, readConfig } from "./config.ts";
export {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionHost,
	type UI,
} from "./extensions.ts";
export { type Json, type ObjectValue, RpcError } from "./json.ts";
export { type Entity, type Session, SessionModel } from "./model.ts";
export type { ClientProtocolModule, ProtocolMethod } from "./modules.ts";
export type { MarkdownTransformer } from "./presentation.ts";
export { type Launch, RpcConnection } from "./rpc.ts";
export { loadTheme, Theme } from "./theme.ts";
export { FrontendUI } from "./ui.ts";
