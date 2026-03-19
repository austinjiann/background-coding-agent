import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  findRunPathByRunId,
  getEventsPath,
  getScreenshotsPath,
  getStatusPath,
  getTicketSnapshotPath,
} from "../../utils/paths";
import type { RunStatus } from "./createRun";
import type { RunEvent } from "./appendEvent";
import type { LinearIssue } from "../linear/client";

export type RunDetails = {
  status: RunStatus;
  ticket: LinearIssue | null;
  events: RunEvent[];
  artifacts: string[];
};

// Read the current status, event log, and visible artifacts for a run.
export async function getRun(runId: string): Promise<RunDetails> {
  const location = await findRunPathByRunId(runId);

  if (!location) {
    throw new Error(`Run ${runId} not found`);
  }

  const [statusRaw, ticketRaw, eventsRaw, screenshotNames, runEntries] = await Promise.all([
    readFile(getStatusPath(location.ticketId, runId), "utf8"),
    readFile(getTicketSnapshotPath(location.ticketId, runId), "utf8").catch(() => ""),
    readFile(getEventsPath(location.ticketId, runId), "utf8").catch(() => ""),
    readdir(getScreenshotsPath(location.ticketId, runId)).catch(() => []),
    readdir(location.runPath).catch(() => []),
  ]);

  const status = JSON.parse(statusRaw) as RunStatus;
  const ticket = ticketRaw.trim() ? (JSON.parse(ticketRaw) as LinearIssue) : null;
  const events = eventsRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);

  const artifacts = [
    "ticket.json",
    "summary.md",
    "changed-files.json",
    "diff.patch",
    "modal-output.log",
    "opencode-output.jsonl",
    "screenshots.json",
    "test-results.json",
    "test-output.txt",
    ...(runEntries.includes("pr.json") ? ["pr.json"] : []),
    ...screenshotNames.map((name) => path.join("screenshots", name)),
  ];

  return {
    status,
    ticket,
    events,
    artifacts,
  };
}
