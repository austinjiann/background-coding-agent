"use client";

import Link from "next/link";

import { useAgentAssignments } from "./AgentAssignmentsProvider";
import {
  AgentCardCompact,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  RunsList,
  SectionHeading,
  TicketCard,
} from "./dashboard-ui";
import { useTicketsQuery } from "./useFrontendData";
import { launchRun } from "../lib/api";
import { AGENT_SLOTS, type DashboardStats, type RunListItem } from "../lib/types";

export function DashboardPageClient() {
  const { assignments, assignTicket } = useAgentAssignments();
  const { data: tickets, isLoading, error, setData } = useTicketsQuery();
  const stats = getDashboardStats(tickets, assignments);
  const visibleTickets = tickets.slice(0, 4);
  const visibleRuns = getRunItems(tickets).slice(0, 4);

  async function handleLaunch(ticketId: string) {
    const run = await launchRun(ticketId);

    setData((current) =>
      current.map((ticket) =>
        ticket.id === ticketId ? { ...ticket, activeRunId: run.runId } : ticket,
      ),
    );
  }

  return (
    <>
      <PageHeader
        title="Monitor Lue Agent"
        stats={stats}
      />

      {/* Bento grid */}
      <div className="bento-grid">
        {/* Quick actions */}
        <section className="bento-cell bento-cta">
          <h2>Control room</h2>
          <p className="helper-copy">
            Turn Linear intake into active runs and fast handoffs across agents.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <Link href="/tickets" className="button">
              Review tickets
            </Link>
            <Link href="/agents" className="button secondary">
              Agent lanes
            </Link>
          </div>
        </section>

        {/* Agent lanes — compact */}
        {AGENT_SLOTS.slice(0, 4).map((agent) => (
          <AgentCardCompact
            key={agent.id}
            agent={agent}
            tickets={tickets.filter((ticket) => assignments[ticket.id] === agent.id)}
          />
        ))}

        {/* Tickets */}
        <section className="bento-cell bento-content-cell bento-tickets">
          <Link href="/tickets" className="button secondary bento-top-action">
            Open board
          </Link>
          <h2>Priority tickets</h2>
          <p className="helper-copy">First Linear tickets visible to the frontend.</p>
          {isLoading ? <LoadingState label="Loading tickets" /> : null}
          {error ? <ErrorState title="Ticket load failed" copy={error} /> : null}
          {!isLoading && !error && visibleTickets.length === 0 ? (
            <EmptyState
              title="No tickets returned"
              copy="Linear did not return any issues for the current API key."
            />
          ) : null}
          {!isLoading && !error && visibleTickets.length > 0 ? (
            <div className="grid gap-3">
              {visibleTickets.map((ticket) => (
                <TicketCard
                  key={ticket.id}
                  ticket={ticket}
                  assignedAgent={assignments[ticket.id]}
                  onAssign={assignTicket}
                  onLaunch={(ticketId) => {
                    void handleLaunch(ticketId);
                  }}
                />
              ))}
            </div>
          ) : null}
        </section>

        {/* Runs */}
        <section className="bento-cell bento-content-cell bento-runs">
          <Link href="/runs" className="button secondary bento-top-action">
            Open runs
          </Link>
          <h2>Active runs</h2>
          <p className="helper-copy">Recent runs exposed to the dashboard.</p>
          <RunsList runs={visibleRuns} />
        </section>
      </div>
    </>
  );
}

function getDashboardStats(
  tickets: { activeRunId?: string | null; state: string }[],
  assignments: Partial<Record<string, string>>,
): DashboardStats {
  return {
    openTickets: tickets.filter((ticket) => ticket.state.toLowerCase() !== "done").length,
    assignedTickets: Object.keys(assignments).length,
    activeRuns: tickets.filter((ticket) => Boolean(ticket.activeRunId)).length,
    draftPrs: 0,
  };
}

function getRunItems(
  tickets: Array<{ id: string; identifier: string; title: string; activeRunId?: string | null }>,
): RunListItem[] {
  return tickets
    .filter((ticket) => ticket.activeRunId)
    .map((ticket) => ({
      runId: ticket.activeRunId as string,
      ticketId: ticket.id,
      ticketIdentifier: ticket.identifier,
      ticketTitle: ticket.title,
      status: "running",
      stage: "active",
      updatedAt: null,
    }));
}
