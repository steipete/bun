// Temporary diagnostics for the linux-aarch64 hang of the function tracer test
// (linker-order.test.ts "records exact entries, and keeps them across an exec'd
// child"). Everything here prints facts about a process tree that stopped
// making progress; nothing here changes what the test asserts.
import { existsSync, readdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readMaybe(path: string, max = 4096): string {
  try {
    return readFileSync(path, "utf8").slice(0, max).trimEnd();
  } catch (error) {
    return `<${(error as NodeJS.ErrnoException).code ?? error}>`;
  }
}

export function childrenOf(pid: number): number[] {
  const out: number[] = [];
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      const kids = readMaybe(`/proc/${pid}/task/${tid}/children`);
      for (const k of kids.split(/\s+/)) if (/^\d+$/.test(k)) out.push(Number(k));
    }
  } catch {}
  return out;
}

function fdsOf(pid: number | "self"): string {
  try {
    return readdirSync(`/proc/${pid}/fd`)
      .map(fd => {
        let target = "?";
        try {
          target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {}
        return `${fd}->${target}`;
      })
      .join(" ");
  } catch (error) {
    return `<${(error as NodeJS.ErrnoException).code ?? error}>`;
  }
}

/** One process: scheduler state, cpu time, signal masks, where it sleeps, its fds. */
export function describeProc(pid: number): string {
  const stat = readMaybe(`/proc/${pid}/stat`);
  // Fields after the ")" that closes comm: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ...
  const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const summary =
    after.length > 12
      ? `state=${after[0]} ppid=${after[1]} pgrp=${after[2]} utime=${after[11]} stime=${after[12]} minflt=${after[7]} majflt=${after[9]}`
      : stat;
  const status = readMaybe(`/proc/${pid}/status`, 65536)
    .split("\n")
    .filter(line =>
      /^(Name|State|Tgid|PPid|Threads|SigQ|SigPnd|ShdPnd|SigBlk|SigIgn|SigCgt|VmRSS|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):/.test(
        line,
      ),
    )
    .map(line => line.replace(/\s+/g, " "))
    .join("; ");
  return [
    `pid ${pid}: ${summary}`,
    `  cmdline: ${readMaybe(`/proc/${pid}/cmdline`).replace(/\0/g, " ")}`,
    `  status: ${status}`,
    `  wchan: ${readMaybe(`/proc/${pid}/wchan`)} | syscall: ${readMaybe(`/proc/${pid}/syscall`)}`,
    `  stack: ${readMaybe(`/proc/${pid}/stack`).replace(/\n/g, " <- ")}`,
    `  fds: ${fdsOf(pid)}`,
  ].join("\n");
}

/** The process and everything below it. */
export function describeTree(pid: number, depth = 0): string {
  const lines = [describeProc(pid).replace(/^/gm, "  ".repeat(depth))];
  for (const kid of childrenOf(pid)) lines.push(describeTree(kid, depth + 1));
  return lines.join("\n");
}

export function describeSelf(): string {
  return `self pid ${process.pid} fds: ${fdsOf("self")}`;
}

export async function run(cmd: string[]): Promise<string> {
  try {
    await using proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return (stdout + stderr).trimEnd();
  } catch (error) {
    return `<${error}>`;
  }
}

/**
 * An LD_PRELOAD library for the bun worker processes: reports every close()
 * or syscall(SYS_close) that fails with EBADF, i.e. a second close of an fd
 * number. When the number was reused in between, the same bug closes someone
 * else's fd instead, which is what a pipe reader that never sees EOF would
 * look like. Frames inside the executable are printed as exe+0xoffset so
 * they can be symbolized against the same binary.
 */
export const closeAuditSource = String.raw`
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <execinfo.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static int log_fd = -1;
static unsigned long n_close = 0, n_ebadf = 0;
static char exe[512];
static unsigned long exe_lo = 0, exe_hi = 0;
static long (*real_syscall)(long, ...);
static int (*real_close)(int);

static void emit(const char *fmt, ...)
{
    if (log_fd < 0) return;
    char buf[4096];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    if (n > (int)sizeof buf - 1) n = sizeof buf - 1;
    if (n > 0) (void)!real_syscall(SYS_write, (long)log_fd, buf, (long)n, 0L, 0L, 0L);
}

__attribute__((constructor)) static void audit_init(void)
{
    real_syscall = dlsym(RTLD_NEXT, "syscall");
    real_close = dlsym(RTLD_NEXT, "close");
    const char *path = getenv("CLOSEAUDIT_LOG");
    if (!path) return;
    ssize_t k = readlink("/proc/self/exe", exe, sizeof exe - 1);
    if (k > 0) exe[k] = 0;
    /* Only audit bun itself; compilers and fixtures inherit the preload too. */
    const char *base = strrchr(exe, '/');
    if (!base || strncmp(base + 1, "bun", 3) != 0) return;
    int fd = (int)real_syscall(SYS_openat, (long)AT_FDCWD, path, (long)(O_CREAT | O_WRONLY | O_APPEND | O_CLOEXEC), 0644L);
    if (fd < 0) return;
    int hi = (int)real_syscall(SYS_fcntl, (long)fd, (long)F_DUPFD_CLOEXEC, 900L);
    if (hi >= 0) { real_syscall(SYS_close, (long)fd); fd = hi; }
    log_fd = fd;
    FILE *maps = fopen("/proc/self/maps", "re");
    if (maps) {
        char line[1024];
        while (fgets(line, sizeof line, maps)) {
            unsigned long lo, hi2;
            char perms[8], file[768];
            file[0] = 0;
            if (sscanf(line, "%lx-%lx %7s %*s %*s %*s %767[^\n]", &lo, &hi2, perms, file) >= 3 && strcmp(file, exe) == 0) {
                if (!exe_lo || lo < exe_lo) exe_lo = lo;
                if (hi2 > exe_hi) exe_hi = hi2;
            }
        }
        fclose(maps);
    }
}

__attribute__((destructor)) static void audit_fini(void)
{
    if (n_ebadf) emit("closeaudit: SUMMARY pid %d closes=%lu EBADF=%lu exe %s\n", (int)getpid(), n_close, n_ebadf, exe);
}

static void report(const char *via, int fd)
{
    __atomic_fetch_add(&n_ebadf, 1, __ATOMIC_RELAXED);
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    void *frames[40];
    int n = backtrace(frames, 40);
    char trace[2048];
    int len = 0;
    trace[0] = 0;
    for (int i = 1; i < n && len < (int)sizeof trace - 40; i++) {
        unsigned long a = (unsigned long)frames[i];
        if (a >= exe_lo && a < exe_hi) len += snprintf(trace + len, sizeof trace - len, " exe+%#lx", a - exe_lo);
        else len += snprintf(trace + len, sizeof trace - len, " %#lx", a);
    }
    emit("closeaudit: EBADF pid %d tid %ld t=%ld.%06ld %s(%d) base=%#lx frames:%s\n", (int)getpid(), (long)real_syscall(SYS_gettid),
         (long)ts.tv_sec, ts.tv_nsec / 1000, via, fd, exe_lo, trace);
}

int close(int fd)
{
    if (!real_close) real_close = dlsym(RTLD_NEXT, "close");
    if (log_fd >= 0 && fd == log_fd) { report("close-of-audit-log", fd); return 0; }
    int rc = real_close(fd);
    int err = errno;
    __atomic_fetch_add(&n_close, 1, __ATOMIC_RELAXED);
    if (rc != 0 && err == EBADF && log_fd >= 0) report("close", fd);
    errno = err;
    return rc;
}

long syscall(long number, ...)
{
    va_list ap;
    va_start(ap, number);
    long a = va_arg(ap, long), b = va_arg(ap, long), c = va_arg(ap, long), d = va_arg(ap, long), e = va_arg(ap, long), f = va_arg(ap, long);
    va_end(ap);
    if (!real_syscall) real_syscall = dlsym(RTLD_NEXT, "syscall");
    if (number == SYS_close) {
        if (log_fd >= 0 && (int)a == log_fd) { report("sys_close-of-audit-log", (int)a); return 0; }
        long rc = real_syscall(number, a);
        int err = errno;
        __atomic_fetch_add(&n_close, 1, __ATOMIC_RELAXED);
        if (rc != 0 && err == EBADF && log_fd >= 0) report("sys_close", (int)a);
        errno = err;
        return rc;
    }
    if (number == SYS_close_range && log_fd > 2) {
        unsigned lo = (unsigned)a, hi = (unsigned)b;
        if ((unsigned)log_fd >= lo && (unsigned)log_fd <= hi) {
            long rc = 0;
            if ((unsigned)log_fd > lo) rc = real_syscall(number, (long)lo, (long)(log_fd - 1), c);
            if ((unsigned)log_fd < hi) rc = real_syscall(number, (long)(log_fd + 1), (long)hi, c);
            return rc;
        }
    }
    return real_syscall(number, a, b, c, d, e, f);
}
`;

/** EBADF lines from a close-audit log, with exe+0x... frames symbolized against `exe` when a symbolizer is installed. */
export async function readCloseAudit(log: string, exe: string): Promise<string> {
  if (!existsSync(log)) return "";
  const text = readFileSync(log, "utf8");
  if (!text.trim()) return "";
  const offsets = [...new Set([...text.matchAll(/exe\+(0x[0-9a-f]+)/g)].map(m => m[1]))].slice(0, 200);
  let symbols = "";
  const symbolizer =
    Bun.which("llvm-symbolizer") ||
    ["21", "20", "19"].map(v => `/usr/lib/llvm-${v}/bin/llvm-symbolizer`).find(existsSync);
  if (offsets.length && symbolizer) {
    const out = await run([symbolizer, `--obj=${exe}`, "--functions=short", "--demangle", "--inlines", ...offsets]);
    const names = out.split("\n\n");
    symbols = offsets.map((o, i) => `  ${o}: ${(names[i] ?? "?").split("\n").slice(0, 6).join(" | ")}`).join("\n");
  } else if (offsets.length && Bun.which("addr2line")) {
    symbols = await run(["addr2line", "-f", "-C", "-i", "-e", exe, ...offsets]);
  }
  return `${text.trimEnd()}\n--- symbolized against ${exe}\n${symbols}`;
}

/**
 * The parallel batch of the shard that hung (build 111536, debian 13 aarch64),
 * file for file, minus the two napi files whose prebuilds the runner makes.
 */
export const HUNG_BATCH = `
test/bundler/bundler_browser.test.ts
test/bundler/bundler_loader.test.ts
test/bundler/css/wpt/color-computed.test.ts
test/bundler/resolver/cache-node-compat.test.ts
test/cli/heap-prof.test.ts
test/cli/install/migration/pnpm-migration-complete.test.ts
test/cli/run/crash-report-command-char.test.ts
test/cli/run/scoped-debug-log.test.ts
test/cli/run/self-reference.test.ts
test/internal/fifo.test.ts
test/internal/rust-windows-sys-link.test.ts
test/js/bun/glob/match.test.ts
test/js/bun/http/bun-serve-html-manifest.test.ts
test/js/bun/http/bun-serve-html.test.ts
test/js/bun/http/bun-serve-ssl.test.ts
test/js/bun/http/form-data-set-append.test.js
test/js/bun/perf/linker-order.test.ts
test/js/bun/resolve/esModule.test.ts
test/js/bun/resolve/require-esm-evaluating-cycle.test.ts
test/js/bun/shell/env.positionals.test.ts
test/js/bun/shell/pipeline_stack.test.ts
test/js/bun/spawn/spawn.ipc.test.ts
test/js/bun/symbols.test.ts
test/js/bun/test/bun_test.test.ts
test/js/bun/test/fake-timers/sinonjs/fake-timers.test.ts
test/js/bun/test/fake-timers/sinonjs/issue-276.test.ts
test/js/bun/test/mock-disposable.test.ts
test/js/bun/test/mock/6874/B.test.ts
test/js/bun/test/test-failing.test.ts
test/js/bun/util/filesink.test.ts
test/js/bun/util/fuzzy-wuzzy.test.ts
test/js/bun/util/pathToFileURL-invalid.test.ts
test/js/bun/webview/webview-chrome-disconnect.test.ts
test/js/bun/webview/webview.test.ts
test/js/node/async_hooks/async-local-storage-thenable.test.ts
test/js/node/crypto/sign-jwk-ieee-p1363.test.ts
test/js/node/http/node-http-req-socket-pause.test.ts
test/js/node/http/node-http.compress.leak.test.ts
test/js/node/stream/node-stream-uint8array.test.ts
test/js/node/tls/node-tls-duplex-close-throw-uaf.test.ts
test/js/node/url/url-parse-invalid-input.test.js
test/js/node/zlib/zlib-estimated-size-gc.test.ts
test/js/sql/sql-helpers-validation.test.ts
test/js/sql/sqlite-sql.test.ts
test/js/third_party/body-parser/express-bun-build-compile.test.ts
test/js/third_party/express/res.json.test.ts
test/js/third_party/grpc-js/test-certificate-provider.test.ts
test/js/third_party/grpc-js/test-local-subchannel-pool.test.ts
test/js/third_party/grpc-js/test-metadata.test.ts
test/js/third_party/http2-wrapper/http2-wrapper.test.ts
test/js/third_party/remix/remix.test.ts
test/js/third_party/rollup-v4/rollup-v4.test.ts
test/js/third_party/wpt-h2/run.test.ts
test/js/web/fetch/headers-case.test.ts
test/js/web/streams/readable-stream-blob-consumed.test.ts
test/js/web/streams/transform-stream-leak.test.ts
test/js/web/websocket/websocket-pause.test.ts
test/js/web/workers/worker-postmessage-transfer.test.ts
test/regression/issue/03091.test.ts
test/regression/issue/05828.test.ts
test/regression/issue/06946/06946.test.ts
test/regression/issue/09555.test.ts
test/regression/issue/17244.test.ts
test/regression/issue/17405.test.ts
test/regression/issue/22243.test.ts
test/regression/issue/23139.test.ts
test/regression/issue/24234.test.ts
test/regression/issue/25622.test.ts
test/regression/issue/25628.test.ts
test/regression/issue/25716.test.ts
test/regression/issue/26377.test.ts
test/regression/issue/28159.test.ts
test/regression/issue/2993.test.ts
test/regression/issue/32728.test.ts
test/regression/issue/css-system-color-mix-crash.test.ts
test/regression/issue/issue-1825-jest-mock-functions.test.ts
`
  .trim()
  .split("\n");

/**
 * Runs that batch the way the CI runner does (`--parallel=3`, junit reporter,
 * dots) until `budgetMs` is spent, and returns how many rounds ran and the
 * output of any round in which linker-order.test.ts's watchdog fired.
 */
export async function runHungBatchRounds(label: string, budgetMs: number): Promise<{ rounds: number; bad: string[] }> {
  const { bunEnv, bunExe } = await import("harness");
  const repo = join(import.meta.dir, "../../../..");
  const junit = join(repo, `probe-junit-${label}-${process.pid}.xml`);
  const t0 = performance.now();
  const bad: string[] = [];
  let rounds = 0;
  let last = 0;
  while (performance.now() - t0 + Math.max(last, 12_000) < budgetMs && bad.length < 2) {
    const started = performance.now();
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "test",
        "--parallel=3",
        "--timeout=90000",
        "--dots",
        "--reporter=junit",
        `--reporter-outfile=${junit}`,
        ...HUNG_BATCH,
      ],
      cwd: repo,
      env: { ...bunEnv, BUN_FUNCTRACE_PROBE: "1" },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    last = performance.now() - started;
    rounds++;
    const out = stdout + stderr;
    const summary = /Ran \d+ tests across \d+ files\. \[[^\]]+\]/.exec(out)?.[0] ?? `exit ${proc.exitCode}`;
    const steps = out.split("\n").find(line => line.includes("functrace steps:")) ?? "<no steps line>";
    console.log(`${label} round ${rounds}: ${summary} ${steps.trim()}`);
    if (
      /functrace watchdog|STALLED|REPEAT trap|keeps them across an exec'd child/.test(
        out.replace(/functrace steps:.*$/gm, ""),
      )
    ) {
      bad.push(
        out
          .split("\n")
          .filter(line => !/^[.\s]*$/.test(line))
          .slice(-600)
          .join("\n"),
      );
    }
  }
  try {
    (await import("node:fs")).rmSync(junit, { force: true });
  } catch {}
  return { rounds, bad };
}

