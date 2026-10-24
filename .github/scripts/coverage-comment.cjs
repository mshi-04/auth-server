const fs = require("node:fs");

function readCoverageReport(language) {
  if (language === "go") {
    const details = fs.readFileSync("coverage/coverage.txt", "utf8").trim();
    const total = details.match(
      /^total:\s+\(statements\)\s+(\d+(?:\.\d+)?)%\s*$/m,
    );
    if (!total || Number(total[1]) > 100) {
      throw new Error("Invalid Go coverage total");
    }
    return { total: total[1], details, label: "関数別カバレッジ" };
  }

  if (language !== "typescript") {
    throw new Error("Unknown coverage language");
  }
  const report = JSON.parse(
    fs.readFileSync("coverage/coverage-summary.json", "utf8"),
  );
  const percent = (metrics, metric) => {
    const value = metrics?.[metric]?.pct;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 100
    ) {
      throw new Error("Invalid TypeScript coverage percentage");
    }
    return value;
  };
  const metrics = ["statements", "branches", "functions", "lines"];
  const total = percent(report?.total, "statements");
  const workspace = process.env.GITHUB_WORKSPACE;
  const prefix = workspace ? `${workspace}/` : "";
  const rows = ["ファイル\t文 (%)\t分岐 (%)\t関数 (%)\t行 (%)"];
  rows.push(
    `合計\t${metrics.map((metric) => percent(report.total, metric)).join("\t")}`,
  );
  for (const [file, values] of Object.entries(report)) {
    if (file === "total") continue;
    const path =
      prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file;
    rows.push(
      `${path}\t${metrics.map((metric) => percent(values, metric)).join("\t")}`,
    );
  }
  return { total, details: rows.join("\n"), label: "ファイル別カバレッジ" };
}

async function updateCoverageComment({ github, context, core }) {
  const language = process.env.COVERAGE_LANGUAGE;
  const isGo = language === "go";
  const marker = isGo
    ? "<!-- auth-server-coverage -->"
    : "<!-- auth-server-ts-coverage -->";
  const runMarker = isGo
    ? "auth-server-coverage-run"
    : "auth-server-ts-coverage-run";
  const heading = isGo ? "Go Coverage" : "TypeScript Coverage";
  const pr = context.payload.pull_request;
  const runNumber = context.runNumber;
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const runURL = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}/attempts/${attempt}`;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const comment = comments.find(
    (item) =>
      item.user?.login === "github-actions[bot]" &&
      item.body?.startsWith(marker),
  );
  const previous = comment?.body.match(
    new RegExp(`<!-- ${runMarker}:(\\d+):(\\d+) -->`),
  );
  if (
    previous &&
    (Number(previous[1]) > runNumber ||
      (Number(previous[1]) === runNumber && Number(previous[2]) > attempt))
  ) {
    core.info("A newer coverage run has already updated the comment.");
    return;
  }

  let result = "カバレッジを計測できませんでした。実行ログを確認してください。";
  if (
    process.env.COVERAGE_TEST_OUTCOME === "success" &&
    process.env.COVERAGE_REPORT_OUTCOME === "success"
  ) {
    try {
      const report = readCoverageReport(language);
      const details =
        report.details.length > 48000
          ? `${report.details.slice(0, 48000)}\n...（全文は artifact を参照）`
          : report.details;
      const fence = "`".repeat(
        Math.max(
          3,
          ...(details.match(/`+/g) ?? []).map((value) => value.length + 1),
        ),
      );
      result = `合計カバレッジ: **${report.total}%**\n\n<details>\n<summary>${report.label}</summary>\n\n${fence}text\n${details}\n${fence}\n\n</details>`;
    } catch {
      core.setFailed("Could not read a valid coverage report.");
    }
  }
  const lines = [
    marker,
    `<!-- ${runMarker}:${runNumber}:${attempt} -->`,
    `## ${heading}`,
    "",
    result,
    "",
    `計測コミット: \`${context.sha.slice(0, 7)}\``,
    `[実行ログ #${runNumber}（試行 ${attempt}）](${runURL})`,
  ];
  if (process.env.COVERAGE_ARTIFACT_URL) {
    lines.push(
      `[詳細レポート（artifact）](${process.env.COVERAGE_ARTIFACT_URL})`,
    );
  }

  const { data: currentPR } = await github.rest.pulls.get({
    ...context.repo,
    pull_number: pr.number,
  });
  if (currentPR.state !== "open" || currentPR.head.sha !== pr.head.sha) {
    core.info("The pull request is closed or its head commit has changed.");
    return;
  }
  const body = lines.join("\n");
  if (comment) {
    await github.rest.issues.updateComment({
      ...context.repo,
      comment_id: comment.id,
      body,
    });
    return;
  }
  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: pr.number,
    body,
  });
}

module.exports = updateCoverageComment;

if (require.main === module) {
  const report = readCoverageReport(process.env.COVERAGE_LANGUAGE);
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## TypeScript Coverage\n\n合計カバレッジ: **${report.total}%**\n`,
  );
}
