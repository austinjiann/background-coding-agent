"""Modal OpenCode entrypoint for Phoebe."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import modal

app = modal.App("phoebe-opencode")
opencode_image = (
    modal.Image.debian_slim()
    .apt_install("git", "curl", "ca-certificates")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
        "npm install -g opencode-ai",
    )
    .pip_install("anthropic")
)

WORKSPACE_ROOT = Path("/workspace")
REPO_PATH = WORKSPACE_ROOT / "repo"
ARTIFACT_DIR_NAME = ".phoebe_artifacts"


def _format_command(command: list[str]) -> str:
    return " ".join(command)


def _build_clone_url(repo_url: str, github_token: str) -> str:
    if not github_token or not repo_url.startswith("https://github.com/"):
        return repo_url

    parsed = urlsplit(repo_url)
    auth_netloc = f"x-access-token:{quote(github_token, safe='')}@{parsed.netloc}"
    return urlunsplit((parsed.scheme, auth_netloc, parsed.path, parsed.query, parsed.fragment))


def _run_command(
    command: list[str],
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
) -> tuple[dict[str, object], str, str, str]:
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            check=False,
            env=env,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        command_output = "\n".join(
            part
            for part in [
                f"$ {_format_command(command)}",
                (error.stdout or "").strip(),
                (error.stderr or "").strip(),
                f"Command timed out after {timeout}s",
            ]
            if part
        ).strip()
        return (
            {
                "command": _format_command(command),
                "status": "failed",
                "exitCode": 124,
            },
            command_output,
            (error.stdout or "").strip(),
            (error.stderr or "").strip(),
        )
    stdout_text = completed.stdout.strip()
    stderr_text = completed.stderr.strip()
    command_output = "\n".join(
        part
        for part in [
            f"$ {_format_command(command)}",
            stdout_text,
            stderr_text,
        ]
        if part
    ).strip()

    result = {
        "command": _format_command(command),
        "status": "passed" if completed.returncode == 0 else "failed",
        "exitCode": completed.returncode,
    }
    return result, command_output, stdout_text, stderr_text


def _read_text(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def _read_json(path: Path) -> dict[str, object] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def _get_artifact_paths() -> tuple[Path, Path, Path]:
    artifact_root = REPO_PATH / ARTIFACT_DIR_NAME
    return (
        artifact_root,
        artifact_root / "summary.md",
        artifact_root / "test-results.json",
    )


def _extract_text_fragments(value: object) -> list[str]:
    fragments: list[str] = []
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            fragments.append(stripped)
        return fragments
    if isinstance(value, list):
        for item in value:
            fragments.extend(_extract_text_fragments(item))
        return fragments
    if isinstance(value, dict):
        for item in value.values():
            fragments.extend(_extract_text_fragments(item))
    return fragments


def _extract_summary_from_events(events: list[dict[str, object]]) -> str:
    for event in reversed(events):
        event_text = json.dumps(event).lower()
        if "assistant" not in event_text:
            continue
        fragments = _extract_text_fragments(event)
        if fragments:
            return "\n".join(fragments[-5:]).strip()
    return ""


def _extract_test_commands_from_events(events: list[dict[str, object]]) -> list[dict[str, object]]:
    commands: list[dict[str, object]] = []
    for event in events:
        serialized = json.dumps(event).lower()
        if "test" not in serialized and "pytest" not in serialized:
            continue
        command = None
        status = None
        exit_code = None
        if isinstance(event, dict):
            command = event.get("command") or event.get("cmd")
            status = event.get("status")
            exit_code = event.get("exitCode") or event.get("exit_code")
        if isinstance(command, str):
            commands.append(
                {
                    "command": command,
                    "status": status if isinstance(status, str) else "passed",
                    "exitCode": exit_code if isinstance(exit_code, int) else 0,
                }
            )
    return commands


def _parse_opencode_events(raw_output: str) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    for line in raw_output.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


def _parse_changed_files(status_output: str, numstat_output: str) -> list[dict[str, object]]:
    stats_by_path: dict[str, tuple[int | None, int | None]] = {}
    for line in numstat_output.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        additions_raw, deletions_raw, path = parts
        additions = None if additions_raw == "-" else int(additions_raw)
        deletions = None if deletions_raw == "-" else int(deletions_raw)
        stats_by_path[path] = (additions, deletions)

    files: list[dict[str, object]] = []
    for line in status_output.splitlines():
        if not line.strip():
            continue
        status_code = line[:2]
        raw_path = line[3:].strip()
        path = raw_path.split(" -> ")[-1]
        additions, deletions = stats_by_path.get(path, (None, None))
        entry: dict[str, object] = {
            "path": path,
            "status": status_code,
        }
        if additions is not None:
            entry["additions"] = additions
        if deletions is not None:
            entry["deletions"] = deletions
        files.append(entry)
    return files


def classify_task(
    *,
    ticket_title: str,
    ticket_description: str,
    anthropic_api_key: str,
    triage_model_id: str,
) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=anthropic_api_key)
    prompt = f"""
