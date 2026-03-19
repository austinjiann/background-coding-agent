import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TEST_REPO_CONFIG } from "../../../config/repo";
import { appendEvent } from "../runs/appendEvent";
import { getRun } from "../runs/getRun";
import { updateRun } from "../runs/updateRun";
import {
  getChangedFilesPath,
  getDiffPatchPath,
  getOpenCodeOutputPath,
  getRunPath,
  getSummaryPath,
  getTestOutputPath,
  getTestResultsPath,
} from "../../utils/paths";

const DEFAULT_TRIAGE_MODEL_ID = "claude-haiku-4-5-20251001";
const DEFAULT_SIMPLE_MODEL_ID = "anthropic/claude-sonnet-4-6";
const DEFAULT_COMPLEX_MODEL_ID = "anthropic/claude-opus-4-6";

type LaunchSandboxInput = {
  ticketId: string;
  runId: string;
  ticketTitle: string;
  ticketDescription: string;
};

type ChangedFile = {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
};

type TestCommandResult = {
  command: string;
  status: "passed" | "failed";
  exitCode?: number;
};

type ModalAgentResult = {
  ok: boolean;
  sandboxId: string;
  summary: string;
  triageLabel: "simple" | "complex";
  selectedModel: string;
  changedFiles: {
    files: ChangedFile[];
  };
  diffText: string;
  testResults: {
    summary: {
      passed: number;
      failed: number;
    };
    commands: TestCommandResult[];
  };
  testOutput: string;
  opencodeOutput: string;
  error?: string | null;
};

type ModalRunOutput = {
  result: ModalAgentResult | null;
  cliOutput: string;
};

const activeModalProcesses = new Map<string, ChildProcessWithoutNullStreams>();
const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const modalEntrypointPath = path.join(repoRoot, "modal", "sandbox.py");
const modalSourcePath = path.join(repoRoot, "modal");

async function isCanceled(runId: string) {
  const run = await getRun(runId);
  return run.status.status === "canceled";
}

function buildPythonPath() {
  const existingPythonPath = process.env.PYTHONPATH?.trim();
  return existingPythonPath
    ? `${modalSourcePath}${path.delimiter}${existingPythonPath}`
    : modalSourcePath;
}

function getModalResultPath(ticketId: string, runId: string) {
  return path.join(getRunPath(ticketId, runId), ".modal-result.json");
}

async function writeFailureArtifacts(ticketId: string, runId: string, message: string) {
  await Promise.all([
    writeFile(
      getSummaryPath(ticketId, runId),
      ["# Run Summary", "", "OpenCode run failed.", "", message].join("\n"),
      "utf8",
    ),
    writeFile(getChangedFilesPath(ticketId, runId), JSON.stringify({ files: [] }, null, 2), "utf8"),
    writeFile(getDiffPatchPath(ticketId, runId), "", "utf8"),
    writeFile(getOpenCodeOutputPath(ticketId, runId), "", "utf8"),
    writeFile(
      getTestResultsPath(ticketId, runId),
      JSON.stringify(
        {
          summary: {
            passed: 0,
            failed: 1,
          },
          commands: [],
        },
        null,
        2,
      ),
      "utf8",
    ),
    writeFile(getTestOutputPath(ticketId, runId), `${message}\n`, "utf8"),
  ]);
}

async function writeSuccessArtifacts(ticketId: string, runId: string, result: ModalAgentResult) {
  await appendEvent(runId, {
    ts: new Date().toISOString(),
    type: "sandbox.completed",
    message: "Modal OpenCode run finished",
  });

  await Promise.all([
    writeFile(getSummaryPath(ticketId, runId), `# Run Summary\n\n${result.summary}\n`, "utf8"),
    writeFile(getChangedFilesPath(ticketId, runId), JSON.stringify(result.changedFiles, null, 2), "utf8"),
    writeFile(getDiffPatchPath(ticketId, runId), result.diffText, "utf8"),
    writeFile(getOpenCodeOutputPath(ticketId, runId), result.opencodeOutput, "utf8"),
    writeFile(getTestResultsPath(ticketId, runId), JSON.stringify(result.testResults, null, 2), "utf8"),
    writeFile(getTestOutputPath(ticketId, runId), result.testOutput, "utf8"),
  ]);
}