/**
 * Markers: a worker writes `<dir>/<kind>-<pid>-<tag>` before a step that may
 * stall and removes it after. The probe process (never blocked itself) polls
 * the directory and dumps the kernel-side state of a worker whose marker got
 * old: every thread's state/wchan/syscall, its fds with each epoll's interest
 * list, its children, and its unix sockets' queues.
 */
export function markStep(kind: "sync" | "async", tag: string): () => void {
  const dir = process.env.PROBE_MARK_DIR;
  if (!dir) return () => {};
  const file = join(dir, `${kind}-${process.pid}-${tag.replace(/[^A-Za-z0-9_.-]/g, "_")}`);
  try {
    writeFileSync(file, String(Date.now()));
  } catch {}
  return () => {
    try {
      unlinkSync(file);
    } catch {}
  };
}

function describeWorker(pid: number): string {
  const lines: string[] = [];
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      const base = `/proc/${pid}/task/${tid}`;
      const stat = readMaybe(`${base}/stat`);
      const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      lines.push(
        `  tid ${tid} (${name}) state=${after[0]} utime=${after[11]} stime=${after[12]} wchan=${readMaybe(`${base}/wchan`)} syscall=${readMaybe(`${base}/syscall`).split(" ").slice(0, 5).join(" ")}`,
      );
    }
  } catch (error) {
    lines.push(`  <threads: ${error}>`);
  }
  const fdLines: string[] = [];
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`).sort((a, b) => Number(a) - Number(b))) {
      let target = "?";
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {}
      let extra = "";
      if (target === "anon_inode:[eventpoll]") {
        const tfds = readMaybe(`/proc/${pid}/fdinfo/${fd}`, 65536)
          .split("\n")
          .filter(l => l.startsWith("tfd:"))
          .map(l =>
            l
              .replace(/\s+/g, " ")
              .replace(/ pos:0 ino:\S+ sdev:\S+/, "")
              .trim(),
          );
        extra = ` {${tfds.join("; ")}}`;
      } else if (/^(socket|pipe|anon_inode)/.test(target)) {
        extra = ` (${readMaybe(`/proc/${pid}/fdinfo/${fd}`, 400)
          .split("\n")
          .filter(l => /^flags/.test(l))
          .join("")
          .replace(/\s+/g, "")})`;
      }
      fdLines.push(`${fd}->${target}${extra}`);
    }
  } catch (error) {
    fdLines.push(`<fds: ${error}>`);
  }
  lines.push(`  fds: ${fdLines.join("  ")}`);
  const kids = childrenOf(pid);
  lines.push(`  children: ${kids.length ? kids.map(k => describeProc(k).split("\n")[0]).join(" | ") : "none"}`);
  return lines.join("\n");
}

/** Polls `dir` for stale markers and prints one report per stale marker. The returned function stops and reports the count. */
export function watchMarkers(dir: string, thresholds: { sync: number; async: number }): () => number {
  const reported = new Set<string>();
  let reports = 0;
  const timer = setInterval(async () => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      if (reported.has(name) || reports >= 6) continue;
      const m = /^(sync|async)-(\d+)-(.*)$/.exec(name);
      if (!m) continue;
      const started = Number(readMaybe(join(dir, name)));
      if (!started || now - started < thresholds[m[1] as "sync" | "async"]) continue;
      reported.add(name);
      reports++;
      const pid = Number(m[2]);
      const ss = await run(["sh", "-c", `ss -xapn 2>/dev/null | grep -E 'Recv-Q|pid=${pid},' | head -40`]);
      console.error(
        [
          `=== STALE ${m[1]} step: worker pid ${pid}, ${m[3]}, ${now - started} ms old`,
          describeWorker(pid),
          `  unix sockets:\n${ss}`,
          `=== end STALE report`,
        ].join("\n"),
      );
    }
  }, 250);
  return () => {
    clearInterval(timer);
    return reports;
  };
}

/**
 * Many copies of the tracer+pty case pair inside `bun test --parallel` workers,
 * for `budgetMs`: the setting in which the spawnSync stall reproduced once.
 * Workers may run under the close auditor; the probe process watches markers.
 */
export async function runGeneratedRounds(opts: {
  label: string;
  budgetMs: number;
  auditSo?: string;
}): Promise<{ rounds: number; cases: number; stalls: number; staleReports: number }> {
  const { bunEnv, bunExe, tempDir } = await import("harness");
  const repo = join(import.meta.dir, "../../../..");
  const helpers = join(import.meta.dir, "functrace-probe-helpers.ts");
  const cases = process.arch === "arm64" ? 48 : 12;
  const neighbors = HUNG_BATCH.filter(f =>
    /bundler_loader|webview\/webview\.test|bun-serve-html\.test|fifo|filesink|spawn\.ipc|sqlite-sql|heap-prof|websocket-pause|self-reference|pipeline_stack|bun_test\.test/.test(
      f,
    ),
  );
  using generated = tempDir(`functrace-cases-${opts.label}`, { marks: {} });
  const dir = String(generated);
  const markDir = join(dir, "marks");
  const files: string[] = [];
  for (let i = 0; i < cases; i++) {
    const file = join(dir, `tracer-${String(i).padStart(3, "0")}.test.ts`);
    writeFileSync(
      file,
      [
        `import { describe, it } from "bun:test";`,
        `import { mkdirSync } from "node:fs";`,
        `import { runPtyCase, runTracerCase } from ${JSON.stringify(helpers)};`,
        `const root = ${JSON.stringify(join(dir, `case-${i}`))};`,
        `mkdirSync(root, { recursive: true });`,
        `describe("tracer", () => {`,
        `  it.concurrent(${JSON.stringify(`traced fixture ${i}`)}, async () => {`,
        `    await runTracerCase({ root, diag: ${JSON.stringify(join(dir, "diag.txt"))}, tag: ${JSON.stringify(`case-${i}`)} });`,
        `  }, 65000);`,
        `});`,
        `describe("pty", () => {`,
        `  it.concurrent(${JSON.stringify(`pty runner ${i}`)}, async () => {`,
        `    await runPtyCase({ root, tag: ${JSON.stringify(`case-${i}`)} });`,
        `  }, 65000);`,
        `});`,
        ``,
      ].join("\n"),
    );
    files.push(file);
  }

  const stopWatching = watchMarkers(markDir, { sync: 2500, async: 15_000 });
  let stalls = 0;
  let rounds = 0;
  let last = 0;
  const t0 = performance.now();
  while (performance.now() - t0 + Math.max(last, 12_000) < opts.budgetMs && stalls < 2) {
    const started = performance.now();
    const auditLog = join(dir, `closeaudit.${rounds}.log`);
    const env: Record<string, string | undefined> = { ...bunEnv, PROBE_MARK_DIR: markDir };
    if (opts.auditSo) {
      env.LD_PRELOAD = opts.auditSo;
      env.CLOSEAUDIT_LOG = auditLog;
    }
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--parallel=3", "--timeout=70000", "--dots", ...files, ...neighbors],
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    last = performance.now() - started;
    const out = stdout + stderr;
    const summary = /Ran \d+ tests across \d+ files\. \[[^\]]+\]/.exec(out)?.[0] ?? `exit ${proc.exitCode}`;
    const bad = /STALLED|timed out|REPEAT trap/.test(out);
    const audit = opts.auditSo ? await readCloseAudit(auditLog, bunExe()) : "";
    const ebadf = audit ? audit.split("\n").filter(l => l.includes("EBADF pid")).length : 0;
    console.log(`${opts.label} round ${rounds}: ${cases} cases, ${summary}, ${ebadf} EBADF closes${bad ? " BAD" : ""}`);
    if (audit) console.log(audit.split("\n").slice(0, 80).join("\n"));
    if (bad) {
      stalls++;
      console.error(
        `=== ${opts.label} round ${rounds} output (filtered)\n${out
          .split("\n")
          .filter(line => !/^[.\s]*$/.test(line))
          .slice(-400)
          .join("\n")}`,
      );
    }
    rounds++;
  }
  const staleReports = stopWatching();
  console.log(
    `${opts.label}: ${rounds} rounds, ${rounds * cases} cases, ${stalls} rounds with a stall, ${staleReports} stale-step reports, ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );
  return { rounds, cases: rounds * cases, stalls, staleReports };
}

