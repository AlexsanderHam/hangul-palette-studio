import { parseArgs } from "node:util";
import { startStudioServer } from "../src/studio/server/server.ts";

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string", short: "p", default: "4000" },
      data: { type: "string", short: "d", default: "data/glyphs.json" },
      workspace: { type: "string", short: "w", default: "data/.studio" },
      "read-only": { type: "boolean", default: false },
      recover: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`Hangul Palette Studio

Usage: bun run start [options]
  -p, --port <number>           Local HTTP port (default: 4000)
  -d, --data <path>             Glyph source data (default: data/glyphs.json)
  -w, --workspace <directory>   Saved work and backups (default: data/.studio)
      --read-only              Inspect without changing the saved workspace
      --recover <id|latest>    Recover a saved backup; preserve the damaged file
  -h, --help                   Show this help

Palette changes are saved to <workspace>/project.json.
Studio prepares all nine weights automatically, reusing verified cached builds.
Choose a CSS palette and download CSS or the complete font ZIP.`);
  } else {
    if (!/^\d+$/.test(values.port!)) throw new Error("Port must be an integer from 1 to 65535.");
    const port = Number(values.port);
    if (port < 1 || port > 65535) throw new Error("Port must be an integer from 1 to 65535.");
    const instance = await startStudioServer({
      port,
      dataPath: values.data!,
      workspacePath: values.workspace!,
      readOnly: values["read-only"],
      recover: values.recover,
    });
    console.log(
      `Hangul Palette Studio\nLocal: http://localhost:${instance.server.port}\nGlyphs: ${instance.store.snapshot().glyphCount}\nWorkspace: ${instance.store.workspacePath}${values["read-only"] ? " (read only)" : ""}`,
    );
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await instance.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });
  }
} catch (error) {
  console.error(`Studio: ${(error as Error).message}`);
  process.exitCode = 1;
}
