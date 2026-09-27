// Packs dist/server.mjs into dist/x-context.mcpb, the Claude Desktop extension.
// The version comes from package.json so the plugin and the extension stay in step.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, ".mcpb-build");
const out = join(root, "dist", "x-context.mcpb");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cli = join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
manifest.version = version;
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(join(root, "dist", "server.mjs"), join(stage, "server", "index.mjs"));
copyFileSync(join(root, "mcpb", "icon.png"), join(stage, "icon.png"));
copyFileSync(join(root, "README.md"), join(stage, "README.md"));

execFileSync(process.execPath, [cli, "validate", join(stage, "manifest.json")], { stdio: "inherit" });
rmSync(out, { force: true });
execFileSync(process.execPath, [cli, "pack", stage, out], { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
