import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const python = join(
  root,
  ".cache/font-export-venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const supported = existsSync(python) && process.platform !== "win32";

// Fork keeps this lifecycle fixture independent of font data while exercising
// the production executor, structured errors and signal handlers unchanged.
const fixture = `
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor
import json,multiprocessing,os,signal,subprocess,sys,time
sys.path.insert(0,sys.argv[1])
import export as compiler

MODE=sys.argv[2]
TRACE=Path(sys.argv[3])
WEIGHTS=("thin","light","regular")
compiler.ProcessPoolExecutor=lambda **kwargs:ProcessPoolExecutor(mp_context=multiprocessing.get_context("fork"),**{**kwargs,"max_workers":3})

def fake_compile(weight,raw,*unused):
    (TRACE/(weight+".pid")).write_text(str(os.getpid()))
    if raw["mode"] in ("crash","structured") and weight=="thin":
        deadline=time.monotonic()+5
        while not all((TRACE/(name+".pid")).exists() for name in WEIGHTS):
            if time.monotonic()>deadline:raise RuntimeError("Sibling workers did not start")
            time.sleep(.01)
        if raw["mode"]=="crash":os._exit(91)
        return {"error":{"code":"semantic_classification","message":"fixture semantic failure",
                         "diagnostics":[{"char":"휺","weight":weight,"code":"fixture_semantic"}]}}
    if raw["mode"] in ("crash","structured","block"):time.sleep(30)
    time.sleep({"thin":.12,"light":.06,"regular":0}[weight])
    return {"font":weight.encode(),"record":{"id":weight},"validation":{"passed":True}}
compiler.compile_weight=fake_compile

def alive(pid):
    try:os.kill(pid,0)
    except ProcessLookupError:return False
    return True

def observed_workers():
    return [int(path.read_text()) for path in TRACE.glob("*.pid")]

def run_jobs(mode):
    jobs=[(weight,{"mode":mode},None,None,None,b"") for weight in WEIGHTS]
    started=time.monotonic()
    try:
        completed=compiler.compile_weights(jobs)
        ordered=[completed[weight]["record"]["id"] for weight in WEIGHTS]
        result={"kind":"success","order":ordered,
                "fonts":[completed[weight]["font"].decode() for weight in WEIGHTS]}
    except compiler.ExportError as error:
        result={"kind":"error","code":error.code,"message":str(error),"diagnostics":error.diagnostics}
    result.update(seconds=time.monotonic()-started,workersStarted=len(observed_workers()),
                  activeChildren=[child.pid for child in multiprocessing.active_children()],
                  liveWorkers=[pid for pid in observed_workers() if alive(pid)])
    return result

def signal_probe():
    child=subprocess.Popen([sys.executable,__file__,sys.argv[1],"block",str(TRACE)],
                           stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    started=time.monotonic()
    try:
        deadline=time.monotonic()+5
        while len(observed_workers())!=3:
            if child.poll() is not None:raise RuntimeError("Compiler exited before workers started")
            if time.monotonic()>deadline:raise RuntimeError("Signal fixture workers did not start")
            time.sleep(.01)
        child.send_signal(signal.SIGTERM)
        stdout,stderr=child.communicate(timeout=5)
        return {"exitCode":child.returncode,"stdout":stdout,"stderr":stderr,
                "workersStarted":len(observed_workers()),"seconds":time.monotonic()-started,
                "liveWorkers":[pid for pid in observed_workers() if alive(pid)]}
    finally:
        if child.poll() is None:
            child.terminate()
            try:child.wait(timeout=3)
            except subprocess.TimeoutExpired:child.kill();child.wait()

if __name__=="__main__":
    signal.signal(signal.SIGTERM,compiler.stop_compilation)
    signal.signal(signal.SIGINT,compiler.stop_compilation)
    if MODE=="signal":print(json.dumps(signal_probe()),flush=True)
    else:print(json.dumps(run_jobs(MODE)),flush=True)
`;

interface WorkerProbe {
  kind?: string;
  code?: string;
  message?: string;
  diagnostics?: unknown[];
  activeChildren?: number[];
  workersStarted: number;
  liveWorkers: number[];
  seconds: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  order?: string[];
  fonts?: string[];
}

async function probe(mode: string): Promise<WorkerProbe> {
  const directory = await mkdtemp(join(tmpdir(), "studio-compiler-workers-"));
  try {
    const script = join(directory, "probe.py");
    await writeFile(script, fixture);
    const child = Bun.spawn([python, script, join(root, "src/font/compiler"), mode, directory], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
      killSignal: "SIGTERM",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function expectStopped(result: WorkerProbe): void {
  expect(result.workersStarted).toBe(3);
  expect(result.liveWorkers).toEqual([]);
  expect(result.seconds).toBeLessThan(5);
}

test.skipIf(!supported)(
  "native worker exit fails promptly and stops sibling compilers",
  async () => {
    const result = await probe("crash");
    expect(result.kind).toBe("error");
    expect(result.code).toBe("compiler_worker_failed");
    expect(result.activeChildren).toEqual([]);
    expectStopped(result);
  },
  20_000,
);

test.skipIf(!supported)(
  "structured worker failure preserves diagnostics and stops siblings",
  async () => {
    const result = await probe("structured");
    expect(result).toMatchObject({
      kind: "error",
      code: "semantic_classification",
      message: "fixture semantic failure",
      diagnostics: [{ char: "휺", weight: "thin", code: "fixture_semantic" }],
    });
    expect(result.activeChildren).toEqual([]);
    expectStopped(result);
  },
  20_000,
);

test.skipIf(!supported)(
  "successful parallel workers retain each result for canonical weight ordering",
  async () => {
    const result = await probe("success");
    expect(result).toMatchObject({
      kind: "success",
      order: ["thin", "light", "regular"],
      fonts: ["thin", "light", "regular"],
    });
    expect(result.activeChildren).toEqual([]);
    expectStopped(result);
  },
  20_000,
);

test.skipIf(!supported)(
  "SIGTERM exits with its signal status and leaves no compiler workers",
  async () => {
    const result = await probe("signal");
    expect(result).toMatchObject({ exitCode: 143, stdout: "", stderr: "" });
    expectStopped(result);
  },
  20_000,
);
