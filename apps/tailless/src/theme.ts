/** Pi palette files adapted to an independent frontend theme host. */
import { readFileSync } from "node:fs";
import {
	type Color,
	type EditorTheme,
	getTerminalColorMode,
	type MarkdownTheme,
	parseColor,
	styleText,
} from "@earendil-works/pi-tui";
import { object, string } from "./json.ts";

/** Resolve a trusted theme through pi's color parser after validating its file boundary. */
export class Theme {
	readonly name: string;
	private palette = new Map<string, Color>();
	constructor(value: unknown) {
		const input = object(value, "theme");
		this.name = string(input.name);
		const colors = object(input.colors);
		const variables = object(input.vars ?? {});
		for (const [name, initial] of Object.entries(colors)) {
			let color = initial;
			const seen = new Set<string>();
			while (typeof color === "string" && variables[color] !== undefined) {
				if (seen.has(color)) throw new Error(`Theme variable cycle: ${color}`);
				seen.add(color);
				color = variables[color];
			}
			if (typeof color !== "string" && typeof color !== "number") throw new Error(`Invalid theme color: ${name}`);
			if (color !== "") this.palette.set(name, parseColor(color));
		}
	}
	/** Color foreground text with a pi theme token. */
	fg(token: string, text: string): string {
		return styleText(text, { fg: this.palette.get(token) }, getTerminalColorMode());
	}
	/** Color a background with a pi theme token. */
	bg(token: string, text: string): string {
		return styleText(text, { bg: this.palette.get(token) }, getTerminalColorMode());
	}
	bold(text: string): string {
		return styleText(text, { bold: true }, getTerminalColorMode());
	}
	italic(text: string): string {
		return styleText(text, { italic: true }, getTerminalColorMode());
	}
	underline(text: string): string {
		return styleText(text, { underline: true }, getTerminalColorMode());
	}
}

/** Load a built-in pi palette. */
export function loadTheme(name: "dark" | "light"): Theme {
	return new Theme(JSON.parse(readFileSync(new URL(`./themes/${name}.json`, import.meta.url), "utf8")));
}
export let theme = loadTheme("dark");

/** Select the active palette; the host invalidates its components afterward. */
export function setTheme(value: Theme): void {
	theme = value;
}

/** Pi Markdown tokens without any provider or harness dependency. */
export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => styleText(text, { strikethrough: true }, getTerminalColorMode()),
		underline: (text) => theme.underline(text),
	};
}

/** Pi editor colors and selection presentation. */
export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text) => theme.fg("border", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.bold(text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}
