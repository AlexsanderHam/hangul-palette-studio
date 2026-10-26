import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const python = join(
  root,
  ".cache/font-export-venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const hasRuntime = existsSync(python);

test.skipIf(!hasRuntime)("compiler and font metadata use the same bounded OpenType version mapping", () => {
  const script = `
import sys
sys.path.insert(0, sys.argv[1])
from export import ExportError, font_version
from official import OfficialFontError, font_version as official_version
for value,revision,name in (("0.0.0",0.0,"Version 0.000; Hangul Palette 0.0.0"),
                            ("1.0.0",1.0,"Version 1.000; Hangul Palette 1.0.0"),
                            ("1.0.1",1.001,"Version 1.001; Hangul Palette 1.0.1"),
                            ("32767.9.99",32767.999,"Version 32767.999; Hangul Palette 32767.9.99")):
    expected=(value,revision,name)
    assert font_version({"fontVersion":value})==official_version({"fontVersion":value})==expected
for value in (None,False,1,[],"01.0.0","1.10.0","1.0.100","32768.0.0","1.0.0-beta"):
    for parser,error_class in ((font_version,ExportError),(official_version,OfficialFontError)):
        try:parser({"fontVersion":value})
        except error_class as error:assert error.code=="invalid_contract"
        else:raise AssertionError("Invalid version was accepted: "+str(value))
`;
  const result = Bun.spawnSync([python, "-c", script, join(root, "src/font/compiler")], { cwd: root });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

test.skipIf(!hasRuntime)(
  "font CLIs read Hangul snapshots and emit UTF-8 errors in an ASCII locale",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "studio-compiler-utf8-"));
    try {
      const input = join(directory, "snapshot.json");
      const previous = join(directory, "previous.zip");
      const source = JSON.stringify({ classificationFormat: "unsupported", 한글: "가값과밖" });
      await writeFile(input, source);
      await writeFile(previous, new Uint8Array());
      for (const tool of ["export.py", "repackage.py"]) {
        const child = Bun.spawn(
          [
            python,
            "-X",
            "utf8=0",
            join(root, "src/font/compiler", tool),
            "--input",
            input,
            "--output",
            join(directory, "font.zip"),
            ...(tool === "repackage.py" ? ["--reuse", previous] : []),
          ],
          {
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              LC_ALL: "C",
              PYTHONCOERCECLOCALE: "0",
              PYTHONIOENCODING: "ascii",
            },
          },
        );
        const [stderr, stdout, exitCode] = await Promise.all([
          new Response(child.stderr).text(),
          new Response(child.stdout).text(),
          child.exited,
        ]);
        expect(exitCode).toBe(1);
        expect(JSON.parse(stderr).error).toEqual({
          code: "unsupported_classification_format",
          message: "semantic-regions-v1 형식의 직접 세부 영역 분류가 필요합니다.",
          diagnostics: [],
        });
        expect(stdout).toBe(tool === "repackage.py" ? '{"stage": "packaging"}\n' : "");
      }
      expect(await readFile(input, "utf8")).toBe(source);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
