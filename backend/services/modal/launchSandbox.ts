import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TEST_REPO_CONFIG } from "../../../config/repo";
import { finalizeDraftPr } from "../github/finalizeDraftPr";
import { appendEvent } from "../runs/appendEvent";
import { getRun } from "../runs/getRun";
import { updateRun } from "../runs/updateRun";
import {
  getChangedFilesPath,
  getDiffPatchPath,
  getModalOutputPath,
  getOpenCodeOutputPath,
  getRunPath,
  getScreenshotsMetadataPath,
  getScreenshotsPath,
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
  branchName: string | null;
  branchPublished: boolean;
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
  result: unknown;
  cliOutput: string;
};

type ScreenshotArtifact = {
  filename: string;
  label: string;
  kind: "before" | "after";
  path: string;
  url: string;
  contentBase64: string;
};

type VisualVerificationResult = {
  ok: boolean;
  skipped: boolean;
  summary: string;
  screenshots: ScreenshotArtifact[];
  error?: string | null;
};

type ModalFunctionInvocation = {
  entrypoint: string;
  args: string[];
  resultKey?: string;
};

const activeModalProcesses = new Map<string, ChildProcessWithoutNullStreams>();
const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const modalEntrypointPath = path.join(repoRoot, "modal", "sandbox.py");
const modalSourcePath = path.join(repoRoot, "modal");
const LOG_MARKER_PREFIX = "PHOEBE_STEP:";

const LOG_MARKER_EVENTS: Record<string, { type: string; message: string }> = {
  "repo.clone.started": {
    type: "repo.cloning",
    message: "Cloning repository in Modal sandbox",
  },
  "repo.clone.completed": {
    type: "repo.cloned",
    message: "Repository clone completed",
  },
  "triage.started": {
    type: "triage.started",
    message: "Selecting model for the ticket",
  },
  "triage.completed": {
    type: "triage.completed",
    message: "Model selection completed",
  },
  "opencode.started": {
    type: "opencode.started",
    message: "OpenCode execution started",
  },
  "opencode.completed": {
    type: "opencode.completed",
    message: "OpenCode execution finished",
  },
  "branch.publishing": {
    type: "branch.publishing",
    message: "Publishing branch to GitHub",
  },
  "branch.published": {
    type: "branch.published",
    message: "Branch publication completed",
  },
  "screenshots.started": {
    type: "screenshots.started",
    message: "Visual verification started",
  },
  "screenshots.completed": {
    type: "screenshots.completed",
    message: "Visual verification completed",
  },
  "screenshots.skipped": {
    type: "screenshots.skipped",
    message: "Visual verification skipped",
  },
};

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

function getModalFunctionResultPath(ticketId: string, runId: string, resultKey = "result") {
  return path.join(getRunPath(ticketId, runId), `.modal-${resultKey}.json`);
}

function globToRegExp(glob: string) {
  const regexSource = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§DOUBLE_STAR§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§DOUBLE_STAR§§/g, ".*");
  return new RegExp(`^${regexSource}$`);
}

function matchesVisualGlobs(paths: string[]) {
  if (!TEST_REPO_CONFIG.visual.enabled) {
    return false;
  }

  const globs = TEST_REPO_CONFIG.visual.uiGlobs.map(globToRegExp);
  return paths.some((filePath) => globs.some((glob) => glob.test(filePath)));
}

function collectEnvValues(envVarNames: string[]) {
  return Object.fromEntries(
    envVarNames
      .map((name) => [name, process.env[name]?.trim() ?? ""])
      .filter(([, value]) => value),
  );
}

function collectVisualRuntimeConfig() {
  return {
    frontend: TEST_REPO_CONFIG.visual.frontend,
    routes: TEST_REPO_CONFIG.visual.routes,
  };
}

