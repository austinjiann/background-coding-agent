import { readFile, writeFile } from "node:fs/promises";

import type { Hono } from "hono";

import { createDraftPr } from "../services/github/createDraftPr";
import { appendEvent } from "../services/runs/appendEvent";
import { getRun } from "../services/runs/getRun";
import { updateRun } from "../services/runs/updateRun";
import {
  getChangedFilesPath,
  getPrJsonPath,
  getSummaryPath,
  getTestResultsPath,
} from "../utils/paths";

type CreateDraftPrBody = {
  ticketId?: unknown;
  runId?: unknown;
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
}) {
  const ticketLine = input.ticketUrl
    ? `- [${input.ticketId}](${input.ticketUrl})`
    : `- ${input.ticketId}`;

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
  ].join("\n");
}

export function registerGitHubRoutes(app: Hono) {
  app.post("/github/draft-pr", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as CreateDraftPrBody;
    const ticketId = typeof body.ticketId === "string" ? body.ticketId.trim() : "";
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";

    if (!ticketId || !runId) {
      return c.json({ error: "ticketId and runId are required" }, 400);
    }

    const run = await getRun(runId);

    if (run.status.ticketId !== ticketId) {
      return c.json({ error: `Run ${runId} does not belong to ticket ${ticketId}` }, 400);
    }

    if (!run.status.branchName) {
      return c.json({ error: "No pushed branch is recorded for this run" }, 400);
    }

    const [summaryRaw, changedFilesRaw, testResultsRaw] = await Promise.all([
      readFile(getSummaryPath(ticketId, runId), "utf8").catch(() => ""),
      readFile(getChangedFilesPath(ticketId, runId), "utf8").catch(() => ""),
      readFile(getTestResultsPath(ticketId, runId), "utf8").catch(() => ""),
    ]);

    const prTitle = run.ticket ? `${run.ticket.identifier}: ${run.ticket.title}` : `${ticketId}: Draft PR`;
    const prBody = buildPrBody({
      ticketId,
      ticketUrl: run.ticket?.url ?? null,
      summary: summaryRaw.trim(),
      changedFiles: changedFilesRaw.trim() ? (JSON.parse(changedFilesRaw) as { files?: Array<{ path?: string }> }) : null,
      testResults: testResultsRaw.trim()
        ? (JSON.parse(testResultsRaw) as {
            summary?: { passed?: number; failed?: number };
            commands?: Array<{ command?: string; status?: string }>;
          })
        : null,
    });

    const pr = await createDraftPr({
      branchName: run.status.branchName,
      title: prTitle,
      body: prBody,
    });

    const prPayload = {
      ticketId,
      runId,
      branchName: run.status.branchName,
      prNumber: pr.prNumber,
      prTitle: pr.prTitle,
      prUrl: pr.prUrl,
      status: pr.status,
    };

    await writeFile(getPrJsonPath(ticketId, runId), JSON.stringify(prPayload, null, 2), "utf8");
    await updateRun(runId, {
      prUrl: pr.prUrl,
    });
    await appendEvent(runId, {
      ts: new Date().toISOString(),
      type: pr.status === "created" ? "pr.created" : "pr.reused",
      message:
        pr.status === "created"
          ? `Created draft PR ${pr.prUrl}`
          : `Reused existing draft PR ${pr.prUrl}`,
    });

    return c.json(prPayload, pr.status === "created" ? 201 : 200);
  });
}
