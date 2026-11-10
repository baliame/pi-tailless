# Pi tailless

Pi's extensible terminal UI as an independent Agent Client Protocol (ACP) frontend.

Run the agent harness in another process or environment while keeping Pi's editor, conversation display, themes, keybindings and frontend extensions locally. Tailless negotiates ACP v1 or a pinned v2 draft with the selected endpoint.

The companion [pi-acp-harness](https://github.com/baliame/pi-acp-harness) exposes Pi's SDK through ACP. Tailless can also connect to other compatible ACP agents through a stdio executable or connector.

## Features

- Pi terminal rendering, streamed responses, tool output and reasoning display.
- Local frontend extensions for widgets, dialogs, editor hooks and capability consumers.
- Session creation, listing, resume and local view switching.
- Permission prompts, form elicitation and advertised model/thinking configuration.
- Optional experimental shared-session attach/detach and FIFO prompt delivery.
- A separate shared-queue extension with live waiting input and safe queue removal.

This is an experimental source fork. Existing Pi extensions that mix UI and harness hooks need adaptation: frontend UI and backend execution run separately.

## Build

Requires Node.js 22.19 or newer; local verification used Node 24.11.1 on Windows.

```sh
git clone git@github.com:baliame/pi-tailless.git
cd pi-tailless/apps/tailless
npm ci --ignore-scripts --workspaces=false
npm run build --workspaces=false
```

Use `npm.cmd` in Windows PowerShell if execution policy prevents `npm`. The app has its own lockfile and builds independently of the retained upstream monorepo. No global installation is required.

## Connect to an agent

Create `.pi-acp/config.json` in your local project:

```json
{
  "endpoint": {
    "command": "your-acp-agent",
    "args": []
  },
  "peerCwd": "/absolute/workspace/on/the/agent",
  "extensions": [],
  "theme": "dark",
  "keybindings": {}
}
```

Use the agent's actual absolute workspace path, such as `C:/work/project` on Windows. Launch the built frontend from that local project:

```sh
node /absolute/pi-tailless/apps/tailless/dist/cli.js --config .pi-acp/config.json
```

The endpoint command is spawned directly with argv. It must speak ACP JSONL on stdout; diagnostics belong on stderr. `endpoint.cwd` controls the local launch directory, while `peerCwd` refers to the harness environment. Configuration does not provision a remote harness.

For the companion harness's deterministic HTTP demo, use this endpoint instead:

```json
{
  "command": "node",
  "args": ["/absolute/pi-acp-harness/dist/cli.js", "attach", "--url", "http://127.0.0.1:31400/acp"]
}
```

Start the server using [the harness instructions](https://github.com/baliame/pi-acp-harness#try-it-without-a-model-account). The connector reaches that existing process; launching a direct stdio harness creates a separate session registry. An existing SSH launcher or tunnel can provide remote access.

## Sessions and controls

Ordinary startup creates a session. `/sessions` selects a retained conversation with its listed workspace; `/resume <id>` and startup `--resume <id>` use the configured workspace. `/switch <id>` changes the local view of an already-active session. `/disconnect` closes the connection and keeps a newer local editor draft; retention of remote work is a harness policy. Prompts are never automatically resent.

Use `/help` for commands, `/config` for advertised settings, `/theme dark|light`, `/reload` for frontend extensions and `/quit` to exit. Esc cancels foreground work, Ctrl+C clears input, Ctrl+D exits an empty editor, Ctrl+O toggles tools and Ctrl+T toggles reasoning. Keybindings are configurable.

## Shared sessions and queued input

Enable the two optional L2 modules and load the L3 queue UI separately:

```json
{
  "endpoint": {
    "command": "node",
    "args": ["/absolute/pi-acp-harness/dist/cli.js", "attach", "--url", "http://127.0.0.1:31410/acp", "--token-file", "/private/token"]
  },
  "peerCwd": "/absolute/workspace/on/the/agent",
  "experimental": ["multi-client-attach", "prompt-delivery"],
  "extensions": ["/absolute/pi-tailless/apps/tailless/dist/capabilities/shared-queue.js"],
  "theme": "dark",
  "keybindings": {}
}
```

Start a matching shared host independently. Replace the endpoint URL with `ws://127.0.0.1:31410/acp` for native WebSocket. Both transports reach the same registry. Core ACP remains the default; L2 proposals are selected before initialization, and L3 is an independently loaded capability consumer.

Let another client create a conversation, then use `/attach`, `/attach <id>` or startup `--attach <id>`. Missing or incompatible profiles produce an error, never a fallback conversation. `--attach` and `--resume` are mutually exclusive. `/detach [id]` removes one membership; `/switch` leaves other memberships and runs intact.

`/queue` refreshes the waiting-input widget. `/queue-pop` removes only the expected next entry, without executing it or interrupting the current turn. A stale action refreshes the queue without retrying against another entry. Removed input never reappears in the editor. Cancel preserves waiting input; close clears it; disconnect drops this client's uninserted input.

These are pinned ACP proposals with documented local adaptations. Unmodified clients do not gain draft attach or queue controls automatically. See the [layered contract](apps/tailless/docs/layered-acp-contract.md) and [proposal pins](apps/tailless/docs/experimental-provenance.json).

## Extensions and development

Frontend extensions use the same advertised capability APIs as native consumers. See [extension authoring](apps/tailless/docs/extensions.md), [the task example](apps/tailless/examples/tasks.ts) and the [full app guide](apps/tailless/README.md).

From `apps/tailless`:

```sh
npm run check --workspaces=false
npm run build --workspaces=false
node --test --test-concurrency=1 test/*.test.ts
```

The local suite has 32 passing cases; two external-peer tests run when their documented environment is provided. Those tests and two-project SDK/acpx/terminal exchanges passed during development. The shared-host Panda GUI scenario and other platforms remain unverified.

## Upstream and license

This fork retains [upstream Pi](https://github.com/earendil-works/pi) at base `9879bb44754ce42f52800371aac8cfbccf521cb7`. The ACP application lives in `apps/tailless` and uses Pi TUI 1.5.0; root monorepo commands operate on upstream Pi. See [TAILLESS.md](TAILLESS.md) for update guidance and the [original upstream README](https://github.com/earendil-works/pi/blob/9879bb44754ce42f52800371aac8cfbccf521cb7/README.md).

MIT. Original Pi notices and source provenance are retained; see [LICENSE](LICENSE) and the app's [third-party licenses](apps/tailless/licenses).
