"""Modal OpenCode entrypoint for Phoebe."""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time
from base64 import b64encode
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen
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
    .pip_install("anthropic", "boto3", "playwright")
    .run_commands("playwright install --with-deps chromium")
)

WORKSPACE_ROOT = Path("/workspace")
REPO_PATH = WORKSPACE_ROOT / "repo"
ARTIFACT_DIR_NAME = ".phoebe_artifacts"
SCREENSHOT_DIR_NAME = ".phoebe_screenshots"


def _log_step(step: str) -> None:
    print(f"PHOEBE_STEP:{step}", flush=True)


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


def _get_screenshot_root() -> Path:
    return REPO_PATH / SCREENSHOT_DIR_NAME


def _parse_json_object(raw_value: str) -> dict[str, object]:
    if not raw_value.strip():
        return {}
    parsed = json.loads(raw_value)
    return parsed if isinstance(parsed, dict) else {}


def _start_background_process(command: str, cwd: Path, env: dict[str, str]) -> subprocess.Popen[str]:
    return subprocess.Popen(
        ["bash", "-lc", command],
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )


def _stop_background_process(process: subprocess.Popen[str] | None) -> str:
    if process is None:
        return ""
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            stdout_text, stderr_text = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stdout_text, stderr_text = process.communicate(timeout=5)
    else:
        stdout_text, stderr_text = process.communicate()
    stdout_text = stdout_text.strip()
    stderr_text = stderr_text.strip()
    return "\n".join(part for part in [stdout_text, stderr_text] if part).strip()


def _wait_for_url(url: str, timeout_seconds: int = 60) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with urlopen(url, timeout=5) as response:
                if response.status < 500:
                    return
        except (URLError, TimeoutError, OSError):
            time.sleep(2)
    raise RuntimeError(f"Timed out waiting for {url}")


def _ensure_visual_env(env_values: dict[str, object], required_names: list[str]) -> dict[str, str]:
    collected: dict[str, str] = {}
    missing: list[str] = []
    for name in required_names:
        raw_value = env_values.get(name)
        if isinstance(raw_value, str) and raw_value.strip():
            collected[name] = raw_value
        else:
            missing.append(name)
    if missing:
        raise RuntimeError(f"Missing visual env vars: {', '.join(sorted(missing))}")
    return collected


def _service_enabled(config: dict[str, object]) -> bool:
    enabled = config.get("enabled")
    if isinstance(enabled, bool):
        return enabled
    return True


def _install_frontend_dependencies(frontend_dir: Path) -> None:
    lock_path = frontend_dir / "package-lock.json"
    install_command = ["npm", "ci"] if lock_path.exists() else ["npm", "install"]
    _log_step("frontend.install.started")
    print(f"Phoebe installing frontend dependencies with: {_format_command(install_command)}", flush=True)
    result, _, _, stderr_text = _run_command(install_command, cwd=frontend_dir, timeout=300)
    if result["status"] != "passed":
        raise RuntimeError(stderr_text or "Failed to install frontend dependencies")
    _log_step("frontend.install.completed")


def _upload_png_to_r2(file_path: Path, filename: str, r2_env: dict[str, object]) -> str:
    import boto3
    from botocore.config import Config

    required_names = [
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME",
        "R2_PUBLIC_URL",
    ]
    missing = [name for name in required_names if not isinstance(r2_env.get(name), str) or not str(r2_env.get(name)).strip()]
    if missing:
        raise RuntimeError(f"Missing R2 env vars: {', '.join(sorted(missing))}")

    account_id = str(r2_env["R2_ACCOUNT_ID"])
    access_key = str(r2_env["R2_ACCESS_KEY_ID"])
    secret_key = str(r2_env["R2_SECRET_ACCESS_KEY"])
    bucket_name = str(r2_env["R2_BUCKET_NAME"])
    public_url = str(r2_env["R2_PUBLIC_URL"]).rstrip("/")
    key = f"screenshots/{int(time.time())}-{filename}"

    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )
    client.upload_file(
        str(file_path),
        bucket_name,
        key,
        ExtraArgs={"ContentType": "image/png"},
    )
    print(f"Phoebe uploaded screenshot to R2: {key}", flush=True)
    return f"{public_url}/{key}"


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

    _log_step("triage.started")
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
    classification = "complex" if "complex" in text else "simple"
    print(f"Phoebe triage selected: {classification}", flush=True)
    _log_step("triage.completed")
    return classification


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