/**
 * The body of linker-order.test.ts's pty-runner case. It runs concurrently with
 * the tracer case in the real file: two more compiles, a bun under a pty and a
 * bun on pipes, in the same worker process at the same moment.
 */
export async function runPtyCase(opts: { root: string; tag: string; watchdogMs?: number }): Promise<void> {
  const { bunEnv: inherited, bunExe } = await import("harness");
  // The worker may run under the close auditor (LD_PRELOAD); its children must not.
  const { LD_PRELOAD: _preload, CLOSEAUDIT_LOG: _log, ...bunEnv } = inherited as Record<string, string>;
  const orderfile = join(import.meta.dir, "../../../../scripts/orderfile");
  const compiler = process.env.CC || Bun.which("cc") || Bun.which("clang") || Bun.which("gcc");
  const { root, tag } = opts;
  const watchdogMs = opts.watchdogMs ?? 40_000;
  const ptyrun = join(root, "ptyrun");
  const preload = join(root, "empty.so");
  const steps: string[] = [];
  const t0 = performance.now();
  const step = (name: string) => steps.push(`${name}@${(performance.now() - t0).toFixed(0)}ms`);

  writeFileSync(join(root, "empty.c"), "int ptyrun_nothing;\n");
  const probe = [
    `process.stdin.once("data", data => {`,
    `  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);`,
    `  const fields = [tty, process.stdout.columns ?? 0, process.env.LD_PRELOAD ?? "none", data.toString().trim()];`,
    `  process.stdout.write(fields.join(" ") + "\\n");`,
    `  process.stdin.pause();`,
    `});`,
  ].join("\n");

  async function compile(args: string[]) {
    await using proc = Bun.spawn({ cmd: [compiler!, "-O1", ...args], env: bunEnv, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    if (exitCode !== 0) throw new Error(`${compiler} ${args.join(" ")} exited ${exitCode}:\n${stdout}${stderr}`);
  }

  const live: Bun.Subprocess[] = [];
  const watchdog = setTimeout(async () => {
    const lines = [`=== pty ${tag} STALLED after ${watchdogMs} ms: steps ${steps.join(" ")}`, describeSelf()];
    for (const proc of live) lines.push(describeTree(proc.pid));
    lines.push(
      `--- ps\n${await run(["sh", "-c", "ps -eo pid,ppid,pgid,stat,wchan:32,etime,time,args --forest | grep -v 'ps -eo' | head -80"])}`,
    );
    console.error(lines.join("\n"));
    for (const proc of live) proc.kill("SIGKILL");
  }, watchdogMs);

  async function type(cmd: string[], env: Record<string, string>) {
    const proc = Bun.spawn({
      cmd,
      env: { ...bunEnv, ...env },
      stdin: new Blob(["hi\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    live.push(proc);
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const lines = stdout
      .replace(/[\x00-\x1f]+/g, "\n")
      .trim()
      .split("\n");
    return { line: lines.at(-1), stderr, exitCode };
  }

  try {
    await Promise.all([
      compile(["-o", ptyrun, join(orderfile, "ptyrun.c"), "-lutil"]).then(() => step("ptyrun")),
      compile(["-shared", "-fPIC", "-o", preload, join(root, "empty.c")]).then(() => step("empty.so")),
    ]);
    const [pty, pipe] = await Promise.all([
      type([ptyrun, bunExe(), "-e", probe], { PTYRUN_PRELOAD: preload }).then(r => (step("pty"), r)),
      type([bunExe(), "-e", probe], {}).then(r => (step("pipe"), r)),
    ]);
    if (pty.line !== `true 80 ${preload} hi` || pipe.line !== "false 0 none hi") {
      throw new Error(`${tag}: pty=${JSON.stringify(pty)} pipe=${JSON.stringify(pipe)}`);
    }
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * The body of linker-order.test.ts's tracer case, callable from a generated
 * test file so the same work runs inside a `bun test --parallel` worker that
 * has already run other files. On a stall it prints the process tree, the
 * tracer's own state, and which of stdout/stderr/exited settled.
 */
export async function runTracerCase(opts: {
  /** Directory to build in. The caller owns it. */
  root: string;
  /** Appended by every run of a round. */
  diag: string;
  tag: string;
  /** Print the step timings even when the run is fine. */
  verbose?: boolean;
  watchdogMs?: number;
}): Promise<void> {
  const { bunEnv: inherited } = await import("harness");
  const { LD_PRELOAD: _preload, CLOSEAUDIT_LOG: _log, ...bunEnv } = inherited as Record<string, string>;
  const { readTextSymbols } = await import("../../../../scripts/orderfile/generate.ts");
  const orderfile = join(import.meta.dir, "../../../../scripts/orderfile");
  const compiler = process.env.CC || Bun.which("cc") || Bun.which("clang") || Bun.which("gcc");
  const { root, diag, tag } = opts;
  const watchdogMs = opts.watchdogMs ?? 40_000;
  const tracer = join(root, "functrace.so");
  const fixture = join(root, "fixture");
  const child = join(root, "child");
  const starts = join(root, "starts.bin");
  const trace = join(root, "trace.bin");

  writeFileSync(join(root, "child.c"), "int main(void) { return 0; }\n");
  writeFileSync(
    join(root, "functrace-probe.c"),
    probeTracerSource(readFileSync(join(orderfile, "functrace.c"), "utf8")),
  );

  const t0 = performance.now();
  const steps: string[] = [];
  const step = (name: string) => steps.push(`${name}@${(performance.now() - t0).toFixed(0)}ms`);
  const settled = { stdout: false, stderr: false, exited: false };
  let spawned: Bun.Subprocess | undefined;

  async function compile(args: string[]) {
    await using proc = Bun.spawn({ cmd: [compiler!, "-O1", ...args], env: bunEnv, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    if (exitCode !== 0) throw new Error(`${compiler} ${args.join(" ")} exited ${exitCode}:\n${stdout}${stderr}`);
  }

  const watchdog = setTimeout(async () => {
    const lines = [
      `=== functrace ${tag} STALLED after ${watchdogMs} ms: steps ${steps.join(" ")}; fixture pid=${spawned?.pid} settled=${JSON.stringify(settled)} exitCode=${spawned?.exitCode} signal=${spawned?.signalCode}`,
      describeSelf(),
      describeProc(process.pid),
    ];
    if (spawned) {
      lines.push(describeTree(spawned.pid));
      try {
        process.kill(spawned.pid, "SIGUSR1");
      } catch (error) {
        lines.push(`SIGUSR1: ${error}`);
      }
      await Bun.sleep(500);
    }
    lines.push(
      `--- ps\n${await run(["sh", "-c", "ps -eo pid,ppid,pgid,stat,wchan:32,etime,time,args --forest | grep -v 'ps -eo' | head -80"])}`,
    );
    lines.push(`--- tracer diag\n${existsSync(diag) ? readFileSync(diag, "utf8").slice(-60_000) : "<none>"}`);
    console.error(lines.join("\n"));
    if (spawned) {
      for (const pid of [...childrenOf(spawned.pid), spawned.pid]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  }, watchdogMs);

  try {
    const unmarkCompile = markStep("async", `${tag}-compile`);
    await Promise.all([
      compile(["-shared", "-fPIC", "-o", tracer, join(root, "functrace-probe.c"), "-ldl", "-lpthread"]).then(() =>
        step("tracer"),
      ),
      compile(["-o", fixture, join(import.meta.dir, "functrace-fixture.c")]).then(() => step("fixture")),
      compile(["-o", child, join(root, "child.c")]).then(() => step("child")),
    ]);
    unmarkCompile();
    const unmarkNm = markStep("sync", `${tag}-nm`);
    const symbols = readTextSymbols(fixture);
    unmarkNm();
    step("nm");
    if (symbols.size <= 33) throw new Error(`nm listed ${symbols.size} text symbols`);
    const list = [...symbols.keys()].map(BigInt);
    const words = new BigUint64Array(3 + list.length);
    words.set([0x4e55425354525453n, 1n, BigInt(list.length)], 0);
    words.set(list, 3);
    await Bun.write(starts, new Uint8Array(words.buffer));
    step("starts");

    await using proc = Bun.spawn({
      cmd: [fixture, child],
      env: {
        ...bunEnv,
        LD_PRELOAD: tracer,
        BUN_FUNCTRACE_STARTS: starts,
        BUN_FUNCTRACE_OUT: trace,
        BUN_FUNCTRACE_DIAG: diag,
        BUN_FUNCTRACE_DIAG_ALARM: String(Math.floor(watchdogMs / 1000) - 4),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    spawned = proc;
    step(`spawn(${proc.pid})`);
    const unmarkSpawn = markStep("async", `${tag}-fixture-${proc.pid}`);
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout.text().finally(() => ((settled.stdout = true), step("stdout"))),
      proc.stderr.text().finally(() => ((settled.stderr = true), step("stderr"))),
      proc.exited.finally(() => ((settled.exited = true), step("exited"))),
    ]);
    unmarkSpawn();
    if (stdout.trim() !== "497" || stderr !== "" || exitCode !== 0) {
      throw new Error(`${tag}: stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)} exit=${exitCode}`);
    }
    const entries = new BigUint64Array(await Bun.file(trace).arrayBuffer());
    if (entries[0] !== 0x4e55424543415254n || Number(entries[4]) < 34) {
      throw new Error(`${tag}: trace magic ${entries[0]} entries ${entries[4]}`);
    }
    step("done");
    if (opts.verbose) console.error(`functrace steps: ${steps.join(" ")}`);
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * functrace.c plus a watchdog: counts traps, reports a trap that fires again at
 * an address whose breakpoint was already restored (which would spin forever),
 * and on SIGALRM (armed at load) or SIGUSR1 writes the tracer's state and the
 * interrupted context to $BUN_FUNCTRACE_DIAG. The tracer logic is untouched.
 */
export function probeTracerSource(stock: string): string {
  const hook = "static void on_trap(int sig, siginfo_t *si, void *uc)\n{\n    (void)si;";
  if (!stock.includes(hook)) throw new Error("functrace.c changed shape; update the probe hook");
  let patched = stock.replace(
    hook,
    [
      "static volatile unsigned long diag_traps = 0;",
      "static volatile unsigned long diag_repeats = 0;",
      "static volatile uintptr_t diag_last_pc = 0;",
      "static void diag_report_repeat(uintptr_t at, size_t i);",
      "static void on_trap(int sig, siginfo_t *si, void *uc)",
      "{",
      "    (void)si;",
      "    __atomic_fetch_add(&diag_traps, 1, __ATOMIC_RELAXED);",
      "#if defined(__linux__) && defined(__x86_64__)",
      "    diag_last_pc = (uintptr_t)((ucontext_t *)uc)->uc_mcontext.gregs[REG_RIP];",
      "#elif defined(__linux__)",
      "    diag_last_pc = (uintptr_t)((ucontext_t *)uc)->uc_mcontext.pc;",
      "#endif",
    ].join("\n"),
  );

  // A trap at a start whose breakpoint was already restored means the write or
  // the icache maintenance did not take: the handler restores it again and
  // returns to the same address, which traps again. Count it and say so.
  const record = "    if (__atomic_exchange_n(&seen[i], 1, __ATOMIC_RELAXED) == 0) {";
  if (!patched.includes(record)) throw new Error("functrace.c changed shape; update the repeat probe");
  patched = patched.replace(
    record,
    [
      "    if (__atomic_load_n(&seen[i], __ATOMIC_RELAXED) != 0) {",
      "        __atomic_fetch_add(&diag_repeats, 1, __ATOMIC_RELAXED);",
      "        diag_report_repeat(at, i);",
      "    }",
      record,
    ].join("\n"),
  );
  return patched + "\n" + diagTail;
}

const diagTail = String.raw`
// ─── probe diagnostics (test-only) ──────────────────────────────────────────
#include <stdarg.h>
#include <errno.h>
#include <time.h>

static char diag_path[1024];

static void diag_write(int fd, const char *fmt, ...)
{
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    if (n > (int)sizeof buf - 1) n = (int)sizeof buf - 1;
    if (n > 0) (void)!write(fd, buf, (size_t)n);
}

static void diag_copy_file(int fd, const char *path, size_t max)
{
    int in = open(path, O_RDONLY | O_CLOEXEC);
    if (in < 0) { diag_write(fd, "<%s: errno %d>\n", path, errno); return; }
    char buf[4096];
    size_t total = 0;
    ssize_t n;
    while (total < max && (n = read(in, buf, sizeof buf)) > 0) { (void)!write(fd, buf, (size_t)n); total += (size_t)n; }
    close(in);
}

// A breakpoint that fires again after its restore: the 16 first ones say where,
// with the instruction as seen through both mappings.
static void diag_report_repeat(uintptr_t at, size_t i)
{
    if (!diag_path[0] || __atomic_load_n(&diag_repeats, __ATOMIC_RELAXED) > 16) return;
    int fd = open(diag_path, O_CREAT | O_WRONLY | O_APPEND | O_CLOEXEC, 0644);
    if (fd < 0) return;
    int r = region_of(at);
    insn_t rx = *(const insn_t *)at;
    insn_t rw = r >= 0 ? *(const insn_t *)(regions[r].rw + (at - regions[r].start)) : 0;
    diag_write(fd, "REPEAT trap pid %d at %#lx (-slide %#lx) start[%zu] traps=%lu repeats=%lu orig=%#lx rx=%#lx rw=%#lx breakpoint=%#lx\n",
               (int)getpid(), (unsigned long)at, (unsigned long)(at - slide), i, (unsigned long)diag_traps,
               (unsigned long)diag_repeats, originals ? (unsigned long)originals[i] : 0ul, (unsigned long)rx,
               (unsigned long)rw, (unsigned long)BREAKPOINT);
    close(fd);
}

static void diag_dump(int sig, siginfo_t *si, void *uc)
{
    (void)si;
    int fd = open(diag_path, O_CREAT | O_WRONLY | O_APPEND | O_CLOEXEC, 0644);
    if (fd < 0) return;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    ucontext_t *ctx = (ucontext_t *)uc;
#if defined(__linux__) && defined(__x86_64__)
    uintptr_t pc = (uintptr_t)ctx->uc_mcontext.gregs[REG_RIP], sp = (uintptr_t)ctx->uc_mcontext.gregs[REG_RSP], lr = 0;
#elif defined(__linux__)
    uintptr_t pc = (uintptr_t)ctx->uc_mcontext.pc, sp = (uintptr_t)ctx->uc_mcontext.sp, lr = (uintptr_t)ctx->uc_mcontext.regs[30];
#else
    uintptr_t pc = 0, sp = 0, lr = 0;
#endif
    diag_write(fd, "=== diag signal %d pid %d t=%ld.%03ld armed=%d traps=%lu repeats=%lu last_trap_pc=%#lx (-slide %#lx) entries=%lu start_count=%zu regions=%d slide=%#lx\n",
               sig, (int)getpid(), (long)ts.tv_sec, ts.tv_nsec / 1000000, armed, (unsigned long)diag_traps, (unsigned long)diag_repeats,
               (unsigned long)diag_last_pc, (unsigned long)(diag_last_pc ? diag_last_pc - slide : 0),
               record ? (unsigned long)record[4] : 0ul, start_count, region_count, (unsigned long)slide);
    diag_write(fd, "pc=%#lx (-slide %#lx, region %d) sp=%#lx lr=%#lx (-slide %#lx)\n", (unsigned long)pc,
               (unsigned long)(pc - slide), region_of(pc), (unsigned long)sp, (unsigned long)lr, (unsigned long)(lr ? lr - slide : 0));
    if (region_of(pc) >= 0) {
        int r = region_of(pc);
        insn_t rx = *(const insn_t *)(pc & ~(uintptr_t)(sizeof(insn_t) - 1));
        insn_t rw = *(const insn_t *)(regions[r].rw + ((pc & ~(uintptr_t)(sizeof(insn_t) - 1)) - regions[r].start));
        diag_write(fd, "insn at pc: rx=%#lx rw=%#lx breakpoint=%#lx start_index=%zu\n", (unsigned long)rx, (unsigned long)rw,
                   (unsigned long)BREAKPOINT, find_start(pc));
    }
#if defined(__linux__) && defined(__aarch64__)
    for (int i = 0; i < 31; i += 4)
        diag_write(fd, "x%-2d=%#018lx x%-2d=%#018lx x%-2d=%#018lx x%-2d=%#018lx\n", i, (unsigned long)ctx->uc_mcontext.regs[i], i + 1,
                   (unsigned long)(i + 1 < 31 ? ctx->uc_mcontext.regs[i + 1] : 0), i + 2, (unsigned long)(i + 2 < 31 ? ctx->uc_mcontext.regs[i + 2] : 0),
                   i + 3, (unsigned long)(i + 3 < 31 ? ctx->uc_mcontext.regs[i + 3] : 0));
    diag_write(fd, "pstate=%#lx fault_address=%#lx\n", (unsigned long)ctx->uc_mcontext.pstate, (unsigned long)ctx->uc_mcontext.fault_address);
#endif
    for (size_t i = 0; i < start_count; i++) {
        int r = region_of(starts[i]);
        insn_t rx = *(const insn_t *)starts[i];
        insn_t rw = r >= 0 ? *(const insn_t *)(regions[r].rw + (starts[i] - regions[r].start)) : 0;
        diag_write(fd, "start[%zu] %#lx (-slide %#lx) seen=%d orig=%#lx now rx=%#lx rw=%#lx%s\n", i, (unsigned long)starts[i],
                   (unsigned long)(starts[i] - slide), seen ? seen[i] : -1, originals ? (unsigned long)originals[i] : 0ul,
                   (unsigned long)rx, (unsigned long)rw, rx != rw ? " MISMATCH" : "");
    }
    for (int r = 0; r < region_count; r++)
        diag_write(fd, "region[%d] %#lx-%#lx rw=%p\n", r, (unsigned long)regions[r].start, (unsigned long)regions[r].end, (void *)regions[r].rw);
    diag_write(fd, "--- /proc/self/stat\n");
    diag_copy_file(fd, "/proc/self/stat", 4096);
    diag_write(fd, "\n--- /proc/self/status\n");
    diag_copy_file(fd, "/proc/self/status", 8192);
    diag_write(fd, "--- /proc/self/maps\n");
    diag_copy_file(fd, "/proc/self/maps", 65536);
    diag_write(fd, "=== end diag\n");
    close(fd);
}

__attribute__((constructor(102))) static void diag_init(void)
{
    const char *path = getenv("BUN_FUNCTRACE_DIAG");
    if (!path) return;
    snprintf(diag_path, sizeof diag_path, "%s", path);
    unsetenv("BUN_FUNCTRACE_DIAG");
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_sigaction = diag_dump;
    sa.sa_flags = SA_SIGINFO | SA_ONSTACK | SA_RESTART;
    sigemptyset(&sa.sa_mask);
#if defined(__linux__)
    if (!real_sigaction) real_sigaction = (sigaction_fn)dlsym(RTLD_NEXT, "sigaction");
    real_sigaction(SIGUSR1, &sa, NULL);
    real_sigaction(SIGALRM, &sa, NULL);
#else
    sigaction(SIGUSR1, &sa, NULL);
    sigaction(SIGALRM, &sa, NULL);
#endif
    const char *secs = getenv("BUN_FUNCTRACE_DIAG_ALARM");
    alarm(secs ? (unsigned)atoi(secs) : 20);
    // Every run appends to one file in the stress phases, so the per-run line is opt-in.
    if (!getenv("BUN_FUNCTRACE_DIAG_VERBOSE")) return;
    int fd = open(diag_path, O_CREAT | O_WRONLY | O_APPEND | O_CLOEXEC, 0644);
    if (fd >= 0) {
        diag_write(fd, "loaded pid %d armed=%d start_count=%zu regions=%d slide=%#lx\n", (int)getpid(), armed, start_count, region_count, (unsigned long)slide);
        close(fd);
    }
}

__attribute__((destructor)) static void diag_exit(void)
{
    unsigned long repeats = __atomic_load_n(&diag_repeats, __ATOMIC_RELAXED);
    if (!diag_path[0] || (!repeats && !getenv("BUN_FUNCTRACE_DIAG_VERBOSE"))) return;
    int fd = open(diag_path, O_CREAT | O_WRONLY | O_APPEND | O_CLOEXEC, 0644);
    if (fd < 0) return;
    diag_write(fd, "EXIT pid %d traps=%lu repeats=%lu entries=%lu\n", (int)getpid(), (unsigned long)diag_traps, repeats,
               record ? (unsigned long)record[4] : 0ul);
    close(fd);
}
`;
