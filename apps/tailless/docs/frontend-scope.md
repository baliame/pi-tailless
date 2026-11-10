> Historical frontend-first discovery. The split PoC now uses the published Pi TUI dependency and a separate SDK harness; see README.md and poc-contract.md. Paths below identify the original research checkout.

# Frontend phase

The first deliverable is a standalone pi-derived terminal frontend that connects to ACP v1 and v2 peers. The production harness and control plane are outside this change.

## Source inspection

- Pi: `upstream/pi`, commit `9879bb44754ce42f52800371aac8cfbccf521cb7`, coding-agent and tui version 1.5.0. This reference checkout is unmodified.
- ACP: `upstream/acp`, commit `7441d106a853682cce61d2dd7db54123e4b9a477`. V1 is stable and v2 is draft. This reference checkout is unmodified.
- Pi's InteractiveMode is constructed with AgentSessionRuntime and directly reads its session, models, resources and extension runner. Changing its transport alone is insufficient.
- ExtensionUIContext supplies the model for local widgets, dialogs, overlays, editor replacement, autocomplete, header/footer, themes and terminal input. The combined ExtensionAPI also exposes tools and model hooks; that harness API is excluded from the frontend contract.
- AssistantMessageComponent uses provider-level messages. Its extracted version needs presentation types populated by ACP reducers instead.
- Upstream explicitly marks apps/p2 as unsupported and scheduled for replacement. It is not the foundation of this fork.

## Phase boundary

The user chose the frontend first, ACP v1 and v2 negotiated per connection, and pi's coding standards. Capabilities identify API contracts independent of extension packages. A native TUI consumer and a frontend extension can use the same API.

Proposed implementation: a standalone workspace with selected pi presentation source and a local source-pinned pi-tui package. Preserve MIT notices and file provenance. Reference checkouts stay unmodified and are not runtime dependencies. Runtime imports do not reach AgentSession, provider implementations, pi-durable or local coding tools.

The frontend invokes a configured executable with argv/environment to obtain an ACP stdio channel. Existing launchers/connectors supply remote access. Remote cwd is a separate absolute path in the peer machine's syntax.

Backend runtime choice, persistence after disconnection, simultaneous-client arbitration and infrastructure management are deferred. The frontend follows protocol state and capabilities without promising a backend durability policy. Connection capability changes require an explicit reconnect in this phase; ordinary session config/command updates remain live.

## Standards and toolchain

Follow pi's relevant AGENTS.md, Biome and TypeScript settings: strict erasable TypeScript, tabs, 120-column formatting, top-level imports, configurable keys, pinned direct dependencies and boundary validation. Use focused deterministic tests, npm run check, and no provider API calls. Do not run the full npm test command or lifecycle scripts.

Default Windows Node reports 22.16.0; upstream requires at least 22.19.0. Locate or provision a project-local compatible Node after approval. Use npm.cmd because the npm PowerShell shim is blocked by current policy; do not change system policy.
