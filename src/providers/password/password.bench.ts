import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { defaultCost, Password } from "../../models/index.ts";
import type { Cost } from "../../models/index.ts";
import { defaultParams, Argon2PasswordProvider } from "./index.ts";

const password = Password.parse("correct horse battery staple");
const wrongPassword = Password.parse("incorrect horse battery staple");
const signal = new AbortController().signal;
const hasher = Argon2PasswordProvider.create(defaultParams());
type VerifyCase = { readonly name: string; readonly cost: Cost };
const currentCase: VerifyCase = { name: "verify default", cost: defaultCost };
const legacyCase: VerifyCase = {
  name: "verify legacy",
  cost: { memoryKiB: 65536, iterations: 3, parallelism: 2 },
};
const verifyMeansMs = new Map<string, number>();
const run = process.env.AUTH_PASSWORD_BENCH_RUN ?? "latest";
const directory = "bench-results/password";
const resolutionMs = 10;
const options = { iterations: 5, warmupIterations: 1, time: 0, warmupTime: 0 };

it("hash", { timeout: 120000 }, async ({ bench }) => {
  await bench("hash", { writeResult: resultPath("hash") }, async () => {
    await hasher.hash(password, signal);
  }).run(options);
});

it("hash saturated", { timeout: 120000 }, async ({ bench }) => {
  await bench(
    "hash saturated",
    { writeResult: resultPath("saturated") },
    async () => {
      await Promise.all(
        Array.from({ length: defaultParams().maxConcurrent }, () =>
          hasher.hash(password, signal),
        ),
      );
    },
  ).run({ ...options, iterations: 3 });
});

function resultPath(name: string): string {
  return `${directory}/${run}-${name.replace(" ", "-")}.json`;
}

function measuredMeanMs({ name }: VerifyCase): number {
  const mean = verifyMeansMs.get(name);
  if (mean === undefined) {
    throw new Error(`Verify bench did not complete in this run: ${name}`);
  }
  return mean;
}

async function readMeanLatencyMs(path: string): Promise<number> {
  const result: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof result === "object" &&
    result !== null &&
    "latency" in result &&
    typeof result.latency === "object" &&
    result.latency !== null &&
    "mean" in result.latency &&
    typeof result.latency.mean === "number"
  ) {
    return result.latency.mean;
  }
  throw new Error(`Bench result has no mean latency: ${path}`);
}

for (const { name, cost } of [currentCase, legacyCase]) {
  it(name, { timeout: 120000 }, async ({ bench }) => {
    const encoded = await Argon2PasswordProvider.create({
      ...defaultParams(),
      ...cost,
    }).hash(password, signal);
    if (await hasher.verify(wrongPassword, encoded, signal)) {
      throw new Error(`Expected verify to return false: ${name}`);
    }
    await bench(name, { writeResult: resultPath(name) }, async () => {
      await hasher.verify(wrongPassword, encoded, signal);
    }).run(options);
    verifyMeansMs.set(name, await readMeanLatencyMs(resultPath(name)));
  });
}

it("verify difference", async () => {
  const currentMs = measuredMeanMs(currentCase);
  const legacyMs = measuredMeanMs(legacyCase);
  await writeFile(
    resultPath("verify-difference"),
    JSON.stringify(
      {
        currentMs,
        legacyMs,
        differenceMs: currentMs - legacyMs,
        ratio: currentMs / legacyMs,
      },
      undefined,
      2,
    ),
  );
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
      resultPath("event-loop"),
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
        const candidate = Argon2PasswordProvider.create({
          ...defaultParams(),
          memoryKiB,
          iterations,
        });
        it(name, { timeout: 120000 }, async ({ bench }) => {
          await bench(name, { writeResult: resultPath(name) }, async () => {
            await candidate.hash(password, signal);
          }).run(options);
        });
      }
    }
  },
);
