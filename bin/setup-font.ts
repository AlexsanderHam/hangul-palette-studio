import { existsSync } from "node:fs";
import { join } from "node:path";
import { prepareOfficialFontSources } from "../src/font/inputs.ts";

const root = join(import.meta.dir, "..");
const runtime = join(root, ".cache/font-export-venv");
const executable = join(runtime, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
function supportedPython(executable: string): boolean {
  try {
    const checked = Bun.spawnSync(
      [executable, "-c", "import sys;sys.exit(0 if sys.version_info >= (3,11) else 1)"],
      { stdout: "ignore", stderr: "ignore" },
    );
    return checked.exitCode === 0;
  } catch {
    return false;
  }
}

function findPython(): string {
  if (process.env.STUDIO_PYTHON) {
    if (!supportedPython(process.env.STUDIO_PYTHON))
      throw new Error("STUDIO_PYTHON must point to an executable Python 3.11 or newer.");
    return process.env.STUDIO_PYTHON;
  }
  for (const candidate of ["python3.14", "python3.13", "python3.12", "python3.11", "python3", "python"])
    if (supportedPython(candidate)) return candidate;
  throw new Error("Python 3.11 or newer is required. Set STUDIO_PYTHON to its executable path.");
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${command[0]}`);
}

try {
  if (process.env.STUDIO_PYTHON && !supportedPython(process.env.STUDIO_PYTHON))
    throw new Error("STUDIO_PYTHON must point to an executable Python 3.11 or newer.");
  if (existsSync(executable) && !supportedPython(executable))
    throw new Error(
      "The existing .cache/font-export-venv uses an unsupported Python. Remove that generated cache and run setup again.",
    );
  if (!existsSync(executable)) await run([findPython(), "-m", "venv", runtime]);
  await run([
    executable,
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "-r",
    join(root, "src/font/compiler/requirements.txt"),
  ]);
  await run([executable, join(root, "src/font/compiler/export.py"), "--check"]);
  await prepareOfficialFontSources(root);
  console.log("컬러 폰트 내보내기 준비가 완료되었습니다.");
} catch (error) {
  console.error("폰트 도구를 준비하지 못했습니다. Python 3.11 이상과 venv, pip을 확인하세요.");
  console.error((error as Error).message);
  process.exitCode = 1;
}
