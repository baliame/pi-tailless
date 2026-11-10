/** Pinned ACP schema validators; all use is at the incoming wire boundary. */
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { type Json, type ObjectValue, object } from "./json.ts";

/** Validate recognized payloads against the reviewed protocol revision. */
export class WireSchema {
	private ajv = new Ajv2020({ strict: false, validateFormats: false });
	private updates = new Map<string, ReturnType<Ajv2020["compile"]>>();
	private additions = new Map<string, ReturnType<Ajv2020["compile"]>>();
	private id: string;
	constructor(version: 1 | 2) {
		const schema = JSON.parse(readFileSync(new URL(`./schemas/v${version}.json`, import.meta.url), "utf8"));
		this.id = `urn:pi-acp:v${version}`;
		schema.$id = this.id;
		this.ajv.addSchema(schema);
		for (const variant of schema.$defs.SessionUpdate[version === 1 ? "oneOf" : "anyOf"]) {
			const tag = variant.properties?.sessionUpdate?.const;
			if (tag) this.updates.set(tag, this.ajv.compile({ ...variant, $defs: schema.$defs }));
		}
	}

	/** Validate a known payload type. */
	validate(name: string, value: Json): void {
		const validator = this.additions.get(name) ?? this.ajv.getSchema(`${this.id}#/$defs/${name}`);
		if (!validator || !validator(value))
			throw new Error(`Invalid ACP ${name}: ${this.ajv.errorsText(validator?.errors)}`);
	}

	/** Compile an explicitly installed overlay without changing the pinned schemas. */
	register(name: string, schema: ObjectValue): void {
		if (this.additions.has(name)) throw new Error(`Duplicate protocol schema: ${name}`);
		if (name.startsWith("update:") && this.updates.has(name.slice(7)))
			throw new Error(`Cannot replace baseline update: ${name}`);
		this.additions.set(name, this.ajv.compile(schema));
	}

	/** Select the recognized variant before validation so malformed known tags cannot use a fallback. */
	update(value: Json): void {
		const update = object(value, "session update");
		const tag = update.sessionUpdate;
		if (typeof tag !== "string") throw new Error("Missing sessionUpdate");
		const validator = this.updates.get(tag);
		if (validator && !validator(value))
			throw new Error(`Invalid ACP update ${tag}: ${this.ajv.errorsText(validator.errors)}`);
	}
}
