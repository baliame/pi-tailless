// Test extension whose pending UI must be disposed when unloaded.
export default function extension(api) {
	api.registerCommand("wait-dialog", "Open a pending dialog", async () => {
		await api.ui.custom(() => ({
			render: () => ["Extension dialog"],
			invalidate() {},
			dispose() {
				api.ui.setStatus("disposed", "yes");
			},
		}));
	});
	api.registerShortcut("test.extension", "ctrl+y", () => api.ui.setEditorText("extension shortcut"));
}
