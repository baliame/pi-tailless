/** Verify exact dependencies, source attribution and the frontend runtime boundary. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

function sources(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? sources(join(directory, entry.name)) : [join(directory, entry.name)],
	);
}

for (const file of [...sources("src"), ...sources("test"), ...sources("examples")].filter((file) =>
	file.endsWith(".ts"),
)) {
	const content = readFileSync(file, "utf8");
	assert(!/\bimport\s*\(/.test(content), `Inline import: ${file}`);
	assert(
		!/from\s+["'][^"']*(?:pi-ai|pi-agent-core|pi-coding-agent|pi-durable|pi-acp-harness|upstream\/)/.test(content),
		`Harness import: ${file}`,
	);
	const visit = (node) => {
		assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword, `Explicit any: ${file}`);
		ts.forEachChild(node, visit);
	};
	visit(ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true));
}

const metadata = JSON.parse(readFileSync("package.json", "utf8"));
for (const version of Object.values({ ...metadata.dependencies, ...metadata.devDependencies }))
	assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), `Unpinned dependency: ${version}`);
const acp = JSON.parse(readFileSync("docs/acp-provenance.json", "utf8"));
for (const entry of acp.files)
	assert.equal(createHash("sha256").update(readFileSync(entry.destination)).digest("hex"), entry.upstream_sha256);
const pi = JSON.parse(readFileSync("docs/source-provenance.json", "utf8"));
for (const entry of pi.files) {
	const content = readFileSync(entry.destination);
	if (!entry.adapted) assert.equal(createHash("sha256").update(content).digest("hex"), entry.upstream_sha256);
}
assert(readFileSync("LICENSE", "utf8").includes("MIT"));
assert(readFileSync("licenses/ACP-Apache-2.0.txt", "utf8").includes("Apache License"));
const visited = new Set();
function core(file) {
	if (visited.has(file)) return;
	visited.add(file);
	assert(!/[\\/](experimental|capabilities)[\\/]/.test(file), `Optional implementation imported by core: ${file}`);
	for (const match of readFileSync(file, "utf8").matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g))
		core(resolve(dirname(file), match[1]));
}
core(resolve("src/index.ts"));
console.log("Frontend boundary, pins and provenance: pass");
