/** Bidirectional ACP JSONL transport over an explicitly configured child process. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { type Json, message, object, RpcError, string } from "./json.ts";

export interface Launch {
	command: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
	timeoutMs?: number;
}
type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void };
export type RequestHandler = (method: string, params: Json, signal: AbortSignal, id: string | number) => Promise<Json>;

/** Own one transport; request IDs belong only to this connection. */
export class RpcConnection {
	readonly process: ChildProcessWithoutNullStreams;
	onRequest: RequestHandler = async () => {
		throw new RpcError(-32601, "Method not found");
	};
	onNotification: (method: string, params: Json) => void = () => {};
	onDiagnostic: (text: string) => void = () => {};
	onClose: (error: Error) => void = () => {};
	private pending = new Map<string | number, Pending>();
	private inbound = new Map<string | number, AbortController>();
	private inboundSession = new Map<string | number, string>();
	private sequence = 0;
	private buffer = "";
	private decoder = new StringDecoder("utf8");
	private ended = false;
	private readonly timeoutMs: number;
	constructor(launch: Launch) {
		this.timeoutMs = launch.timeoutMs ?? 120_000;
		this.process = spawn(launch.command, launch.args, {
			env: { ...process.env, ...launch.env },
			cwd: launch.cwd,
			stdio: "pipe",
			shell: false,
			windowsHide: true,
		});
		this.process.stdout.on("data", (chunk: Buffer) => {
			try {
				this.receive(this.decoder.write(chunk));
			} catch (error) {
				this.close(new Error(message(error)));
			}
		});
		this.process.stderr.setEncoding("utf8").on("data", (text: string) => this.onDiagnostic(text));
		this.process.on("error", (error) => this.close(error));
		this.process.on("exit", (code, signal) => this.finish(new Error(`ACP process exited (${code ?? signal})`)));
	}

	/** Send a request while continuing to service peer requests. */
	request(method: string, params: Json, signal?: AbortSignal): Promise<Json> {
		if (this.ended) return Promise.reject(new Error("ACP connection closed"));
		if (signal?.aborted) return Promise.reject(new Error("Request cancelled"));
		const id = `client-${++this.sequence}`;
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
			};
			const cancel = () => {
				this.pending.delete(id);
				cleanup();
				if (!this.ended) this.notify("$/cancel_request", { requestId: id });
				reject(new Error("Request cancelled"));
			};
			const timer =
				method === "session/prompt"
					? undefined
					: setTimeout(() => {
							this.pending.delete(id);
							cleanup();
							reject(new Error(`ACP request timed out: ${method}`));
						}, this.timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					cleanup();
					resolve(value);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			signal?.addEventListener("abort", cancel, { once: true });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** Send a one-way protocol notification. */
	notify(method: string, params: Json): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	/** Abort pending interactions for a cancelled session without approving them. */
	abortInteractions(sessionId?: string): void {
		for (const [id, controller] of this.inbound) {
			if (sessionId === undefined || this.inboundSession.get(id) === sessionId) controller.abort();
		}
	}

	/** Close this transport; no remote work cancellation is implied. */
	close(error = new Error("Disconnected")): void {
		if (this.ended) return;
		this.finish(error);
		this.process.stdin.end();
		const child = this.process;
		const timer = setTimeout(() => {
			if (child.exitCode === null) child.kill();
		}, 1500);
		timer.unref();
	}

	private finish(error: Error): void {
		if (this.ended) return;
		this.ended = true;
		this.abortInteractions();
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		this.onClose(error);
	}

	private send(value: Json): void {
		if (this.ended) throw new Error("ACP connection closed");
		this.process.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
			if (error) this.close(error);
		});
	}

	private receive(text: string): void {
		this.buffer += text;
		if (this.buffer.length > 16 * 1024 * 1024) throw new Error("ACP record exceeds 16 MiB");
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (line.length) this.dispatch(object(JSON.parse(line), "ACP message"));
			newline = this.buffer.indexOf("\n");
		}
	}

	private dispatch(record: ReturnType<typeof object>): void {
		if (record.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC version");
		const id = record.id;
		if (id === null && record.error !== undefined) {
			this.onDiagnostic("Peer reported an uncorrelated JSON-RPC error");
			return;
		}
		if (id !== undefined && typeof id !== "string" && !Number.isInteger(id)) throw new Error("Invalid request ID");
		if (record.method !== undefined) {
			const method = string(record.method, "method");
			const params = record.params ?? {};
			if (id === undefined) {
				if (method === "$/cancel_request") {
					const requested = object(params).requestId;
					if (typeof requested === "string" || typeof requested === "number") this.inbound.get(requested)?.abort();
				} else
					queueMicrotask(() => {
						if (this.ended) return;
						try {
							this.onNotification(method, params);
						} catch (error) {
							this.close(new Error(message(error)));
						}
					});
				return;
			}
			const requestId = id as string | number;
			if (this.inbound.has(requestId)) throw new Error("Duplicate peer request ID");
			const controller = new AbortController();
			this.inbound.set(requestId, controller);
			if (
				params !== null &&
				typeof params === "object" &&
				!Array.isArray(params) &&
				typeof params.sessionId === "string"
			)
				this.inboundSession.set(requestId, params.sessionId);
			void Promise.resolve()
				.then(() => this.onRequest(method, params, controller.signal, requestId))
				.then(
					(result) => {
						if (!this.ended) this.send({ jsonrpc: "2.0", id: requestId, result });
					},
					(error: unknown) => {
						if (!this.ended)
							this.send({
								jsonrpc: "2.0",
								id: requestId,
								error: {
									code: error instanceof RpcError ? error.code : -32603,
									message: message(error),
								},
							});
					},
				)
				.finally(() => {
					this.inbound.delete(requestId);
					this.inboundSession.delete(requestId);
				});
			return;
		}
		if (id === undefined || (record.result === undefined) === (record.error === undefined))
			throw new Error("Invalid response");
		const pending = this.pending.get(id as string | number);
		if (!pending) return;
		if (record.error !== undefined) {
			const error = object(record.error);
			if (typeof error.code !== "number") throw new Error("Invalid RPC error code");
			const failure = new RpcError(error.code, string(error.message), error.data);
			this.pending.delete(id as string | number);
			pending.reject(failure);
		} else {
			this.pending.delete(id as string | number);
			pending.resolve(record.result);
		}
	}
}
