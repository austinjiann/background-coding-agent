"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  CheckCircledIcon,
  ClockIcon,
  CrossCircledIcon,
  ExternalLinkIcon,
  ExclamationTriangleIcon,
  Link2Icon,
  PersonIcon,
  PlayIcon,
  ReaderIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";

import { formatRelativeTimestamp } from "../lib/format";
import type {
  AgentId,
  AgentSlot,
  DashboardStats,
  RunDetails,
  RunListItem,
  TicketSummary,
} from "../lib/types";

export function PageHeader({
  title,
  subtitle,
  stats,
}: {
  title: string;
  subtitle?: string;
  stats: DashboardStats;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      <Tooltip.Provider delayDuration={120}>
        <div className="stat-strip">
          <StatPill
            icon={<ReaderIcon />}
            label="Open Tickets"
            value={stats.openTickets}
            tip="Tickets currently visible from Linear."
          />
          <StatPill
            icon={<Link2Icon />}
            label="Assigned"
            value={stats.assignedTickets}
            tip="Tickets mapped to a local agent slot in this session."
          />
          <StatPill
            icon={<ClockIcon />}
            label="Active Runs"
            value={stats.activeRuns}
            tip="Tickets with an exposed active run id from the API."
          />
          <StatPill
            icon={<CheckCircledIcon />}
            label="Draft PRs"
            value={stats.draftPrs}
            tip="Runs already reporting a PR URL."
          />
        </div>
      </Tooltip.Provider>
    </header>
  );
}

function StatPill({
  icon,
  label,
  value,
  tip,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tip: string;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <div className="stat-pill">
          {icon}
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={10} className="tooltip-content">
          {tip}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function SectionHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-4">
      <div>
        <h2>{title}</h2>
        <p className="helper-copy">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  title,
  copy,
  action,
}: {
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p className="empty-copy">{copy}</p>
      {action}
    </div>
  );
}