Classify this software task as either simple or complex.

Return exactly one word: simple or complex.

Consider:
- roughly how many files are likely to change
- whether this is investigation/debugging versus a mechanical edit
- whether this looks like a new feature versus a small fix or rename

Ticket title:
{ticket_title}

Ticket description:
{ticket_description}
""".strip()
    response = client.messages.create(
        model=triage_model_id,
        max_tokens=32,
        messages=[{"role": "user", "content": prompt}],
    )
    text = " ".join(
        block.text
        for block in response.content
        if getattr(block, "type", None) == "text"
    ).lower()
    return "complex" if "complex" in text else "simple"


def _build_task_prompt(ticket_id: str, ticket_title: str, ticket_description: str) -> str:
    artifact_root, summary_path, test_results_path = _get_artifact_paths()
    return f"""
You are working on ticket {ticket_id}: {ticket_title}

## Task
{ticket_description}

## Instructions
1. Read the codebase to understand the project structure before making changes.
2. Implement the requested change.
3. Discover and run existing automated tests.
4. If tests fail, keep iterating until they pass or clearly explain why they cannot pass.
5. Do not commit, push, or create branches.
6. Before finishing, write a concise markdown summary to {summary_path}.
7. Before finishing, write test results JSON to {test_results_path} using:
   {{"summary": {{"passed": <number>, "failed": <number>}}, "commands": [{{"command": "...", "status": "passed|failed"}}]}}
