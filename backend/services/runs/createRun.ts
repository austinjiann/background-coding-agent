import { mkdir, writeFile } from "node:fs/promises";

import { createRunId } from "../../utils/ids";
import {
  getChangedFilesPath,
  getDiffPatchPath,
  getEventsPath,
  getModalOutputPath,
  getOpenCodeOutputPath,
  getRunPath,
  getScreenshotsPath,
  getScreenshotsMetadataPath,
  getStatusPath,
  getSummaryPath,
  getTestOutputPath,
  getTestResultsPath,
  getTicketSnapshotPath,
} from "../../utils/paths";

export type RunStatus = {
  runId: string;
  ticketId: string;
  status: "created" | "running" | "completed" | "failed" | "canceled";
  createdAt: string;
  updatedAt: string;
  sandboxId: string | null;
  canceledAt: string | null;
  completedAt: string | null;
  triageLabel: "simple" | "complex" | null;
  selectedModel: string | null;
  branchName: string | null;
  prUrl: string | null;
  error: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

// Create the folder structure and placeholder files for a new run.
export async function createRun(ticketId: string): Promise<RunStatus> {
  const runId = createRunId();
  const createdAt = nowIso();
  const runPath = getRunPath(ticketId, runId);

  await mkdir(runPath, { recursive: true });
  await mkdir(getScreenshotsPath(ticketId, runId), { recursive: true });

  const status: RunStatus = {
    runId,
    ticketId,
    status: "created",
    createdAt,
    updatedAt: createdAt,
    sandboxId: null,
    canceledAt: null,
    completedAt: null,
    triageLabel: null,
    selectedModel: null,
    branchName: null,
    prUrl: null,
    error: null,
  };

  await Promise.all([
    writeFile(getStatusPath(ticketId, runId), JSON.stringify(status, null, 2)),
    writeFile(getEventsPath(ticketId, runId), ""),
    writeFile(getTicketSnapshotPath(ticketId, runId), ""),
    writeFile(getSummaryPath(ticketId, runId), ""),
    writeFile(getChangedFilesPath(ticketId, runId), JSON.stringify({ files: [] }, null, 2)),
    writeFile(getDiffPatchPath(ticketId, runId), ""),
    writeFile(getModalOutputPath(ticketId, runId), ""),
    writeFile(getOpenCodeOutputPath(ticketId, runId), ""),
    writeFile(getScreenshotsMetadataPath(ticketId, runId), JSON.stringify({ screenshots: [] }, null, 2)),
    writeFile(getTestResultsPath(ticketId, runId), JSON.stringify({ commands: [] }, null, 2)),
    writeFile(getTestOutputPath(ticketId, runId), ""),
  ]);

  return status;
}
