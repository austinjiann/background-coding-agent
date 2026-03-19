"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  ErrorState,
  LoadingState,
  PageHeader,
  RunControls,
  RunDetailTabs,
  SectionHeading,
  StatusBadge,
} from "./dashboard-ui";
import { useRunQuery } from "./useFrontendData";
import { cancelRun, createDraftPr, retryRun } from "../lib/api";
import type { DashboardStats } from "../lib/types";

export function RunDetailPageClient({ runId }: { runId: string }) {
  const { data: run, isLoading, error, setData } = useRunQuery(runId);
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const currentStage = run?.events.at(-1)?.type ?? run?.status.status ?? "unknown";

  const stats: DashboardStats = {
    openTickets: run ? 1 : 0,
    assignedTickets: run ? 1 : 0,
    activeRuns: run && run.status.status === "running" ? 1 : 0,
    draftPrs: run?.status.prUrl ? 1 : 0,
  };

  function runAction(action: () => Promise<void>) {
    startTransition(async () => {
      try {
        await action();
      } catch (actionError) {
        setMessage(actionError instanceof Error ? actionError.message : "Action failed");
      }
    });
  }

  return (
    <>
      <PageHeader
        title={run ? `${run.status.ticketId}: ${run.ticket?.title ?? runId}` : `Run ${runId}`}
        subtitle="Inspect current state, event output, and expected artifacts for one active attempt."
        stats={stats}
      />
      {isLoading ? <LoadingState label="Loading run detail" /> : null}
      {error ? <ErrorState title="Run detail failed" copy={error} /> : null}
      {!isLoading && run ? (
        <>
          <section className="panel">
            <SectionHeading
              title="Run controls"
              subtitle="These controls call the frontend API helpers and optimistically refresh local state."
              action={<StatusBadge status={run.status.status} />}
            />
            <div className="grid gap-3">
              <div className="activity-row">
                <strong>Ticket</strong>
                <p className="helper-copy">{run.ticket?.identifier ?? run.status.ticketId}</p>
              </div>
              <div className="activity-row">
                <strong>Current stage</strong>
                <p className="helper-copy">{currentStage}</p>
              </div>
            </div>
            <div style={{ marginTop: 18 }}>
              <RunControls
                busy={isPending}
                canCreatePr={Boolean(run.status.branchName)}
                onRetry={() =>
                  runAction(async () => {
                    const nextRun = await retryRun(run.status.runId);
                    setMessage(`Retry requested for ${nextRun.runId}. Redirecting to the new run.`);
                    router.push(`/runs/${nextRun.runId}`);
                  })
                }
                onCancel={() =>
                  runAction(async () => {
                    await cancelRun(run.status.ticketId, run.status.runId);
                    setData({
                      ...run,
                      status: {
                        ...run.status,
                        status: "canceled",
                      },
                    });
                    setMessage(`Run ${run.status.runId} canceled.`);
                  })
                }
                onCreatePr={() =>
                  runAction(async () => {
                    const result = await createDraftPr(run.status.ticketId, run.status.runId);
                    setData({
                      ...run,
                      status: {
                        ...run.status,
                        prUrl: result.prUrl,
                        branchName: result.branchName,
                      },
                    });
                    setMessage(
                      result.prUrl
                        ? `Draft PR created: ${result.prUrl}`
                        : "Draft PR request submitted, but no URL was returned yet.",
                    );
                  })
                }
              />
            </div>
            {message ? <p className="helper-copy" style={{ marginTop: 14 }}>{message}</p> : null}
          </section>
          <RunDetailTabs run={run} />
        </>
      ) : null}
    </>
  );
}