def _build_branch_name(ticket_id: str) -> str:
    return f"phoebe/{ticket_id}"


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

    _log_step("repo.clone.started")
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
    _log_step("repo.clone.completed")

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
    print(f"Phoebe OpenCode model: {selected_model}", flush=True)
    _log_step("opencode.started")
    opencode_result, opencode_log_output, opencode_stdout, opencode_stderr = _run_command(
        opencode_command,
        env=opencode_env,
        timeout=600,
    )
    _log_step("opencode.completed")
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
    output_chunks.extend(
        [
            status_log_output,
            diff_numstat_log_output,
            diff_log_output,
        ]
    )

    changed_files = _parse_changed_files(status_stdout, diff_numstat_stdout)
    branch_name = _build_branch_name(ticket_id) if changed_files else None
    branch_published = False
    branch_error = None

    if branch_name:
        _log_step("branch.publishing")
        print(f"Phoebe publishing branch via git push: {branch_name}", flush=True)
        tokenized_origin = _build_clone_url(repo_url, github_token)
        git_commands = [
            ["git", "config", "--global", "user.email", "phoebe@bot"],
            ["git", "config", "--global", "user.name", "Phoebe"],
            ["git", "remote", "set-url", "origin", tokenized_origin],
            ["git", "checkout", "-B", branch_name],
            ["git", "add", "-A"],
            ["git", "commit", "-m", f"phoebe: {ticket_id} - {ticket_title}"],
            ["git", "push", "--force", "-u", "origin", f"HEAD:refs/heads/{branch_name}"],
        ]
        git_results: list[dict[str, object]] = []
        for command in git_commands:
            result, log_output, _, stderr_text = _run_command(command, cwd=REPO_PATH)
            git_results.append(result)
            commands.append(result)
            output_chunks.append(log_output)
            if result["status"] != "passed":
                branch_error = stderr_text or log_output or f"Failed to publish branch {branch_name}"
                print(f"Phoebe branch publication failed: {branch_error}", flush=True)
                break

        branch_published = all(result["status"] == "passed" for result in git_results)
        if branch_published:
            _log_step("branch.published")

    failed_commands = sum(1 for command in commands if command["status"] == "failed")
    ok = opencode_result["status"] == "passed" and failed_commands == 0
    error = None if ok else "OpenCode reported failures or produced failing commands"
    if branch_name and not branch_published:
        error = branch_error or f"Failed to publish branch {branch_name}"

    return {
        "ok": ok,
        "sandboxId": f"modal-opencode:{run_id}",
        "summary": summary
        or f"OpenCode finished for {ticket_id} using {selected_model}. See raw output for details.",
        "triageLabel": triage_label,
        "selectedModel": selected_model,
        "branchName": branch_name,
        "branchPublished": branch_published,
        "changedFiles": {"files": changed_files},
        "diffText": diff_stdout,
        "testResults": test_results,
        "testOutput": "\n\n".join(chunk for chunk in output_chunks if chunk),
        "opencodeOutput": opencode_stdout or opencode_stderr,
        "error": error,
    }


