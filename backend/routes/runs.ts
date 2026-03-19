import { readFile, writeFile } from "node:fs/promises";

import type { Hono } from "hono";

import { fetchLinearIssueByTicketId } from "../services/linear/client";
import { cancelSandboxRun, launchSandbox } from "../services/modal/launchSandbox";
import { appendEvent, type RunEvent } from "../services/runs/appendEvent";
import { createRun } from "../services/runs/createRun";
import { getRun } from "../services/runs/getRun";
import { updateRun } from "../services/runs/updateRun";
import { findRunPathByRunId, getEventsPath, getTicketSnapshotPath } from "../utils/paths";

type CreateRunBody = {
  ticketId?: unknown;
};

export function registerRunRoutes(app: Hono) {
  app.post("/runs", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as CreateRunBody;
      const ticketId = typeof body.ticketId === "string" ? body.ticketId.trim() : "";

      if (!ticketId) {
        return c.json({ error: "ticketId is required" }, 400);
      }

      const issue = await fetchLinearIssueByTicketId(ticketId);
      const run = await createRun(issue.identifier);
      await writeFile(
        getTicketSnapshotPath(issue.identifier, run.runId),
        JSON.stringify(issue, null, 2),
        "utf8",
      );
      await appendEvent(run.runId, {
        ts: new Date().toISOString(),
        type: "run.started",
        message: "Run created",
      });
      void launchSandbox({
        ticketId: issue.identifier,
        runId: run.runId,
        ticketTitle: issue.title,
        ticketDescription: issue.description,
      });

      return c.json({ runId: run.runId }, 201);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  app.get("/runs/:runId", async (c) => {
    const runId = c.req.param("runId");

    try {
      const run = await getRun(runId);
      return c.json(run);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  app.get("/runs/:runId/events", async (c) => {
    const runId = c.req.param("runId");

    try {
      const location = await findRunPathByRunId(runId);
      if (!location) {
        return c.json({ error: `Run ${runId} not found` }, 404);
      }

      const raw = await readFile(getEventsPath(location.ticketId, runId), "utf8").catch(() => "");
      const events: RunEvent[] = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunEvent);

      return c.json(events);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  app.post("/runs/:runId/retry", async (c) => {
    const runId = c.req.param("runId");

    try {
      const existingRun = await getRun(runId);
      const issue =
        (await fetchLinearIssueByTicketId(existingRun.status.ticketId).catch(() => null)) ??
        existingRun.ticket;

      if (!issue) {
        return c.json({ error: `Linear issue ${existingRun.status.ticketId} not found` }, 404);
      }

      const newRun = await createRun(issue.identifier);
      await writeFile(
        getTicketSnapshotPath(issue.identifier, newRun.runId),
        JSON.stringify(issue, null, 2),
        "utf8",
      );

      await appendEvent(newRun.runId, {
        ts: new Date().toISOString(),
        type: "run.started",
        message: "Retry run created",
        data: { previousRunId: runId },
      });
      await appendEvent(newRun.runId, {
        ts: new Date().toISOString(),
        type: "run.retried_from",
        message: `Retried from ${runId}`,
        data: { previousRunId: runId },
      });

      void launchSandbox({
        ticketId: issue.identifier,
        runId: newRun.runId,
        ticketTitle: issue.title,
        ticketDescription: issue.description,
      });

      return c.json({ runId: newRun.runId }, 201);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  app.post("/runs/:runId/cancel", async (c) => {
    const runId = c.req.param("runId");

    try {
      const existingRun = await getRun(runId);

      if (existingRun.status.status === "completed" || existingRun.status.status === "canceled") {
        return c.json(existingRun.status);
      }

      await cancelSandboxRun(runId).catch(() => false);
      const canceledRun = await updateRun(runId, {
        status: "canceled",
        canceledAt: new Date().toISOString(),
      });

      await appendEvent(runId, {
        ts: new Date().toISOString(),
        type: "run.canceled",
        message: "Run canceled",
      });

      return c.json(canceledRun);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });
}
