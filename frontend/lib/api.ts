import type { BackendRunStatus, RunDetails, RunEvent, TicketSummary } from "./types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

export async function getLinearTickets() {
  return requestJson<TicketSummary[]>("/linear/issues");
}

export async function launchRun(ticketId: string) {
  return requestJson<{ runId: string }>("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticketId }),
  });
}

export async function getRun(runId: string) {
  return requestJson<RunDetails>(`/runs/${runId}`);
}

export async function getRunEvents(ticketId: string, runId: string) {
  const search = new URLSearchParams({ ticketId });
  return requestJson<RunEvent[]>(`/runs/${runId}/events?${search.toString()}`);
}

export async function retryRun(runId: string) {
  return requestJson<{ runId: string }>(`/runs/${runId}/retry`, {
    method: "POST",
  });
}

export async function cancelRun(ticketId: string, runId: string) {
  return requestJson<BackendRunStatus>(`/runs/${runId}/cancel`, {
    method: "POST",
  });
}

export async function createDraftPr(ticketId: string, runId: string) {
  return requestJson<{ ticketId: string; runId: string; branchName: string; prUrl: string | null; status: string }>(
    "/github/draft-pr",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId, runId }),
    },
  );
}
