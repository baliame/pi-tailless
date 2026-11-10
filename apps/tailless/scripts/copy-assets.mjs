/** Keep runtime assets beside the compiled frontend. */
import { cpSync } from "node:fs";

cpSync("src/themes", "dist/themes", { recursive: true });
cpSync("src/schemas", "dist/schemas", { recursive: true });