async function runModalCommand(input: LaunchSandboxInput): Promise<ModalRunOutput> {
  const repoUrl = TEST_REPO_CONFIG.repoUrl.trim();
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";

  if (!repoUrl) {
    throw new Error("TEST_REPO_URL is not configured");
  }

  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const resultPath = getModalResultPath(input.ticketId, input.runId);
  const modalBinary = process.env.MODAL_BIN ?? "modal";
  const githubToken = process.env.GITHUB_TOKEN ?? "";
  const triageModelId = process.env.TRIAGE_MODEL_ID ?? DEFAULT_TRIAGE_MODEL_ID;
  const simpleModelId = process.env.SIMPLE_MODEL_ID ?? DEFAULT_SIMPLE_MODEL_ID;
  const complexModelId = process.env.COMPLEX_MODEL_ID ?? DEFAULT_COMPLEX_MODEL_ID;
  const modalArgs = [
    "run",
    "--quiet",
    "--write-result",
    resultPath,
    `${modalEntrypointPath}::run_opencode`,
    "--ticket-id",
    input.ticketId,
    "--run-id",
    input.runId,
    "--ticket-title",
    input.ticketTitle,
    "--ticket-description",
    input.ticketDescription,
    "--repo-url",
    repoUrl,
    "--default-branch",
    TEST_REPO_CONFIG.defaultBranch,
    "--github-token",
    githubToken,
    "--anthropic-api-key",
    anthropicApiKey,
    "--triage-model-id",
    triageModelId,
    "--simple-model-id",
    simpleModelId,
    "--complex-model-id",
    complexModelId,
  ];
  const child = spawn(modalBinary, modalArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: buildPythonPath(),
    },
  });
  activeModalProcesses.set(input.runId, child);

  let cliOutput = "";
  child.stdout.on("data", (chunk) => {
    cliOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    cliOutput += chunk.toString();
  });

  const exitState = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    },
  );

  activeModalProcesses.delete(input.runId);

  if (await isCanceled(input.runId)) {
    await rm(resultPath, { force: true }).catch(() => undefined);
    return {
      result: null,
      cliOutput,
    };
  }

  const resultRaw = await readFile(resultPath, "utf8").catch(() => "");
  await rm(resultPath, { force: true }).catch(() => undefined);

  if (!resultRaw.trim()) {
    const failureMessage = [
      "Modal run exited before writing a result file.",
      `exitCode=${String(exitState.code)}`,
      exitState.signal ? `signal=${exitState.signal}` : null,
      cliOutput.trim() ? "" : null,
      cliOutput.trim() || null,
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(failureMessage);
  }

  return {
    result: JSON.parse(resultRaw) as ModalAgentResult,
    cliOutput,
  };
}

async function runModalExecutor(input: LaunchSandboxInput): Promise<void> {
  await appendEvent(input.runId, {
    ts: new Date().toISOString(),
    type: "sandbox.starting",
    message: "Launching Modal OpenCode run",
  });
  await updateRun(input.runId, {
    status: "running",
    sandboxId: `modal-run:${input.runId}`,
  });
  await appendEvent(input.runId, {
    ts: new Date().toISOString(),
    type: "sandbox.ready",
    message: "Modal OpenCode run started",
  });
  await appendEvent(input.runId, {
    ts: new Date().toISOString(),
    type: "agent.running",
    message: "Remote OpenCode task is running",
  });

  const { result, cliOutput } = await runModalCommand(input);

  if (await isCanceled(input.runId)) {
    await appendEvent(input.runId, {
      ts: new Date().toISOString(),
      type: "run.stopped",
      message: "Run stopped before Modal results were written locally",
    });
    return;
  }

  if (!result) {
    await appendEvent(input.runId, {
      ts: new Date().toISOString(),
      type: "run.stopped",
      message: "Run stopped before Modal finished",
    });
    return;
  }

  await writeSuccessArtifacts(input.ticketId, input.runId, result);

  if (result.ok) {
    await appendEvent(input.runId, {
      ts: new Date().toISOString(),
      type: "tests.passed",
      message: "OpenCode task completed and reported passing tests",
    });
    await updateRun(input.runId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      sandboxId: result.sandboxId,
      triageLabel: result.triageLabel,
      selectedModel: result.selectedModel,
      error: null,
    });
    return;
  }

  const failureMessage = result.error?.trim() || cliOutput.trim() || "OpenCode run failed";
  await appendEvent(input.runId, {
    ts: new Date().toISOString(),
    type: "tests.failed",
    message: "OpenCode task completed with failing tests or errors",
  });
  await updateRun(input.runId, {
    status: "failed",
    sandboxId: result.sandboxId,
    triageLabel: result.triageLabel,
    selectedModel: result.selectedModel,
    error: failureMessage,
  });
}

export async function cancelSandboxRun(runId: string): Promise<boolean> {
  const activeProcess = activeModalProcesses.get(runId);

  if (!activeProcess) {
    return false;
  }

  activeProcess.kill("SIGTERM");
  setTimeout(() => {
    if (!activeProcess.killed) {
      activeProcess.kill("SIGKILL");
    }
  }, 2000).unref();

  return true;
}

export async function launchSandbox(input: LaunchSandboxInput): Promise<void> {
  void runModalExecutor(input).catch(async (error) => {
    const message = error instanceof Error ? error.message : "Modal OpenCode run failed";

    await writeFailureArtifacts(input.ticketId, input.runId, message).catch(() => undefined);
    await appendEvent(input.runId, {
      ts: new Date().toISOString(),
      type: "run.failed",
      message,
    }).catch(() => undefined);
    await updateRun(input.runId, {
      status: "failed",
      error: message,
    }).catch(() => undefined);
  });
}
