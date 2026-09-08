// Temporary probe for the linux-aarch64 CI hang of linker-order.test.ts's
// "function tracer > records exact entries, and keeps them across an exec'd
// child" (90 s timeout in the parallel batch, builds 110996, 111195, 111496,
// 111536). It runs the same traced fixture many times under load, and the real
// test file inside a small `bun test --parallel` batch, and prints where a run
// that stops making progress is stuck. It asserts only that no run hung.
import { describe, expect, test } from "bun:test";
import { bunEnv, isLinux, isMusl, tempDir } from "harness";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTextSymbols } from "../../../../scripts/orderfile/generate.ts";
import {
  closeAuditSource,
  probeTracerSource,
  run,
  runGeneratedRounds,
  runHungBatchRounds,
} from "./functrace-probe-helpers.ts";

const orderfile = join(import.meta.dir, "../../../../scripts/orderfile");
const compiler = process.env.CC || Bun.which("cc") || Bun.which("clang") || Bun.which("gcc");
const canProbe = isLinux && !isMusl && !!compiler;
const STARTS_MAGIC = 0x4e55425354525453n;

async function compile(args: string[]) {
  await using proc = Bun.spawn({ cmd: [compiler!, "-O1", ...args], env: bunEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`${compiler} ${args.join(" ")} exited ${exitCode}:\n${stdout}${stderr}`);
}

async function writeStarts(path: string, addresses: Iterable<number>) {
  const list = [...addresses].map(BigInt);
  const words = new BigUint64Array(3 + list.length);
  words.set([STARTS_MAGIC, 1n, BigInt(list.length)], 0);
  words.set(list, 3);
  await Bun.write(path, new Uint8Array(words.buffer));
}

describe.skipIf(!canProbe)("function tracer hang probe", () => {
  let root: string;
  let tracer: string, fixture: string, child: string, starts: string;
  let dirHandle: ReturnType<typeof tempDir>;

  test("environment", async () => {
    dirHandle = tempDir("functrace-probe", {
      "child.c": "int main(void) { return 0; }\n",
      "functrace-probe.c": probeTracerSource(readFileSync(join(orderfile, "functrace.c"), "utf8")),
      "closeaudit.c": closeAuditSource,
      "ctr.c": [
        "#include <stdio.h>",
        "#include <unistd.h>",
        "int main(void) {",
        "#if defined(__aarch64__)",
        '  unsigned long ctr, dczid; __asm__ volatile("mrs %0, ctr_el0" : "=r"(ctr)); __asm__ volatile("mrs %0, dczid_el0" : "=r"(dczid));',
        '  printf("CTR_EL0=%#lx IminLine=%u DminLine=%u IDC=%lu DIC=%lu DCZID_EL0=%#lx\\n", ctr, 4u << (ctr & 15), 4u << ((ctr >> 16) & 15), (ctr >> 28) & 1, (ctr >> 29) & 1, dczid);',
        "#endif",
        '  printf("pagesize=%ld nproc_onln=%ld\\n", sysconf(_SC_PAGESIZE), sysconf(_SC_NPROCESSORS_ONLN));',
        "  return 0;",
        "}",
        "",
      ].join("\n"),
    });
    root = String(dirHandle);
    tracer = join(root, "functrace.so");
    fixture = join(root, "fixture");
    child = join(root, "child");
    starts = join(root, "starts.bin");
    const t0 = performance.now();
    await Promise.all([
      compile(["-shared", "-fPIC", "-o", tracer, join(root, "functrace-probe.c"), "-ldl", "-lpthread"]),
      compile(["-o", fixture, join(import.meta.dir, "functrace-fixture.c")]),
      compile(["-o", child, join(root, "child.c")]),
      compile(["-o", join(root, "ctr"), join(root, "ctr.c")]),
      compile(["-shared", "-fPIC", "-o", join(root, "closeaudit.so"), join(root, "closeaudit.c"), "-ldl"]),
    ]);
    console.log(`compiles: ${(performance.now() - t0).toFixed(0)} ms with ${compiler}`);
    const symbols = readTextSymbols(fixture);
    await writeStarts(starts, symbols.keys());

    const facts = [
      ["uname", ["uname", "-a"]],
      [
        "cpu",
        [
          "sh",
          "-c",
          "grep -m1 -i 'model name\\|CPU part' /proc/cpuinfo; grep -c ^processor /proc/cpuinfo; cat /sys/devices/system/cpu/cpu0/regs/identification/midr_el1 2>/dev/null",
        ],
      ],
      ["ctr", [join(root, "ctr")]],
      [
        "limits",
        [
          "sh",
          "-c",
          "ulimit -c; ulimit -Hc; ulimit -s; cat /proc/sys/kernel/core_pattern; cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null; cat /sys/kernel/mm/transparent_hugepage/shmem_enabled 2>/dev/null; cat /proc/sys/vm/overcommit_memory",
        ],
      ],
      ["mem", ["sh", "-c", "free -m | head -3; cat /proc/pressure/cpu /proc/pressure/memory 2>/dev/null"]],
      [
        "cc",
        [
          "sh",
          "-c",
          `${compiler} --version | head -1; ld --version | head -1; (llvm-nm --version || nm --version) 2>/dev/null | head -2; ldd --version | head -1; gdb --version 2>/dev/null | head -1`,
        ],
      ],
      [
        "segments",
        [
          "sh",
          "-c",
          `readelf -lW ${fixture} | grep -A1 'LOAD\\|GNU_' ; readelf -SW ${fixture} | grep -E ' \\.(init|plt|text|fini|rodata|eh_frame|note[^ ]*) '`,
        ],
      ],
      ["symbols", ["sh", "-c", `(llvm-nm ${fixture} || nm ${fixture}) | grep -E '^[0-9a-f]+ [tT] '`]],
      [
        "disasm",
        [
          "sh",
          "-c",
          `objdump -d ${fixture} --start-address=0x$( (llvm-nm ${fixture} || nm ${fixture}) | awk '$3=="f0"{print $1}') --stop-address=0x$( (llvm-nm ${fixture} || nm ${fixture}) | awk '$3=="main"{print $1}') | head -120`,
        ],
      ],
      [
        "tracer syms",
        [
          "sh",
          "-c",
          `(llvm-nm ${tracer} || nm ${tracer}) | grep -E 'aarch64_|clear_cache|sync_cache|have_lse' | head -20`,
        ],
      ],
    ] as const;
    for (const [label, cmd] of facts) console.log(`--- ${label}\n${await run([...cmd])}`);
    expect(symbols.size).toBeGreaterThan(33);
  });

  /**
   * The CI hang happens in a `--parallel` worker that already ran other files:
   * the tracer case's spawnSync (llvm-nm) did not return until the test deadline,
   * once in ~2400 in-worker runs. Run that shape for the rest of this file's
   * budget; linker-order-probe-gen-*.test.ts run more of the same.
   */
  test.skipIf(!isLinux)(
    "the tracer case inside parallel workers, many times",
    async () => {
      const { stalls, staleReports } = await runGeneratedRounds({
        label: "gen0",
        budgetMs: process.arch === "arm64" ? 75_000 : 25_000,
        auditSo: join(root, "closeaudit.so"),
      });
      expect({ stalls, staleReports }).toEqual({ stalls: 0, staleReports: 0 });
    },
    1_800_000,
  );

  // The faithful reproduction: the hung shard's batch, as the runner runs it.
  // linker-order-probe-batch-*.test.ts run more rounds of the same, each inside
  // its own per-file budget.
  test("linker-order.test.ts inside the parallel batch that hung", async () => {
    const { rounds, bad } = await runHungBatchRounds("probe", process.arch === "arm64" ? 60_000 : 30_000);
    for (const out of bad) console.error(`=== stalled batch output (filtered)\n${out}`);
    console.log(`batches: ${rounds} rounds, ${bad.length} with a tracer stall`);
    expect(bad.length).toBe(0);
  }, 1_800_000);

  test("cleanup", () => {
    dirHandle?.[Symbol.dispose]?.();
  });
});
