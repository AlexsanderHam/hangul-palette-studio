import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Run the real CLI with only a controlled Python command available; no setup files are created. */
async function pythonOnlySetup(versionExitCode: number) {
  const root = await mkdtemp(join(tmpdir(), "hangul-palette-setup-test-"));
  try {
    const entry = join(root, "bin/setup-font.ts"),
      commands = join(root, "commands"),
      log = join(root, "python.log");
    await mkdir(join(root, "bin"));
    await mkdir(commands);
    const source = await readFile(new URL("../bin/setup-font.ts", import.meta.url), "utf8");
    const imported = JSON.stringify(resolve(import.meta.dir, "../src/font/inputs.ts"));
    const copy = source.replace(/from ["']\.\.\/src\/font\/inputs\.ts["']/, `from ${imported}`);
    expect(copy).not.toBe(source);
    await writeFile(entry, copy);
    const python = join(commands, "python");
    await writeFile(
      python,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$STUDIO_SETUP_TEST_LOG"
if [ "$1" = "-c" ]; then exit "$STUDIO_SETUP_TEST_VERSION_EXIT"; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  echo 'SETUP_TEST_VENV_REACHED' >&2
  exit 79
fi
echo 'SETUP_TEST_UNEXPECTED_COMMAND' >&2
exit 80
`,
    );
    await chmod(python, 0o755);
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "STUDIO_PYTHON"),
    );
    const child = Bun.spawn([process.execPath, entry], {
      cwd: root,
      env: {
        ...environment,
        PATH: commands,
        STUDIO_SETUP_TEST_LOG: log,
        STUDIO_SETUP_TEST_VERSION_EXIT: String(versionExitCode),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const calls = existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n") : [];
    expect(existsSync(join(root, ".cache/font-export-venv"))).toBe(false);
    return { code, stdout, stderr, calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// POSIX executable stubs model PATH discovery; Windows does not execute these shell scripts.
test.skipIf(process.platform === "win32")(
  "setup discovers a supported Python available only as python",
  async () => {
    const result = await pythonOnlySetup(0);
    expect(result.code).toBe(1); // The stub intentionally stops before creating the venv or running pip.
    expect(result.stderr).toContain("SETUP_TEST_VENV_REACHED");
    expect(result.stderr).not.toContain("Python 3.11 or newer is required");
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]).toStartWith("-c ");
    expect(result.calls[1]).toStartWith("-m venv ");
  },
);

test.skipIf(process.platform === "win32")(
  "setup rejects an unsupported python fallback before creating an environment",
  async () => {
    const result = await pythonOnlySetup(1);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Python 3.11 or newer is required");
    expect(result.stderr).not.toContain("SETUP_TEST_VENV_REACHED");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toStartWith("-c ");
  },
);
