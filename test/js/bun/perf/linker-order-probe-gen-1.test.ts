// Temporary probe, part 1: more in-worker rounds of the tracer+pty case pair
// (see linker-order-probe.test.ts). Each file has its own budget in the runner.
import { expect, test } from "bun:test";
import { isLinux, isMusl } from "harness";
import { runGeneratedRounds } from "./functrace-probe-helpers.ts";

test.skipIf(!isLinux || isMusl || process.arch !== "arm64")(
  "the tracer case inside parallel workers, part 1",
  async () => {
    const { stalls, staleReports } = await runGeneratedRounds({ label: "gen1", budgetMs: 150_000 });
    expect({ stalls, staleReports }).toEqual({ stalls: 0, staleReports: 0 });
  },
  175_000,
);
