"use client";

import { useAgentAssignments } from "./AgentAssignmentsProvider";
import { AgentCard, EmptyState, ErrorState, LoadingState, PageHeader } from "./dashboard-ui";
import { useTicketsQuery } from "./useFrontendData";
import { AGENT_SLOTS, type DashboardStats } from "../lib/types";

export function AgentsPageClient() {
  const { assignments } = useAgentAssignments();
  const { data: tickets, isLoading, error } = useTicketsQuery();
  const stats = getStats(tickets, assignments);

  return (
    <>
      <PageHeader
        title="Agent lanes"
        stats={stats}
      />
      {isLoading ? <LoadingState label="Loading ticket assignments" /> : null}
      {error ? <ErrorState title="Could not build agent lanes" copy={error} /> : null}
      {!isLoading && !error && tickets.length === 0 ? (
        <EmptyState
          title="No tickets to group"
          copy="Once Linear returns tickets, each assigned slot will render here."
        />
      ) : null}
      {!isLoading && !error && tickets.length > 0 ? (
        <div className="surface-grid columns-2">
          {AGENT_SLOTS.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              tickets={tickets.filter((ticket) => assignments[ticket.id] === agent.id)}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function getStats(
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
