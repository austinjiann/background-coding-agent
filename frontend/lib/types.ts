export type RunStatusValue = "created" | "running" | "completed" | "failed" | "canceled";

export type TicketSummary = {
  id: string;
  identifier: string;
  title: string;
  state: string;
  assignee: string | null;
  activeRunId?: string | null;
  runStatus?: RunStatusValue | null;
};

export type TicketDetails = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: string;
  url: string;
};

export type BackendRunStatus = {
  ticketId: string;
  runId: string;
  status: "created" | "running" | "completed" | "failed" | "canceled";
  createdAt: string;
  updatedAt: string;
  sandboxId: string | null;
  triageLabel: "simple" | "complex" | null;
  selectedModel: string | null;
  branchName: string | null;
  prUrl: string | null;
  error: string | null;
};

export type RunEvent = {
  ts: string;
  type: string;
  message: string;
};

export type RunDetails = {
  status: BackendRunStatus;
  ticket: TicketDetails | null;
  events: RunEvent[];
  artifacts: string[];
};

export type AgentId = "agent-1" | "agent-2" | "agent-3" | "agent-4";

export type AgentAssignmentState = Partial<Record<string, AgentId>>;

export type AgentSlot = {
  id: AgentId;
  label: string;
  name: string;
  description: string;
};

export type DashboardStats = {
  openTickets: number;
  assignedTickets: number;
  activeRuns: number;
  draftPrs: number;
};

export type RunListItem = {
  runId: string;
  ticketId: string;
  ticketIdentifier: string;
  ticketTitle: string;
  status: string;
  stage: string;
  updatedAt: string | null;
};

export const AGENT_SLOTS: AgentSlot[] = [
  {
    id: "agent-1",
    label: "Agent 1",
    name: "Agent 1",
    description: "General implementation lane for the next unassigned ticket.",
  },
  {
    id: "agent-2",
    label: "Agent 2",
    name: "Agent 2",
    description: "Parallel lane for follow-up fixes and retries.",
  },
  {
    id: "agent-3",
    label: "Agent 3",
    name: "Agent 3",
    description: "Overflow lane for additional active runs.",
  },
  {
    id: "agent-4",
    label: "Agent 4",
    name: "Agent 4",
    description: "Spare lane for experiments and verification runs.",
  },
];