export function ErrorState({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="message-panel error">
      <strong>{title}</strong>
      <p className="empty-copy">{copy}</p>
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="message-panel">
      <strong>{label}</strong>
      <p className="empty-copy">The dashboard is waiting on the API response.</p>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const icon =
    normalized === "completed" ? (
      <CheckCircledIcon />
    ) : normalized === "failed" || normalized === "canceled" ? (
      <CrossCircledIcon />
    ) : normalized === "running" ? (
      <PlayIcon />
    ) : normalized === "queued" ? (
      <ClockIcon />
    ) : normalized === "idle" || normalized === "canceled" ? (
      <ClockIcon />
    ) : normalized.endsWith("assigned") ? (
      <PersonIcon />
    ) : normalized === "created" ? (
      <ClockIcon />
    ) : (
      <ExclamationTriangleIcon />
    );

  return (
    <span className="status-badge">
      {icon}
      {status}
    </span>
  );
}

function getAgentState(tickets: TicketSummary[]): {
  dotClass: string;
  statusText: string;
} {
  if (tickets.length === 0) {
    return { dotClass: "agent-dot is-idle", statusText: "idle" };
  }

  const statuses = tickets.map((t) => t.runStatus).filter(Boolean);

  if (statuses.includes("running") || statuses.includes("created")) {
    return { dotClass: "agent-dot is-running", statusText: "running" };
  }
  if (statuses.includes("completed")) {
    return { dotClass: "agent-dot is-completed", statusText: "completed" };
  }
  if (statuses.includes("failed")) {
    return { dotClass: "agent-dot is-failed", statusText: "failed" };
  }
  if (statuses.includes("canceled")) {
    return { dotClass: "agent-dot is-idle", statusText: "canceled" };
  }

  return { dotClass: "agent-dot", statusText: `${tickets.length} assigned` };
}

export function AgentCardCompact({
  agent,
  tickets,
}: {
  agent: AgentSlot;
  tickets: TicketSummary[];
}) {
  const isIdle = tickets.length === 0;
  const { dotClass, statusText } = getAgentState(tickets);

  return (
    <article className="bento-cell bento-agent">
      <div className="bento-agent-header">
        <div className={dotClass} />
        <StatusBadge status={statusText} />
      </div>
      <h3 className="bento-agent-name">{agent.name}</h3>
      {isIdle ? (
        <p className="helper-copy">Open for a ticket.</p>
      ) : (
        <div className="bento-agent-tickets">
          {tickets.map((ticket) => (
            <span key={ticket.id} className="eyebrow">
              {ticket.identifier}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

export function TicketCard({
  ticket,
  assignedAgent,
  onAssign,
  onLaunch,
  launching,
}: {
  ticket: TicketSummary;
  assignedAgent?: AgentId | null;
  onAssign: (ticketId: string, agentId: AgentId | null) => void;
  onLaunch?: (ticketId: string) => void;
  launching?: boolean;
}) {
  return (
    <article className="ticket-card">
      <div className="ticket-layout">
        <div className="grid gap-3 min-w-0">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-mono eyebrow">{ticket.identifier}</span>
              <StatusBadge status={ticket.state} />
            </div>
            <h3 className="ticket-card-title">{ticket.title}</h3>
            <div className="flex flex-wrap gap-2.5">
              <span className="metadata-copy">Linear assignee: {ticket.assignee ?? "Unassigned"}</span>
              <span className="metadata-copy">
                Ticket ID: <span className="font-mono">{ticket.id}</span>
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <div style={{ minWidth: 220 }}>
              <label className="field-label" htmlFor={`assign-${ticket.id}`}>
                Assign agent
              </label>
              <select
                id={`assign-${ticket.id}`}
                className="assign-select"
                value={assignedAgent ?? ""}
                onChange={(event) =>
                  onAssign(ticket.id, (event.currentTarget.value || null) as AgentId | null)
                }
              >
                <option value="">Unassigned</option>
                <option value="agent-1">Agent 1</option>
                <option value="agent-2">Agent 2</option>
                <option value="agent-3">Agent 3</option>
                <option value="agent-4">Agent 4</option>
              </select>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {ticket.activeRunId ? (
            <Link href={`/runs/${ticket.activeRunId}`} className="button secondary">
              <ExternalLinkIcon />
              View run
            </Link>
          ) : (
            <LaunchRunDialog
              identifier={ticket.identifier}
              title={ticket.title}
              launching={launching}
              onConfirm={() => onLaunch?.(ticket.id)}
            />
          )}
        </div>
      </div>
    </article>
  );
}

function LaunchRunDialog({
  identifier,
  title,
  launching,
  onConfirm,
}: {
  identifier: string;
  title: string;
  launching?: boolean;
  onConfirm?: () => void;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className="button">
          <PlayIcon />
          Launch
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title asChild>
            <h3>Launch run for {identifier}</h3>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p>{title}</p>
          </Dialog.Description>
          <div className="flex flex-wrap gap-2.5">
            <Dialog.Close asChild>
              <button type="button" className="button secondary">
                Close
              </button>
            </Dialog.Close>
            <Dialog.Close asChild>
              <button type="button" className="button" disabled={launching} onClick={onConfirm}>
                <PlayIcon />
                {launching ? "Launching..." : "Confirm launch"}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AgentCard({
  agent,
  tickets,
}: {
  agent: AgentSlot;
  tickets: TicketSummary[];
}) {
  const isIdle = tickets.length === 0;
  const { dotClass, statusText } = getAgentState(tickets);

  return (
    <article className="agent-card">
      <div className="agent-card-header">
        <div className="grid gap-3 min-w-0">
          <div className={dotClass} />
          <div>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              {agent.label}
            </p>
            <h3 className="agent-card-title">{agent.name}</h3>
            <p className="helper-copy">{agent.description}</p>
          </div>
        </div>
        <StatusBadge status={statusText} />
      </div>
      {isIdle ? (
        <EmptyState
          title="No active ticket"
          copy="This lane is open for another Linear ticket."
        />
      ) : (
        <div className="grid gap-3">
          {tickets.map((ticket) => (
            <div key={ticket.id} className="activity-row">
              <strong>{ticket.identifier}</strong>
              <p className="helper-copy">{ticket.title}</p>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export function RunsList({ runs }: { runs: RunListItem[] }) {
  if (runs.length === 0) {
    return (
      <EmptyState
        title="No exposed active runs"
        copy="This view populates when the API returns active run ids or when you open a specific run detail page directly."
      />
    );
  }

  return (
    <div className="grid gap-3">
      {runs.map((run) => (
        <article key={run.runId} className="run-card">
          <div className="run-layout">
            <div className="grid gap-3 min-w-0">
              <div className="flex flex-wrap gap-2.5">
                <span className="eyebrow">{run.ticketIdentifier}</span>
                <StatusBadge status={run.status} />
              </div>
              <h3 className="run-card-title">{run.ticketTitle}</h3>
              <div className="flex flex-wrap gap-2.5">
                <span className="metadata-copy">Stage: {run.stage}</span>
                <span className="metadata-copy">Updated: {formatRelativeTimestamp(run.updatedAt)}</span>
              </div>
            </div>
            <Link href={`/runs/${run.runId}`} className="button secondary">
              <ExternalLinkIcon />
              Open run
            </Link>
          </div>
        </article>
      ))}
    </div>
  );
}

export function TicketsTable({
  tickets,
  assignments,
  onAssign,
  onLaunch,
  launchingTicketId,
}: {
  tickets: TicketSummary[];
  assignments: Partial<Record<string, AgentId>>;
  onAssign: (ticketId: string, agentId: AgentId | null) => void;
  onLaunch: (ticketId: string) => void;
  launchingTicketId: string | null;
}) {
  return (
    <section className="table-panel">
      <div className="table-row is-header">
        <span>Ticket</span>
        <span>State</span>
        <span>Agent</span>
        <span>Action</span>
      </div>
      {tickets.map((ticket) => (
        <div key={ticket.id} className="table-row">
          <div>
            <div className="font-mono eyebrow">{ticket.identifier}</div>
            <strong>{ticket.title}</strong>
          </div>
          <StatusBadge status={ticket.state} />
          <select
            className="assign-select"
            value={assignments[ticket.id] ?? ""}
            onChange={(event) =>
              onAssign(ticket.id, (event.currentTarget.value || null) as AgentId | null)
            }
          >
            <option value="">Unassigned</option>
            <option value="agent-1">Agent 1</option>
            <option value="agent-2">Agent 2</option>
            <option value="agent-3">Agent 3</option>
            <option value="agent-4">Agent 4</option>
          </select>
          <div className="flex flex-wrap gap-2.5">
            {ticket.activeRunId ? (
              <Link href={`/runs/${ticket.activeRunId}`} className="button secondary">
                View run
              </Link>
            ) : (
              <button
                type="button"
                className="button"
                onClick={() => onLaunch(ticket.id)}
                disabled={launchingTicketId === ticket.id}
              >
                {launchingTicketId === ticket.id ? "Launching..." : "Launch"}
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

export function RunDetailTabs({
  run,
}: {
  run: RunDetails;
}) {
  const currentStage = run.events.at(-1)?.type ?? run.status.status;

  return (
    <Tabs.Root className="grid gap-4" defaultValue="timeline">
      <Tabs.List className="tabs-list" aria-label="Run detail sections">
        <Tabs.Trigger className="tabs-trigger" value="timeline">
          Timeline
        </Tabs.Trigger>
        <Tabs.Trigger className="tabs-trigger" value="summary">
          Summary
        </Tabs.Trigger>
        <Tabs.Trigger className="tabs-trigger" value="artifacts">
          Artifacts
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="timeline">
        <section className="timeline-panel">
          <SectionHeading
            title="Run timeline"
            subtitle="Events streamed from the active run folder."
          />
          {run.events.length === 0 ? (
            <EmptyState
              title="No events yet"
              copy="The run detail route is ready, but this run has not exposed event data yet."
            />
          ) : (
            <div className="grid gap-3">
              {run.events.map((event) => (
                <article key={`${event.ts}-${event.type}`} className="timeline-row">
                  <div className="flex flex-wrap gap-2.5">
                    <span className="font-mono">{formatRelativeTimestamp(event.ts)}</span>
                    <StatusBadge status={event.type} />
                  </div>
                  <strong>{event.message}</strong>
                </article>
              ))}
            </div>
          )}
        </section>
      </Tabs.Content>
      <Tabs.Content value="summary">
        <section className="panel">
          <SectionHeading title="Run summary" subtitle="Current status and GitHub handoff details." />
          <div className="grid gap-3">
            <div className="activity-row">
              <strong>Current stage</strong>
              <p className="helper-copy">{currentStage}</p>
            </div>
            <div className="activity-row">
              <strong>Sandbox</strong>
              <p className="helper-copy">{run.status.sandboxId ?? "Not attached yet"}</p>
            </div>
            <div className="activity-row">
              <strong>Branch</strong>
              <p className="helper-copy">{run.status.branchName ?? "No branch recorded yet"}</p>
            </div>
            <div className="activity-row">
              <strong>Draft PR</strong>
              <p className="helper-copy">{run.status.prUrl ?? "No PR URL recorded yet"}</p>
            </div>
          </div>
        </section>
      </Tabs.Content>
      <Tabs.Content value="artifacts">
        <section className="panel">
          <SectionHeading title="Artifacts" subtitle="Flat outputs expected in the local run folder." />
          <ul className="grid gap-2.5 p-0 m-0 list-none">
            {run.artifacts.map((artifact) => (
              <li key={artifact}>
                <span>{artifact}</span>
                <span className="artifact-copy">Awaiting API endpoint</span>
              </li>
            ))}
          </ul>
        </section>
      </Tabs.Content>
    </Tabs.Root>
  );
}

export function RunControls({
  busy,
  canCreatePr,
  onRetry,
  onCancel,
  onCreatePr,
}: {
  busy: boolean;
  canCreatePr: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onCreatePr: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2.5">
      <button type="button" className="button secondary" onClick={onRetry} disabled={busy}>
        <ReloadIcon />
        Retry
      </button>
      <button type="button" className="button danger" onClick={onCancel} disabled={busy}>
        <CrossCircledIcon />
        Cancel
      </button>
      <button type="button" className="button" onClick={onCreatePr} disabled={busy || !canCreatePr}>
        <ExternalLinkIcon />
        Create Draft PR
      </button>
    </div>
  );
}
