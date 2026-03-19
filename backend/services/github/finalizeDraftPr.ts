import { readFile, writeFile } from "node:fs/promises";

import { createDraftPr, updateDraftPr } from "./createDraftPr";
import { appendEvent } from "../runs/appendEvent";
import { getRun } from "../runs/getRun";
import { updateRun } from "../runs/updateRun";
import {
  getChangedFilesPath,
  getPrJsonPath,
  getScreenshotsMetadataPath,
  getSummaryPath,
  getTestResultsPath,
} from "../../utils/paths";

type ScreenshotMetadata = {
  filename?: string;
  label?: string;
  kind?: "before" | "after";
  url?: string;
};

function formatChangedFilesList(changedFiles: { files?: Array<{ path?: string }> } | null) {
  const files = changedFiles?.files?.map((file) => file.path).filter(Boolean) ?? [];

  if (files.length === 0) {
    return "- No changed files recorded";
  }

  return files.map((file) => `- \`${file}\``).join("\n");
}

function formatTestResults(testResults: {
  summary?: { passed?: number; failed?: number };
  commands?: Array<{ command?: string; status?: string }>;
} | null) {
  const passed = testResults?.summary?.passed ?? 0;
  const failed = testResults?.summary?.failed ?? 0;
  const commands = testResults?.commands ?? [];
  const commandLines =
    commands.length > 0
      ? commands
          .map((command) => `- \`${command.command ?? "unknown command"}\` — ${command.status ?? "unknown"}`)
          .join("\n")
      : "- No test commands recorded";

  return [`- Passed: ${passed}`, `- Failed: ${failed}`, "", commandLines].join("\n");
}

function buildPrBody(input: {
  ticketId: string;
  ticketUrl: string | null;
  summary: string;
  changedFiles: { files?: Array<{ path?: string }> } | null;
  testResults: {
    summary?: { passed?: number; failed?: number };
    commands?: Array<{ command?: string; status?: string }>;
  } | null;
  screenshots: ScreenshotMetadata[] | null;
}) {
  const ticketLine = input.ticketUrl
    ? `- [${input.ticketId}](${input.ticketUrl})`
    : `- ${input.ticketId}`;

  const screenshotsByLabel = new Map<
    string,
    {
      before?: ScreenshotMetadata;
      after?: ScreenshotMetadata;
    }
  >();

  for (const screenshot of input.screenshots ?? []) {
    if (!screenshot.label || !screenshot.url) {
      continue;
    }

    const entry = screenshotsByLabel.get(screenshot.label) ?? {};

    if (screenshot.kind === "before") {
      entry.before = screenshot;
    } else {
      entry.after = screenshot;
    }

    screenshotsByLabel.set(screenshot.label, entry);
  }

  const screenshotSection =
    screenshotsByLabel.size > 0
      ? [
          "",
          "## Screenshots",
          ...Array.from(screenshotsByLabel.entries()).flatMap(([label, pair]) => [
            "",
            `### ${label}`,
            pair.before?.url
              ? `**Before**\n\n![Before ${label}](${pair.before.url})`
              : "_Before screenshot unavailable_",
            "",
            pair.after?.url
              ? `**After**\n\n![After ${label}](${pair.after.url})`
              : "_After screenshot unavailable_",
          ]),
        ]
      : [];

  return [
    "## Ticket",
    ticketLine,
    "",
    "## Summary",
    input.summary || "No run summary recorded.",
    "",
    "## Changed Files",
    formatChangedFilesList(input.changedFiles),
    "",
    "## Test Results",
    formatTestResults(input.testResults),
    ...screenshotSection,
  ].join("\n");
}

export async function finalizeDraftPr(input: { ticketId: string; runId: string }) {
  const run = await getRun(input.runId);

  if (run.status.ticketId !== input.ticketId) {
    throw new Error(`Run ${input.runId} does not belong to ticket ${input.ticketId}`);
  }

  if (!run.status.branchName) {
    throw new Error("No pushed branch is recorded for this run");
  }

  await appendEvent(input.runId, {
    ts: new Date().toISOString(),
    type: "pr.creating",
    message: `Creating draft PR for ${run.status.branchName}`,
  });

  const [summaryRaw, changedFilesRaw, testResultsRaw, screenshotsRaw] = await Promise.all([
    readFile(getSummaryPath(input.ticketId, input.runId), "utf8").catch(() => ""),
    readFile(getChangedFilesPath(input.ticketId, input.runId), "utf8").catch(() => ""),
    readFile(getTestResultsPath(input.ticketId, input.runId), "utf8").catch(() => ""),
    readFile(getScreenshotsMetadataPath(input.ticketId, input.runId), "utf8").catch(() => ""),
  ]);

  const prTitle = run.ticket ? `${run.ticket.identifier}: ${run.ticket.title}` : `${input.ticketId}: Draft PR`;
  const screenshots = screenshotsRaw.trim()
    ? ((JSON.parse(screenshotsRaw) as { screenshots?: ScreenshotMetadata[] }).screenshots ?? null)
    : null;
  const prBody = buildPrBody({
    ticketId: input.ticketId,
    ticketUrl: run.ticket?.url ?? null,
    summary: summaryRaw.trim(),
    changedFiles: changedFilesRaw.trim() ? (JSON.parse(changedFilesRaw) as { files?: Array<{ path?: string }> }) : null,
    testResults: testResultsRaw.trim()
      ? (JSON.parse(testResultsRaw) as {
          summary?: { passed?: number; failed?: number };
          commands?: Array<{ command?: string; status?: string }>;
        })
      : null,
    screenshots,
  });

  let pr;
  try {
    pr = await createDraftPr({
      branchName: run.status.branchName,
      title: prTitle,
      body: prBody,
    });

    if (pr.status === "existing") {
      await updateDraftPr({
        prNumber: pr.prNumber,
        title: prTitle,
        body: prBody,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Draft PR creation failed";
    await appendEvent(input.runId, {
      ts: new Date().toISOString(),
      type: "pr.failed",
      message,
    });
    await updateRun(input.runId, {
      error: `Draft PR creation failed: ${message}`,
    });
    throw error;
  }

  const prPayload = {
    ticketId: input.ticketId,
    runId: input.runId,
    branchName: run.status.branchName,
    prNumber: pr.prNumber,
    prTitle: pr.prTitle,
    prUrl: pr.prUrl,
    status: pr.status,
  };

  await writeFile(getPrJsonPath(input.ticketId, input.runId), JSON.stringify(prPayload, null, 2), "utf8");
  await updateRun(input.runId, {
    prUrl: pr.prUrl,
    error: null,
  });
  await appendEvent(input.runId, {
    ts: new Date().toISOString(),
    type: pr.status === "created" ? "pr.created" : "pr.reused",
    message:
      pr.status === "created"
        ? `Created draft PR ${pr.prUrl}`
        : `Reused existing draft PR ${pr.prUrl}`,
  });

  return prPayload;
}
