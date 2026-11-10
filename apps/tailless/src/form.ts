/** Render the protocol's primitive form fields and validate the submitted object. */
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import type { UI } from "./extensions.ts";
import { array, type Json, message, type ObjectValue, object, RpcError } from "./json.ts";

/** Elicit values using only locally rendered controls; cancellation never accepts a form. */
export async function elicitForm(ui: UI, params: ObjectValue, signal: AbortSignal): Promise<Json> {
	const schema = object(params.requestedSchema);
	const properties = object(schema.properties);
	const validationProperties: ObjectValue = {};
	for (const [name, definition] of Object.entries(properties)) {
		const property = object(definition);
		if (!["string", "number", "integer", "boolean", "array"].includes(String(property.type)))
			throw new RpcError(-32602, `Unsupported form field: ${name}`);
		validationProperties[name] = Object.fromEntries(Object.entries(property).filter(([, value]) => value !== null));
	}
	const validator = new Ajv2020({ strict: false, formats: fullFormats });
	const validate = validator.compile({ ...schema, properties: validationProperties });
	const required = new Set(array(schema.required));
	while (!signal.aborted) {
		const values: ObjectValue = {};
		for (const [name, definition] of Object.entries(properties)) {
			const property = object(definition);
			const label = `${String(params.message)} · ${String(property.title ?? name)}`;
			const choices = array(property.enum).map(String);
			const alternatives = array(property.oneOf).map((value) => object(value));
			const choiceValues = alternatives.length ? alternatives.map((value) => String(value.const)) : choices;
			let input: string | undefined;
			if (choiceValues.length) input = await ui.select(label, choiceValues, signal);
			else if (property.type === "boolean") input = await ui.select(label, ["true", "false"], signal);
			else
				input = await ui.input(
					`${label}${property.type === "array" ? " (JSON array)" : ""}`,
					property.default === undefined
						? ""
						: property.type === "string"
							? String(property.default)
							: JSON.stringify(property.default),
					signal,
				);
			if (input === undefined) return { action: "cancel" };
			if (!input.length && !required.has(name)) continue;
			try {
				values[name] =
					property.type === "boolean"
						? input === "true"
						: property.type === "number" || property.type === "integer"
							? Number(input)
							: property.type === "array"
								? JSON.parse(input)
								: input;
			} catch (error) {
				ui.notify(message(error));
				values[name] = null;
			}
		}
		if (!validate(values)) {
			ui.notify(`Form input: ${validator.errorsText(validate.errors)}`);
			continue;
		}
		if (signal.aborted) break;
		if (await ui.confirm("Submit form", JSON.stringify(values), signal)) return { action: "accept", content: values };
		return { action: signal.aborted ? "cancel" : "decline" };
	}
	return { action: "cancel" };
}
