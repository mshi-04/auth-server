import { mkdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Password } from "../models/index.ts";
import { defaultParams, Hasher } from "./index.ts";

const password = Password.parse("correct horse battery staple");
const signal = new AbortController().signal;
const hasher = Hasher.create(defaultParams());
const run = process.env.AUTH_PASSWORD_BENCH_RUN ?? "latest";
const directory = "bench-results/password";
const resolutionMs = 10;
const options = { iterations: 5, warmupIterations: 1, time: 0, warmupTime: 0 };

it("hash", { timeout: 120000 }, async ({ bench }) => {
  await bench(
    "hash",
    { writeResult: `${directory}/${run}-hash.json` },
    async () => {
      await hasher.hash(password, signal);
    },
  ).run(options);
});

it("hash saturated", { timeout: 120000 }, async ({ bench }) => {
  await bench(
    "hash saturated",
    { writeResult: `${directory}/${run}-saturated.json` },
    async () => {
      await Promise.all(
        Array.from({ length: defaultParams().maxConcurrent }, () =>
          hasher.hash(password, signal),
        ),
      );
    },
  ).run({ ...options, iterations: 3 });
});

it("event loop delay under saturation", { timeout: 120000 }, async () => {
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  try {
    await setTimeout(20);
    histogram.reset();
    const start = performance.now();
    await Promise.all(
      Array.from({ length: defaultParams().maxConcurrent }, () =>
        hasher.hash(password, signal),
      ),
    );
    const elapsedMs = performance.now() - start;
    await setImmediate();
    const maximumDelayMs = histogram.max / 1e6 - resolutionMs;
    const meanDelayMs = histogram.mean / 1e6 - resolutionMs;
    await mkdir(directory, { recursive: true });
    await writeFile(
      `${directory}/${run}-event-loop.json`,
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          cpu: cpus()[0]?.model,
          uvThreadPoolSize: process.env.UV_THREADPOOL_SIZE ?? "4 (default)",
          params: defaultParams(),
          elapsedMs,
          maximumDelayMs,
          meanDelayMs,
        },
        undefined,
        2,
      ),
    );
    expect(maximumDelayMs).toBeLessThan(50);
  } finally {
    histogram.disable();
  }
});

describe.runIf(process.env.AUTH_PASSWORD_BENCH_CANDIDATES === "1")(
  "hash candidates",
  () => {
    for (const memoryKiB of [65536, 131072]) {
      for (let iterations = 2; iterations <= 10; iterations++) {
        const name = `m=${memoryKiB.toString()},t=${iterations.toString()}`;
        const candidate = Hasher.create({
          ...defaultParams(),
          memoryKiB,
          iterations,
        });
        it(name, { timeout: 120000 }, async ({ bench }) => {
          await bench(
            name,
            { writeResult: `${directory}/${run}-${name}.json` },
            async () => {
              await candidate.hash(password, signal);
            },
          ).run(options);
        });
      }
    }
  },
);
