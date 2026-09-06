// A signal sent to `bun install` while a lifecycle script runs is forwarded
// to the script. `bun install` waits for the script, then dies by the same
// signal. Without this the script keeps running, reparented to init, and
// keeps writing into node_modules.
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isPosix, tempDir } from "harness";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The hook records its pid, then waits. On SIGTERM/SIGINT/SIGHUP it records
// the signal. With `exitOnSignal` it then exits 0, otherwise it keeps
// running so that the test can check the escalation path.
const hook = (exitOnSignal: boolean) => `
  const { writeFileSync } = require("node:fs");
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      writeFileSync("got-signal", sig);
      ${exitOnSignal ? "process.exit(0);" : ""}
    });
  }
  writeFileSync("hook-pid", String(process.pid));
  setInterval(() => {}, 1000);
`;

const files = (exitOnSignal: boolean) => ({
  "package.json": JSON.stringify({
    name: "app",
    version: "1.0.0",
    scripts: { postinstall: `exec ${bunExe()} hook.js` },
  }),
  "hook.js": hook(exitOnSignal),
});

async function waitForFile(path: string): Promise<string> {
  while (!existsSync(path)) {
    await Bun.sleep(10);
  }
  return readFileSync(path, "utf8");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code !== "ESRCH";
  }
}

function killQuietly(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function startInstall(dir: string) {
  return Bun.spawn({
    cmd: [bunExe(), "install"],
    env: bunEnv,
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe.skipIf(!isPosix).concurrent("bun install forwards signals to lifecycle scripts", () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    test(`${signal} reaches the postinstall script and bun install waits for it`, async () => {
      using dir = tempDir("install-signal", files(true));
      await using proc = startInstall(String(dir));
      const hookPid = Number(await waitForFile(join(String(dir), "hook-pid")));
      try {
        expect(isAlive(hookPid)).toBe(true);

        proc.kill(signal);
        await proc.exited;

        // bun install reaps the hook before it dies, so the hook is gone by now.
        // (An orphaned hook also holds the inherited stderr pipe open.)
        expect(isAlive(hookPid)).toBe(false);
        expect(await waitForFile(join(String(dir), "got-signal"))).toBe(signal);
        expect(await proc.stderr.text()).not.toContain("error:");
        expect(proc.signalCode).toBe(signal);
      } finally {
        killQuietly(hookPid);
      }
    });
  }

  test("a second signal kills a script that ignores the first one", async () => {
    using dir = tempDir("install-signal-twice", files(false));
    await using proc = startInstall(String(dir));
    const hookPid = Number(await waitForFile(join(String(dir), "hook-pid")));
    try {
      proc.kill("SIGTERM");
      // bun install must still be alive once the hook has seen the signal.
      const first = await Promise.race([waitForFile(join(String(dir), "got-signal")), proc.exited]);
      expect(first).toBe("SIGTERM");
      expect(isAlive(hookPid)).toBe(true);
      expect(proc.exitCode).toBeNull();

      proc.kill("SIGTERM");
      await proc.exited;
      expect(isAlive(hookPid)).toBe(false);
      expect(proc.signalCode).toBe("SIGTERM");
    } finally {
      killQuietly(hookPid);
    }
  });
});
