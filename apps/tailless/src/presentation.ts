/** Presentation-only types consumed by source-derived pi renderers. */
export interface PresentationMessage {
	content: ({ type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall" })[];
	stopReason?: "length" | "aborted" | "error";
	errorMessage?: string;
}
export interface MarkdownTransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
	messageId?: string;
	timestamp?: string;
}
export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;
