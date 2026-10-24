import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import updateCoverageComment from "./coverage-comment.cjs";

type Comment = { id: number; user: { login: string }; body: string };

const headSha = "0123456789abcdef";
const tsMarker = "<!-- auth-server-ts-coverage -->";
const goMarker = "<!-- auth-server-coverage -->";

function metrics(pct: number) {
  return {
    statements: { pct },
    branches: { pct },
    functions: { pct },
    lines: { pct },
  };
}

function fakeGitHub(
  options: { comments?: Comment[]; state?: string; head?: string } = {},
) {
  const created: string[] = [];
  const updated: { id: number; body: string }[] = [];
  const github = {
    paginate: () => Promise.resolve(options.comments ?? []),
    rest: {
      issues: {
        listComments: () => Promise.resolve([]),
        createComment: ({ body }: { body: string }) => {
          created.push(body);
          return Promise.resolve();
        },
        updateComment: ({
          comment_id,
          body,
        }: {
          comment_id: number;
          body: string;
        }) => {
          updated.push({ id: comment_id, body });
          return Promise.resolve();
        },
      },
      pulls: {
        get: () =>
          Promise.resolve({
            data: {
              state: options.state ?? "open",
              head: { sha: options.head ?? headSha },
            },
          }),
      },
    },
  };
  return { github, created, updated };
}

function fakeCore() {
  const failures: string[] = [];
  const infos: string[] = [];
  return {
    failures,
    infos,
    core: {
      info: (message: string) => infos.push(message),
      setFailed: (message: string) => failures.push(message),
    },
  };
}

const context = {
  payload: { pull_request: { number: 14, head: { sha: headSha } } },
  runNumber: 7,
  runId: 99,
  serverUrl: "https://github.com",
  repo: { owner: "mshi-04", repo: "auth-server" },
  sha: "fedcba9876543210",
};

let workspace = "";
const originalCwd = process.cwd();

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "coverage-comment-"));
  await mkdir(join(workspace, "coverage"));
  process.chdir(workspace);
  vi.stubEnv("GITHUB_WORKSPACE", workspace);
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
  vi.stubEnv("COVERAGE_LANGUAGE", "typescript");
  vi.stubEnv("COVERAGE_TEST_OUTCOME", "success");
  vi.stubEnv("COVERAGE_REPORT_OUTCOME", "success");
  vi.stubEnv("COVERAGE_ARTIFACT_URL", "");
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  await rm(workspace, { recursive: true, force: true });
});

async function writeTypeScriptSummary(totalPct: number) {
  await writeFile(
    join(workspace, "coverage", "coverage-summary.json"),
    JSON.stringify({
      total: metrics(totalPct),
      [join(workspace, "src", "errors.ts")]: metrics(totalPct),
    }),
  );
}

describe("updateCoverageComment", () => {
  it("creates a TypeScript comment with workspace-relative file rows", async () => {
    await writeTypeScriptSummary(87.5);
    const { github, created, updated } = fakeGitHub();
    const { core, failures } = fakeCore();

    await updateCoverageComment({ github, context, core });

    expect(updated).toEqual([]);
    expect(failures).toEqual([]);
    expect(created).toHaveLength(1);
    const body = created[0] ?? "";
    expect(body.startsWith(tsMarker)).toBe(true);
    expect(body).toContain("<!-- auth-server-ts-coverage-run:7:1 -->");
    expect(body).toContain("## TypeScript Coverage");
    expect(body).toContain("合計カバレッジ: **87.5%**");
    expect(body).toContain("src/errors.ts\t87.5\t87.5\t87.5\t87.5");
    expect(body).not.toContain(workspace);
    expect(body).toContain("計測コミット: `fedcba9`");
  });

  it("updates its own comment and leaves the Go comment alone", async () => {
    await writeTypeScriptSummary(100);
    const comments = [
      { id: 1, user: { login: "github-actions[bot]" }, body: `${goMarker}\n` },
      { id: 2, user: { login: "github-actions[bot]" }, body: `${tsMarker}\n` },
    ];
    const { github, created, updated } = fakeGitHub({ comments });
    const { core } = fakeCore();

    await updateCoverageComment({ github, context, core });

    expect(created).toEqual([]);
    expect(updated.map(({ id }) => id)).toEqual([2]);
  });

  it("ignores a marker comment written by another user", async () => {
    await writeTypeScriptSummary(100);
    const comments = [{ id: 3, user: { login: "someone" }, body: tsMarker }];
    const { github, created, updated } = fakeGitHub({ comments });
    const { core } = fakeCore();

    await updateCoverageComment({ github, context, core });

    expect(updated).toEqual([]);
    expect(created).toHaveLength(1);
  });

  it.each([
    { name: "a later run", run: "8:1" },
    { name: "a later attempt of the same run", run: "7:2" },
  ])("does not overwrite a comment from $name", async ({ run }) => {
    await writeTypeScriptSummary(100);
    const body = `${tsMarker}\n<!-- auth-server-ts-coverage-run:${run} -->`;
    const comments = [{ id: 4, user: { login: "github-actions[bot]" }, body }];
    const { github, created, updated } = fakeGitHub({ comments });
    const { core } = fakeCore();

    await updateCoverageComment({ github, context, core });

    expect(created).toEqual([]);
    expect(updated).toEqual([]);
  });

  it.each([
    { name: "closed", options: { state: "closed" } },
    { name: "moved to a new head", options: { head: "another-sha" } },
  ])("does not post when the pull request is $name", async ({ options }) => {
    await writeTypeScriptSummary(100);
    const { github, created, updated } = fakeGitHub(options);
    const { core } = fakeCore();

    await updateCoverageComment({ github, context, core });

    expect(created).toEqual([]);
    expect(updated).toEqual([]);
  });

  it("reports a failure without old numbers when the test step failed", async () => {
    vi.stubEnv("COVERAGE_TEST_OUTCOME", "failure");
    const { github, created } = fakeGitHub();
    const { core, failures } = fakeCore();

    await updateCoverageComment({ github, context, core });

    expect(failures).toEqual([]);
    expect(created[0]).toContain("カバレッジを計測できませんでした");
    expect(created[0]).not.toContain("合計カバレッジ");
  });

  it("fails the step when the report has an out-of-range percentage", async () => {
    await writeTypeScriptSummary(101);
    const { github, created } = fakeGitHub();
    const { core, failures } = fakeCore();

    await updateCoverageComment({ github, context, core });

    expect(failures).toEqual(["Could not read a valid coverage report."]);
    expect(created[0]).toContain("カバレッジを計測できませんでした");
  });

  it("reads the Go function coverage total", async () => {
    vi.stubEnv("COVERAGE_LANGUAGE", "go");
    await writeFile(
      join(workspace, "coverage", "coverage.txt"),
      "auth-server/internal/x.go:1:\tF\t50.0%\ntotal:\t(statements)\t62.5%\n",
    );
    const { github, created } = fakeGitHub();
    const { core, failures } = fakeCore();

    await updateCoverageComment({ github, context, core });

    expect(failures).toEqual([]);
    expect(created[0]?.startsWith(goMarker)).toBe(true);
    expect(created[0]).toContain("## Go Coverage");
    expect(created[0]).toContain("合計カバレッジ: **62.5%**");
  });

  it("rejects an unknown coverage language", async () => {
    vi.stubEnv("COVERAGE_LANGUAGE", "rust");
    const { github, created } = fakeGitHub();
    const { core } = fakeCore();

    await expect(
      updateCoverageComment({ github, context, core }),
    ).rejects.toThrow("Unknown coverage language");
    expect(created).toEqual([]);
  });
});
