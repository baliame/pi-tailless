/** JSON types and validation at configuration and ACP boundaries. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };

/** Read an object at a wire or configuration boundary. */
export function object(value: unknown, label = "object"): ObjectValue {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected ${label}`);
	return value as ObjectValue;
}

/** Read a required wire string. */
export function string(value: unknown, label = "string"): string {
	if (typeof value !== "string") throw new Error(`Expected ${label}`);
	return value;
}

/** Read an optional object at a wire boundary. */
export function optionalObject(value: Json | undefined): ObjectValue {
	return value === undefined || value === null ? {} : object(value);
}

/** Read a wire array, treating an omitted optional array as empty. */
export function array(value: Json | undefined): Json[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error("Expected array");
	return value;
}

/** Preserve the diagnostic message without exposing a thrown object's structure. */
export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A peer-visible JSON-RPC error. */
export class RpcError extends Error {
	readonly code: number;
	readonly data?: Json;
	constructor(code: number, text: string, data?: Json) {
		super(text);
		this.code = code;
		this.data = data;
	}
}