8. Create the directory {artifact_root} first if it does not already exist.
9. End with a concise final summary.
""".strip()


def run_opencode_job(
    *,
    ticket_id: str,
    run_id: str,
    ticket_title: str,
    ticket_description: str,
    repo_url: str,
    default_branch: str,
    github_token: str,
    anthropic_api_key: str,
    triage_model_id: str,
    simple_model_id: str,
    complex_model_id: str,
) -> dict[str, object]:
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    if REPO_PATH.exists():
        shutil.rmtree(REPO_PATH)

    commands: list[dict[str, object]] = []
    output_chunks: list[str] = []

    clone_command = [
        "git",
        "clone",
        "--branch",
        default_branch,
        "--single-branch",
        _build_clone_url(repo_url, github_token),
        str(REPO_PATH),
    ]
    clone_result, clone_output, _, _ = _run_command(clone_command)
    commands.append(clone_result)
    output_chunks.append(clone_output)

    if clone_result["status"] != "passed":
        return {
            "ok": False,
            "sandboxId": f"modal-opencode:{run_id}",
            "summary": f"OpenCode run failed while cloning {repo_url}.",
            "triageLabel": "complex",
            "selectedModel": complex_model_id,
            "changedFiles": {"files": []},
            "diffText": "",
            "testResults": {
                "summary": {"passed": 0, "failed": 1},
                "commands": commands,
            },
            "testOutput": "\n\n".join(chunk for chunk in output_chunks if chunk),
            "opencodeOutput": "",
            "error": "git clone failed",
        }

    triage_label = classify_task(
        ticket_title=ticket_title,
        ticket_description=ticket_description,
        anthropic_api_key=anthropic_api_key,
        triage_model_id=triage_model_id,
    )
    selected_model = simple_model_id if triage_label == "simple" else complex_model_id
    artifact_root, summary_path, test_results_path = _get_artifact_paths()
    if artifact_root.exists():
        shutil.rmtree(artifact_root)

    opencode_env = {
        **dict(os.environ),
        "ANTHROPIC_API_KEY": anthropic_api_key,
        "CI": "1",
    }
    prompt = _build_task_prompt(ticket_id, ticket_title, ticket_description)
    opencode_command = [
        "opencode",
        "run",
        prompt,
        "--format",
        "json",
        "--model",
        selected_model,
        "--dir",
        str(REPO_PATH),
    ]
    opencode_result, opencode_log_output, opencode_stdout, opencode_stderr = _run_command(
        opencode_command,
        env=opencode_env,
        timeout=600,
    )
    commands.append(opencode_result)
    output_chunks.append(opencode_log_output)

    events = _parse_opencode_events(opencode_stdout)
    summary = _read_text(summary_path) or _extract_summary_from_events(events)
    parsed_test_results = _read_json(test_results_path)
    parsed_event_tests = _extract_test_commands_from_events(events)
    if parsed_test_results:
        test_results = parsed_test_results
    elif parsed_event_tests:
        failed_tests = sum(1 for item in parsed_event_tests if item.get("status") == "failed")
        test_results = {
            "summary": {
                "passed": len(parsed_event_tests) - failed_tests,
                "failed": failed_tests,
            },
            "commands": parsed_event_tests,
        }
    else:
        test_results = {
            "summary": {"passed": 0, "failed": 0},
            "commands": [],
        }

    if artifact_root.exists():
        shutil.rmtree(artifact_root)

    status_result, status_log_output, status_stdout, _ = _run_command(
        ["git", "status", "--porcelain=v1"],
        cwd=REPO_PATH,
    )
    diff_numstat_result, diff_numstat_log_output, diff_numstat_stdout, _ = _run_command(
        ["git", "diff", "--numstat", "--no-ext-diff"],
        cwd=REPO_PATH,
    )
    diff_result, diff_log_output, diff_stdout, _ = _run_command(
        ["git", "diff", "--no-ext-diff"],
        cwd=REPO_PATH,
    )
    commands.extend([status_result, diff_numstat_result, diff_result])
    output_chunks.extend([status_log_output, diff_numstat_log_output, diff_log_output])

    changed_files = _parse_changed_files(status_stdout, diff_numstat_stdout)
    failed_commands = sum(1 for command in commands if command["status"] == "failed")
    ok = opencode_result["status"] == "passed" and failed_commands == 0

    return {
        "ok": ok,
        "sandboxId": f"modal-opencode:{run_id}",
        "summary": summary
        or f"OpenCode finished for {ticket_id} using {selected_model}. See raw output for details.",
        "triageLabel": triage_label,
        "selectedModel": selected_model,
        "changedFiles": {"files": changed_files},
        "diffText": diff_stdout,
        "testResults": test_results,
        "testOutput": "\n\n".join(chunk for chunk in output_chunks if chunk),
        "opencodeOutput": opencode_stdout or opencode_stderr,
        "error": None if ok else "OpenCode reported failures or produced failing commands",
    }


@app.function(image=opencode_image, timeout=900, cpu=2.0, memory=2048)
def run_opencode(
    ticket_id: str,
    run_id: str,
    ticket_title: str,
    ticket_description: str,
    repo_url: str,
    default_branch: str = "main",
    github_token: str = "",
    anthropic_api_key: str = "",
    triage_model_id: str = "claude-haiku-4-5-20251001",
    simple_model_id: str = "anthropic/claude-sonnet-4-6",
    complex_model_id: str = "anthropic/claude-opus-4-6",
) -> str:
    result = run_opencode_job(
        ticket_id=ticket_id,
        run_id=run_id,
        ticket_title=ticket_title,
        ticket_description=ticket_description,
        repo_url=repo_url,
        default_branch=default_branch,
        github_token=github_token,
        anthropic_api_key=anthropic_api_key,
        triage_model_id=triage_model_id,
        simple_model_id=simple_model_id,
        complex_model_id=complex_model_id,
    )
    return json.dumps(result)
