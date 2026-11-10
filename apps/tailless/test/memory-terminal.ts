/** Controlled terminal for deterministic UI input, resize and screen-output tests. */
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";

export class MemoryTerminal implements Terminal {
	columns = 100;
	rows = 30;
	kittyProtocolActive = false;
	output = "";
	private onInput: (data: string) => void = () => {};
	private onResize: () => void = () => {};
	start(input: (data: string) => void, resize: () => void): void {
		this.onInput = input;
		this.onResize = resize;
	}
	stop(): void {
		this.onInput = () => {};
	}
	drainInput(): Promise<void> {
		return Promise.resolve();
	}
	write(value: string): void {
		this.output += value;
	}
	moveBy(lines: number): void {
		if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
	}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {
		this.write("\x1b[2K");
	}
	clearFromCursor(): void {
		this.write("\x1b[J");
	}
	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(_status: ProgramStatus): void {}
	input(value: string): void {
		this.onInput(value);
	}
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.onResize();
	}
}