def run_visual_verification_job(
    *,
    ticket_id: str,
    run_id: str,
    ticket_title: str,
    ticket_description: str,
    repo_url: str,
    default_branch: str,
    branch_name: str,
    pr_url: str,
    github_token: str,
    visual_config_json: str,
    visual_env_json: str,
    r2_env_json: str,
) -> dict[str, object]:
    from playwright.sync_api import sync_playwright

    visual_config = _parse_json_object(visual_config_json)
    visual_env = _parse_json_object(visual_env_json)
    r2_env = _parse_json_object(r2_env_json)
    routes = visual_config.get("routes")
    if not isinstance(routes, list) or not routes:
        _log_step("screenshots.skipped")
        return {
            "ok": True,
            "skipped": True,
            "summary": "No visual routes were configured for screenshot capture.",
            "screenshots": [],
            "error": None,
        }

    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    if REPO_PATH.exists():
        shutil.rmtree(REPO_PATH)

    _log_step("repo.clone.started")
    clone_result, _, _, clone_stderr = _run_command(["git", "clone", _build_clone_url(repo_url, github_token), str(REPO_PATH)])
    if clone_result["status"] != "passed":
        return {
            "ok": False,
            "skipped": False,
            "summary": f"Failed to clone {repo_url} for visual verification.",
            "screenshots": [],
            "error": clone_stderr or "git clone failed during visual verification",
        }
    _log_step("repo.clone.completed")

    after_frontend_process = None
    screenshot_root = _get_screenshot_root()
    if screenshot_root.exists():
        shutil.rmtree(screenshot_root)
    screenshot_root.mkdir(parents=True, exist_ok=True)

    try:
        frontend_config = visual_config.get("frontend")
        if not isinstance(frontend_config, dict):
            raise RuntimeError("Invalid visual config: frontend settings are required")

        frontend_env = _ensure_visual_env(
            visual_env,
            [name for name in frontend_config.get("envVarNames", []) if isinstance(name, str)],
        )

        after_branch_command = ["git", "checkout", branch_name]
        after_checkout, _, _, after_stderr = _run_command(after_branch_command, cwd=REPO_PATH)
        if after_checkout["status"] != "passed":
            raise RuntimeError(after_stderr or f"Failed to checkout {branch_name}")
        print(f"Phoebe checked out change branch: {branch_name}", flush=True)

        base_env = {
            **dict(os.environ),
            "CI": "1",
        }
        frontend_process_env = {**base_env, **frontend_env}
        _install_frontend_dependencies(REPO_PATH / str(frontend_config.get("workingDirectory", "")))

        _log_step("screenshots.started")
        after_frontend_process = _start_background_process(
            str(frontend_config.get("startCommand", "")),
            REPO_PATH / str(frontend_config.get("workingDirectory", "")),
            frontend_process_env,
        )
        print(f"Phoebe waiting for frontend: {frontend_config.get('url', '')}", flush=True)
        _wait_for_url(str(frontend_config.get("url", "")))
        _log_step("frontend.ready")

        screenshots: list[dict[str, object]] = []
        frontend_url = str(frontend_config.get("url", "")).rstrip("/")

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            for route in routes:
                if not isinstance(route, dict):
                    continue
                label = str(route.get("label", "Page"))
                route_path = str(route.get("path", "/"))
                after_filename = f"after-{label.lower().replace(' ', '-')}.png"
                after_path = screenshot_root / after_filename
                print(f"Phoebe capturing after screenshot for {label} at {route_path}", flush=True)
                page.goto(f"{frontend_url}{route_path}", wait_until="domcontentloaded")
                page.screenshot(path=str(after_path), full_page=True)
                _log_step("screenshot.after.captured")
                screenshots.append(
                    {
                        "filename": after_filename,
                        "label": label,
                        "kind": "after",
                        "path": route_path,
                        "contentBase64": b64encode(after_path.read_bytes()).decode("utf-8"),
                        "url": _upload_png_to_r2(after_path, after_filename, r2_env),
                    }
                )
                _log_step("screenshot.after.uploaded")
            browser.close()

        after_frontend_logs = _stop_background_process(after_frontend_process)
        after_frontend_process = None
        _log_step("screenshots.completed")
        return {
            "ok": True,
            "skipped": False,
            "summary": f"Captured screenshots for {ticket_id} and updated PR evidence for {pr_url}.",
            "screenshots": screenshots,
            "error": None,
            "logs": "\n\n".join(
                part
                for part in [
                    after_frontend_logs,
                ]
                if part
            ),
        }
    except Exception as error:
        return {
            "ok": False,
            "skipped": False,
            "summary": f"Visual verification failed for {ticket_id}.",
            "screenshots": [],
            "error": str(error),
        }
    finally:
        _stop_background_process(after_frontend_process)


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


@app.function(image=opencode_image, timeout=900, cpu=2.0, memory=2048)
def run_visual_verification(
    ticket_id: str,
    run_id: str,
    ticket_title: str,
    ticket_description: str,
    repo_url: str,
    default_branch: str,
    branch_name: str,
    pr_url: str,
    github_token: str = "",
    anthropic_api_key: str = "",
    visual_config_json: str = "{}",
    visual_env_json: str = "{}",
    r2_env_json: str = "{}",
) -> str:
    del anthropic_api_key
    result = run_visual_verification_job(
        ticket_id=ticket_id,
        run_id=run_id,
        ticket_title=ticket_title,
        ticket_description=ticket_description,
        repo_url=repo_url,
        default_branch=default_branch,
        branch_name=branch_name,
        pr_url=pr_url,
        github_token=github_token,
        visual_config_json=visual_config_json,
        visual_env_json=visual_env_json,
        r2_env_json=r2_env_json,
    )
    return json.dumps(result)
