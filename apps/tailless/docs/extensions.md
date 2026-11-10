# Frontend extension authoring

Export a default factory accepting `ExtensionAPI` from `@pi-acp/frontend`. Local extensions load before ACP initialization and can register UI behavior without requiring a matching backend package.

```ts
import type { ExtensionAPI } from "@pi-acp/frontend";

export default function extension(api: ExtensionAPI): void {
  api.registerCommand("inspect-tasks", "Inspect tasks", async () => {
    const advertised = api.client.capability("com.example/tasks");
    if (!advertised) {
      api.ui.notify("Task API unavailable");
      return;
    }
    const result = await api.client.request("_com.example/tasks/list", {
      sessionId: api.sessionId() ?? ""
    });
    api.ui.setWidget("tasks", [JSON.stringify(result)]);
  });
}
```

The runnable [tasks example](../examples/tasks.ts) also checks its contract version. A production consumer validates the advertised contract, result and notifications according to that contract's schema. Capability metadata does not teach a consumer an unknown API. Use an owned reverse-DNS namespace for production; `com.example` is demonstration data.

## Capability and method registration

- `registerCapability(key, value)` adds a custom declaration to the next initialization. `api.client.capability(key)` reads the peer's root custom metadata. Nested protocol capability data is available through `api.client.peerCapabilities`.
- `api.client.request(method, params, signal?)` and `notify(method, params)` call custom underscore-prefixed ACP methods.
- `onRequest(method, handler)` and `onNotification(method, handler)` expose handlers to the peer. Unknown requests receive Method not found. Unknown notifications are ignored.
- Each contract defines its own version semantics, parameters, results, errors and session scope. Handlers validate their custom input; core standard messages are checked against pinned ACP schemas. No plugin manifest or generic capability-invocation wrapper is sent on the wire.

Use `RpcError` to return a specific JSON-RPC error. Other thrown request errors become Internal error. A notification error is shown locally. If infrastructure terminates ACP rather than forwarding it transparently, it must implement or relay the corresponding capability methods.

## Local UI

`api.ui` provides select/confirm/input dialogs with cancellation signals, notifications, widgets above/below the editor, status text, header/footer, terminal title, custom TUI overlays, editor text/replacement, autocomplete composition, raw terminal input and themes. Custom components use upstream `@earendil-works/pi-tui`. `custom` resolves with `undefined` if cancelled and disposes its component when closed.

Register local commands with `registerCommand`, configurable shortcuts with `registerShortcut`, entity renderers with `registerRenderer` and Markdown transforms with `registerMarkdownTransformer`. Renderer keys are frontend entity kinds such as `tool`, `agent_message`, `agent_thought` and `user_message`. Custom renderer factories own any additional resources and should register cleanup where needed.

The frontend assigns ownership to command/handler/UI registrations. Reload removes the old extension's widgets, handlers, shortcuts and editor hooks, aborts its dialogs, then reloads its module without module cache. `onDispose` handles extra local resources such as timers or subscriptions. Register cleanup before starting background local work. Extensions execute with normal local Node.js permissions and are not downloaded from peers.

Changing advertised declarations after initialization marks the connection as needing `/connect`. Reloading an unchanged declaration or changing only presentation does not change the wire contract. Standard peer session configuration and command updates remain live.

## Fixture task API

The fixture advertises `com.example/tasks: {version: 1}`. `_com.example/tasks/list` takes `{sessionId: string}` and returns `{tasks: [{id: string, title: string, status: string}]}`. Native `/tasks` and extension `/task-widget` consume it. This fixture is not a production harness feature.
