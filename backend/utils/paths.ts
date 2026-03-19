import { readdir } from "node:fs/promises";
import path from "node:path";

export type RunLocation = {
  ticketId: string;
  runId: string;
  runPath: string;
};

function sanitizeSegment(value: string) {
  return value.replace(/[^\w.-]/g, "_");
}

export function getRunsRoot() {
  return path.join(process.cwd(), "runs");
}

export function getRunPath(ticketId: string, runId: string) {
  return path.join(getRunsRoot(), sanitizeSegment(ticketId), sanitizeSegment(runId));
}

export function getStatusPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), "status.json");
}

export function getEventsPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), "events.jsonl");
}

export function getSummaryPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), "summary.md");
}

export function getTicketSnapshotPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), "ticket.json");
}

export function getTestResultsPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), "test-results.json");
}

export function getTestOutputPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), "test-output.txt");
}

export function getChangedFilesPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), "changed-files.json");
}

export function getDiffPatchPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), "diff.patch");
}

export function getOpenCodeOutputPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), "opencode-output.jsonl");
}

export function getModalOutputPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), "modal-output.log");
}

export function getPrJsonPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), "pr.json");
}

export function getScreenshotsPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), "screenshots");
}

export async function findRunPathByRunId(runId: string): Promise<RunLocation | null> {
  const runsRoot = getRunsRoot();
  const ticketDirs = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);

  for (const ticketDir of ticketDirs) {
    if (!ticketDir.isDirectory()) {
      continue;
    }

    const candidateRunPath = path.join(runsRoot, ticketDir.name, sanitizeSegment(runId));
    const statusPath = path.join(candidateRunPath, "status.json");
    const exists = await readdir(candidateRunPath).then(() => true).catch(() => false);

    if (!exists) {
      continue;
    }

    const hasStatus = await readdir(path.dirname(statusPath))
      .then((entries) => entries.includes("status.json"))
      .catch(() => false);

    if (hasStatus) {
      return {
        ticketId: ticketDir.name,
        runId,
        runPath: candidateRunPath,
      };
    }
  }

  return null;
}
