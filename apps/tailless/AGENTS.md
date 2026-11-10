# Tailless frontend

Follow the repository's Pi development rules. Keep authored code brief and readable, with top-level imports, strict erasable TypeScript, configurable keybindings and validation at wire/configuration boundaries. Do not add harness/provider imports.

This application has its own dependency lock and build. Run `npm.cmd run check --workspaces=false` after code changes and focused `node --test` files after editing them. Install with `--ignore-scripts --workspaces=false`. No provider calls, paid tokens, global installation or commits.

The coordinated PoC approval is retained by the parent Pi-ACP project at revision `c4694282e3d031f0732476db5847b30842e287ad3f5cef0429c8753a681f722e`. Use AIDLC for future planning/changes; that approval covers only the documented local PoC. Do not modify managed user-level AIDLC resources here.
