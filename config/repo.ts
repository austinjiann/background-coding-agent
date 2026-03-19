type VisualRoute = {
  label: string;
  path: string;
};

type VisualServiceConfig = {
  workingDirectory: string;
  startCommand: string;
  url: string;
  envVarNames: string[];
};

function parseCsv(value: string | undefined, fallback: string[]) {
  const raw = value?.trim();

  if (!raw) {
    return fallback;
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseVisualRoutes(value: string | undefined, fallback: VisualRoute[]) {
  const raw = value?.trim();

  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as VisualRoute[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export const TEST_REPO_CONFIG = {
  id: "test-repo",
  name: "Test Repo",
  defaultBranch: process.env.TEST_REPO_DEFAULT_BRANCH ?? "main",
  repoUrl: process.env.TEST_REPO_URL ?? "",
  workingDirectory: "/workspace/repo",
  smokeCommands: [
    "git rev-parse --abbrev-ref HEAD",
    "git status --short",
  ],
  visual: {
    enabled: process.env.TEST_REPO_VISUAL_ENABLED !== "false",
    uiGlobs: parseCsv(process.env.TEST_REPO_VISUAL_UI_GLOBS, ["frontend/**"]),
    routes: parseVisualRoutes(process.env.TEST_REPO_VISUAL_ROUTES, [
      {
        label: "Landing",
        path: "/",
      },
    ]),
    frontend: {
      workingDirectory: process.env.TEST_REPO_FRONTEND_DIR ?? "frontend",
      startCommand: process.env.TEST_REPO_FRONTEND_START_CMD ?? "npm run dev -- --host 0.0.0.0 --port 5173",
      url: process.env.TEST_REPO_FRONTEND_URL ?? "http://127.0.0.1:5173",
      envVarNames: parseCsv(process.env.TEST_REPO_FRONTEND_ENV_NAMES, [
        "VITE_BACKEND_URL",
        "VITE_SUPABASE_URL",
        "VITE_SUPABASE_PUBLIC_KEY",
      ]),
    } satisfies VisualServiceConfig,
  },
};
