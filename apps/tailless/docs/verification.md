# Local verification

Windows ConPTY, Node 24.11.1, 2026-11-09. Independent `npm run check --workspaces=false` and `npm run build --workspaces=false` passed. The focused form/lifecycle/protocol/UI tests plus `test/harness.test.ts`, with external-peer environment supplied, passed 24 tests with no failures/skips.

The external checks used a separately running Pi SDK harness over ACP v2 and the official ACP SDK sample agent over v1. The harness was first verified with independent acpx 0.22.0. Frontend tests cover configuration, explicit permission, native-equivalent task API consumption, extension widget/callback, a retained local draft, reconnect/resume without duplicate entities and a second prompt preserving model context. The sample agent streamed two tools and honored permission denial. Fixture-only runs skip the external tests when not configured.

Real terminal smoke checks covered native `/tasks`, extension `/task-widget`, streaming detach, reconnect/resume of the original ID, context retention, permission approval, Esc cancellation and clean exit. A host omitting the task capability produced explicit unavailable states in both consumers. Wait for connection completion before issuing resume; an early command was rejected and retry after connection succeeded.

The package dry run contained 90 files, including built schemas/themes, public entrypoints, examples, contracts and licenses. The upstream tracked tree is unchanged at the documented Pi pin. No harness/provider runtime imports, lifecycle scripts, custom commits, provider calls, publishing or global installation were introduced. Other terminals/platforms, arbitrary ACP agents and future v2 drafts remain unverified. The coordinating Pi-ACP project retains complete approval and integration evidence.

Maintenance on 2026-11-09 repaired `/sessions` selecting a conversation with a different workspace. Four new v1/v2 app-command regression cases passed, along with the existing 22 focused frontend tests run serially, check and build. The existing v2 prompt test hit a timing assumption during an initial parallel run; it passed in isolation and in the serial suite. No live server restart or Panda takeover was performed. Restart the TUI to load the rebuilt code, then use `/sessions` after the owning client disconnects. Explicit `/resume` and `--resume` continue to use the configured peerCwd.

