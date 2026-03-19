import { Hono } from "hono";
import { cors } from "hono/cors";

import { registerLinearRoutes } from "./routes/linear";
import { registerRunRoutes } from "./routes/runs";

declare const Bun: {
  serve(options: {
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): { port: number };
};

export const app = new Hono();

app.use("*", cors());

app.get("/health", (c) => {
  return c.json({
    ok: true,
  });
});

registerLinearRoutes(app);
registerRunRoutes(app);

app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

app.onError((error, c) => {
  console.error(error);
  return c.json(
    {
      error: error instanceof Error ? error.message : "Unknown error",
    },
    500,
  );
});

if (import.meta.main) {
  const port = Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 3001);
  const server = Bun.serve({
    port,
    fetch: app.fetch,
  });

  console.log(`Phoebe backend listening on http://localhost:${server.port}`);
}
