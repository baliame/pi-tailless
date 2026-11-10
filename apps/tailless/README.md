# Pi tailless frontend

Pi terminal presentation and frontend extensions connected to ACP v1 or the pinned v2 draft. This app uses upstream Pi TUI 1.5.0 and presentation-only source adaptations. It imports no harness, tools or providers. The retained upstream tree is described in [TAILLESS.md](../../TAILLESS.md).

Use Node 22.19 or newer. From `apps/tailless`:

```powershell
npm.cmd ci --ignore-scripts --workspaces=false
npm.cmd run build --workspaces=false
npm.cmd run check --workspaces=false
node --test test/app.test.ts test/protocol.test.ts test/lifecycle.test.ts test/ui.test.ts test/form.test.ts
```

Use `npm` outside Windows. This app has its own lockfile and `.npmrc`; it does not require installing the upstream monorepo. No global linking is needed.

## Connect

Create a local configuration file, substituting absolute paths:

```json
{
  "endpoint": {
    "command": "node",
    "args": ["C:/absolute/pi-acp-harness/dist/cli.js", "attach", "--url", "http://127.0.0.1:31400/acp"]
  },
  "peerCwd": "C:/absolute/workspace",
  "extensions": ["C:/absolute/pi-tailless/apps/tailless/examples/tasks.ts"],
  "theme": "dark",
  "keybindings": {}
}
```

Start a compatible ACP harness independently, then run:

```powershell
node dist/cli.js --config C:\absolute\config.json
```

The endpoint can be any ACP executable or existing remote connector. It is spawned directly with argv; stdout is ACP JSONL, stderr diagnostics. `endpoint.cwd` is an optional local launch directory relative to the config. `peerCwd` is an absolute directory in the harness environment; extension paths are relative to the config. Environment inherits locally, with optional `endpoint.env` overrides. Configuration does not provision a server.

`/help` lists commands. `/tasks` is a native capability consumer; `/task-widget` is supplied by the optional frontend example. Both show unavailable when the peer omits `com.example/tasks` version 1. `/config` selects advertised model/thinking choices. `/sessions`, `/new`, `/switch <id>` and `/resume <id>` manage the view and remote sessions.

Ordinary startup and `/connect` create a new conversation. `/sessions` selects an existing conversation and resumes with that session's advertised workspace. For explicit `/resume <id>` or startup `--resume <id>`, set `peerCwd` to its original workspace. A peer may reject resuming a session still owned by another connected client; disconnect that client before handing it over.

HTTP or WebSocket connectors can reach the same persistent harness and session IDs. Direct `stdio` launches a separate harness process with its own sessions; it does not share the server's in-memory registry. A WebSocket bridge may also limit concurrent connections independently of the harness.

To verify persistence with the separate harness demo, submit `slow message`, record the session ID, use `/disconnect`, then `/connect`. Wait for the connected footer before `/resume <original-id>`. Send another prompt: the demo reports two user messages. An unfinished editor draft stays local across disconnect. Disconnect does not resend prompts or imply cancellation; retention is a harness policy. `--resume <id>` resumes on startup.

Esc cancels foreground work, Ctrl+C clears input, Ctrl+D exits an empty editor, Ctrl+O toggles tool expansion and Ctrl+T toggles reasoning. Permission dialogs identify their session and require an explicit choice. `/close` uses v2 close; `/quit` restores the terminal and disconnects. Keybindings are configurable. V1 and v2 are negotiated per connection; v2 is a pinned draft, so compatibility with arbitrary future drafts is not implied.

## Optional experimental shared sessions

Enable the paired L2 modules before initialization and load the L3 queue UI separately:

```json
{
  "endpoint": {
    "command": "node",
    "args": ["C:/absolute/pi-acp-harness/dist/cli.js", "attach", "--url", "http://127.0.0.1:31410/acp", "--token-file", "C:/private/token"]
  },
  "peerCwd": "C:/absolute/workspace",
  "experimental": ["multi-client-attach", "prompt-delivery"],
  "extensions": ["C:/absolute/pi-tailless/apps/tailless/dist/capabilities/shared-queue.js"],
  "theme": "dark",
  "keybindings": {}
}
```

Use `ws://127.0.0.1:31410/acp` for the native WebSocket connector instead of HTTP. Both reach the same persistent registry. Direct stdio still starts its own host unless it runs a connector. The experimental host must be started separately with matching modules and a token; config does not provision it. Browser clients use the private browser URL and require their exact Origin on the server's allowlist.

Let Panda create the conversation, then use `/attach` to choose it, `/attach <id>`, or `node dist/cli.js --config <file> --attach <id>` at startup. The picker uses the listed workspace. `--attach` and `--resume` are mutually exclusive. A missing or incompatible profile reports an error; attachment never falls back to creating a conversation. Ordinary startup still creates a new session.

`/detach [id]` removes one membership. `/switch <id>` changes only this UI's view; other attached sessions keep running. `/sessions` and `/resume` retain sequential handoff semantics, so use `/attach` when another client is still connected. The footer marks experiments. The core package entry imports no optional implementation; library callers pass module objects to `FrontendApp` or register them on `AcpClient` before connecting.

With the queue extension, `/queue` refreshes the FIFO widget. `/queue-pop` removes its expected next waiting message without executing it or cancelling the current turn. It uses the known head and refreshes after a stale error; it never retries against the following entry. All capable clients receive updates, and an empty queue is harmless. Names appear when known, otherwise an abbreviated client ID identifies the submitter. A popped message is never restored to the editor, and a newer draft stays intact. Reload disposes the widget, commands, in-flight capability calls and listener without detaching.

Prompts on v2 use advertised `delivery: "queue"`. Pending input is absent from conversation history until insertion. The documented v1 compatibility policy follows each queued turn's completion. Esc stops the active turn while leaving waiting messages scheduled; `/close` stops activity and clears waiting input. Disconnect drops this client's uninserted requests while the harness retains already running work.

L2 attach and delivery exports are independent; the L3 queue UI requires both. L2 changes require reconnect, while ordinary L3 reload stays local. Unmodified Panda does not acquire these controls. See the [complete local profile](docs/layered-acp-contract.md) and [pinned sources](docs/experimental-provenance.json) for draft adaptations and limits. Run `node --test --test-concurrency=1 test/experimental.test.ts` for the added frontend checks.

## Extensions and checks

See [extension authoring](docs/extensions.md), [task example](examples/tasks.ts), [protocol profile](docs/acp-client-profile.md) and [PoC contract](docs/poc-contract.md). The frontend extension API owns widgets, dialogs, editor hooks and capability consumers. Existing combined Pi extensions need adaptation: backend hooks and frontend UI run in separate environments.

`test/harness.test.ts` optionally checks an external persistent harness and the official ACP sample agent. Set `POC_HARNESS_ENTRY` to the built harness CLI, `POC_HARNESS_URL`, `POC_WORKSPACE`, and `POC_REFERENCE_AGENT` to an independently obtained official sample before running it. Without those variables its two tests explicitly skip. Fixture tests alone are not external interoperability evidence.

Pi adaptations and ACP schema pins are recorded in [source provenance](docs/source-provenance.json) and [ACP provenance](docs/acp-provenance.json). Licenses are included. Windows ConPTY was exercised with Node 24.11.1; other terminals/platforms and every ACP endpoint are unverified.
