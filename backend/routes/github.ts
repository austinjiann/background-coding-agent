import type { Hono } from "hono";

import { finalizeDraftPr } from "../services/github/finalizeDraftPr";

type CreateDraftPrBody = {
  ticketId?: unknown;
  runId?: unknown;
};

export function registerGitHubRoutes(app: Hono) {
  app.post("/github/draft-pr", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as CreateDraftPrBody;
    const ticketId = typeof body.ticketId === "string" ? body.ticketId.trim() : "";
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";

    if (!ticketId || !runId) {
      return c.json({ error: "ticketId and runId are required" }, 400);
    }

    try {
      const prPayload = await finalizeDraftPr({ ticketId, runId });
      return c.json(prPayload, prPayload.status === "created" ? 201 : 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Draft PR creation failed";
      return c.json({ error: message }, 400);
    }
  });
}