function collectR2EnvValues() {
  return collectEnvValues([
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "R2_PUBLIC_URL",
  ]);
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

async function writeScreenshotArtifacts(
  ticketId: string,
  runId: string,
  screenshots: ScreenshotArtifact[],
) {
  const screenshotsPath = getScreenshotsPath(ticketId, runId);
  await mkdir(screenshotsPath, { recursive: true });

  await Promise.all(
    screenshots.map((screenshot) =>
      writeFile(
        path.join(screenshotsPath, screenshot.filename),
        Buffer.from(screenshot.contentBase64, "base64"),
      ),
    ),
  );

  await writeFile(
    getScreenshotsMetadataPath(ticketId, runId),
    JSON.stringify(
      {
        screenshots: screenshots.map(({ contentBase64, ...metadata }) => metadata),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function shouldRunScreenshots(changedFiles: ChangedFile[]) {
  return matchesVisualGlobs(changedFiles.map((file) => file.path));
}

async function runVisualVerification(
  input: LaunchSandboxInput,
  branchName: string,
): Promise<VisualVerificationResult | null> {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  const githubToken = process.env.GITHUB_TOKEN ?? "";
  const visualEnv = collectEnvValues(TEST_REPO_CONFIG.visual.frontend.envVarNames);
  const r2Env = collectR2EnvValues();

  return runModalFunction<VisualVerificationResult>(input, {
    entrypoint: "run_visual_verification",
    resultKey: "screenshots",
    args: [
      "--ticket-id",
      input.ticketId,
      "--run-id",
      input.runId,
      "--ticket-title",
      input.ticketTitle,
      "--ticket-description",
      input.ticketDescription,
      "--repo-url",
      TEST_REPO_CONFIG.repoUrl.trim(),
      "--default-branch",
      TEST_REPO_CONFIG.defaultBranch,
      "--branch-name",
      branchName,
      "--pr-url",
      "",
      "--github-token",
      githubToken,
      "--anthropic-api-key",
      anthropicApiKey,
      "--visual-config-json",
      JSON.stringify(collectVisualRuntimeConfig()),
      "--visual-env-json",
      JSON.stringify(visualEnv),
      "--r2-env-json",
      JSON.stringify(r2Env),
    ],
  }).then(({ result }) => result);
}

async function appendModalLogChunk(ticketId: string, runId: string, chunk: string) {
  if (!chunk) {
    return;
  }

  await appendFile(getModalOutputPath(ticketId, runId), chunk, "utf8");
}

async function appendEventsForMarkers(runId: string, chunk: string, seenMarkers: Set<string>) {
  const lines = chunk.split("\n");

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (!trimmedLine.startsWith(LOG_MARKER_PREFIX)) {
      continue;
    }

    const marker = trimmedLine.slice(LOG_MARKER_PREFIX.length).trim();

    if (!marker || seenMarkers.has(marker)) {
      continue;
    }

    seenMarkers.add(marker);
    const eventInfo = LOG_MARKER_EVENTS[marker];

    if (!eventInfo) {
      continue;
    }

    await appendEvent(runId, {
      ts: new Date().toISOString(),
      type: eventInfo.type,
      message: eventInfo.message,
    });
  }
}

async function runModalFunction<T>(input: LaunchSandboxInput, invocation: ModalFunctionInvocation): Promise<{
  result: T | null;
  cliOutput: string;
}> {
  const repoUrl = TEST_REPO_CONFIG.repoUrl.trim();
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";

  if (!repoUrl) {
    throw new Error("TEST_REPO_URL is not configured");
  }

  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const resultPath = getModalFunctionResultPath(input.ticketId, input.runId, invocation.resultKey);
  const modalBinary = process.env.MODAL_BIN ?? "modal";
  const modalArgs = [
    "run",
    "--write-result",
    resultPath,
    `${modalEntrypointPath}::${invocation.entrypoint}`,
    ...invocation.args,
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
  let writeQueue = Promise.resolve();
  const seenMarkers = new Set<string>();
  const handleChunk = (rawChunk: Buffer) => {
    const chunk = rawChunk.toString();
    cliOutput += chunk;
    writeQueue = writeQueue
      .then(() => appendModalLogChunk(input.ticketId, input.runId, chunk))
      .then(() => appendEventsForMarkers(input.runId, chunk, seenMarkers))
      .catch(() => undefined);
  };
  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);

  const exitState = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    },
  );

  await writeQueue;

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
    result: JSON.parse(resultRaw) as T,
    cliOutput,
  };
}

async function runModalCommand(input: LaunchSandboxInput): Promise<{ result: ModalAgentResult | null; cliOutput: string }> {
  const githubToken = process.env.GITHUB_TOKEN ?? "";
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  const triageModelId = process.env.TRIAGE_MODEL_ID ?? DEFAULT_TRIAGE_MODEL_ID;
  const simpleModelId = process.env.SIMPLE_MODEL_ID ?? DEFAULT_SIMPLE_MODEL_ID;
  const complexModelId = process.env.COMPLEX_MODEL_ID ?? DEFAULT_COMPLEX_MODEL_ID;

  return runModalFunction<ModalAgentResult>(input, {
    entrypoint: "run_opencode",
    resultKey: "opencode",
    args: [
      "--ticket-id",
      input.ticketId,
      "--run-id",
      input.runId,
      "--ticket-title",
      input.ticketTitle,
      "--ticket-description",
      input.ticketDescription,
      "--repo-url",
      TEST_REPO_CONFIG.repoUrl.trim(),
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
    ],
  });
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

  if (result.branchPublished && result.branchName) {
    await appendEvent(input.runId, {
      ts: new Date().toISOString(),
      type: "branch.published",
      message: `Published branch ${result.branchName}`,
    });
  } else if (result.branchName) {
    await appendEvent(input.runId, {
      ts: new Date().toISOString(),
      type: "branch.publish_failed",
      message: `Failed to publish branch ${result.branchName}`,
    });
  }

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
      branchName: result.branchPublished ? result.branchName : null,
      error: null,
    });

    const visualChangesDetected = shouldRunScreenshots(result.changedFiles.files);

    if (result.branchPublished && result.branchName && visualChangesDetected) {
      await appendEvent(input.runId, {
        ts: new Date().toISOString(),
        type: "screenshots.started",
        message: "Starting visual verification for UI changes",
      });

      try {
        const screenshotResult = await runVisualVerification(input, result.branchName);

        if (screenshotResult?.skipped) {
          await appendEvent(input.runId, {
            ts: new Date().toISOString(),
            type: "screenshots.skipped",
            message: screenshotResult.summary || "Visual verification was skipped",
          });
        } else if (screenshotResult?.ok && screenshotResult.screenshots.length > 0) {
          await writeScreenshotArtifacts(input.ticketId, input.runId, screenshotResult.screenshots);
          await appendEvent(input.runId, {
            ts: new Date().toISOString(),
            type: "screenshots.completed",
            message: `Captured ${screenshotResult.screenshots.length} screenshots`,
          });
          await updateRun(input.runId, {
            error: null,
          });
        } else if (screenshotResult) {
          const screenshotError = screenshotResult.error?.trim() || "Visual verification failed";
          await appendEvent(input.runId, {
            ts: new Date().toISOString(),
            type: "screenshots.failed",
            message: screenshotError,
          });
          await updateRun(input.runId, {
            error: screenshotError,
          });
        }
      } catch (error) {
        const screenshotError = error instanceof Error ? error.message : "Visual verification failed";
        await appendEvent(input.runId, {
          ts: new Date().toISOString(),
          type: "screenshots.failed",
          message: screenshotError,
        });
        await updateRun(input.runId, {
          error: screenshotError,
        });
      }
    } else {
      const skipMessage = !result.branchPublished || !result.branchName
        ? "Visual verification skipped because no review branch was published"
        : "No UI changes detected for visual verification";
      await appendEvent(input.runId, {
        ts: new Date().toISOString(),
        type: "screenshots.skipped",
        message: skipMessage,
      });
    }

    if (result.branchPublished && result.branchName) {
      try {
        await finalizeDraftPr({
          ticketId: input.ticketId,
          runId: input.runId,
        });
      } catch {
        // The finalizeDraftPr helper already recorded pr.failed and updated status.error.
      }
    }

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
    branchName: result.branchPublished ? result.branchName : null,
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
