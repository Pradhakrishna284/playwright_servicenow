"""
verify_trigger_branches.py

Verifies that all trigger-branch files for a given project/environment
match the latest workflow run on the release branch.

Files verified per trigger branch:
  version.txt      → release version          (e.g. 2026.01.00)
  action-info.txt  → build number             (e.g. 443)
  action-info.json → tag field == full commit SHA  (e.g. {"tag": "1a2b3c4d…", …})
  app-version.txt  → version-build combined   (e.g. 2026.01.00-443)
  git-commit.txt   → full commit SHA

Branch naming convention:
  trigger/<env>-<region>[-lb]
    env    : sat | uat | prd
    region : i  = AMER (AWS)
             ii = EMEA (AWS)
             iv = OCI  (AMER)
             x  = MENA (OCI)
    suffix : -lb    = Liquibase deployment pipeline
             (none) = App deployment pipeline

Project & environments — CRE (Content Rate Extract):
  SAT        3 branches  — trigger/sat-lb + trigger/sat-i + trigger/sat-iv
  UAT_EMEA   2 branches  — trigger/uat-lb-ii + trigger/uat-ii
  UAT_AMER   4 branches  — trigger/uat-lb-i + trigger/uat-i + trigger/uat-iv-lb + trigger/uat-iv
  UAT_MENA   2 branches  — trigger/uat-x-lb + trigger/uat-x
  PROD_EMEA  2 branches  — trigger/prd-lb-ii + trigger/prd-ii
  PROD_AMER  4 branches  — trigger/prd-i-lb + trigger/prd-i + trigger/prd-iv-lb + trigger/prd-iv
  PROD_MENA  2 branches  — trigger/prd-x-lb + trigger/prd-x

Project & environments — EDF (Enterprise Data Fabric):
  SAT        1 branch    — trigger/sat   (AWS | all 4 repos verified)
  UAT_EMEA   1 branch    — trigger/uat   (AWS EMEA | all 4 repos verified)
  UAT_AMER   1 branch    — trigger/uat   (AWS AMER | all 4 repos verified)
  PROD_EMEA  1 branch    — trigger/prd   (AWS EMEA | all 4 repos verified)
  PROD_AMER  1 branch    — trigger/prd   (AWS AMER | all 4 repos verified)
  Files verified: action-info.json (tag field) · git-commit.txt · version.txt
  Note: EDF version.txt contains the full version from the workflow run name
        (e.g. 2026.07.01) — the patch segment is NOT always .00.
  Note: EDF has no Liquibase pipeline. No MENA region.

Usage — CRE  (release version format: YYYY.MM.DD  e.g. 2026.07.00):
  python verify_trigger_branches.py --project CRE --environment SAT       --release-version 2026.07.00
  python verify_trigger_branches.py --project CRE --environment UAT_EMEA  --release-version 2026.07.00
  python verify_trigger_branches.py --project CRE --environment UAT_AMER  --release-version 2026.07.00
  python verify_trigger_branches.py --project CRE --environment UAT_MENA  --release-version 2026.07.00
  python verify_trigger_branches.py --project CRE --environment PROD_EMEA --release-version 2026.07.00
  python verify_trigger_branches.py --project CRE --environment PROD_AMER --release-version 2026.07.00
  python verify_trigger_branches.py --project CRE --environment PROD_MENA --release-version 2026.07.00

Usage — EDF  (release version format: YYYY.MM  e.g. 2026.07  — NO patch segment):
  python verify_trigger_branches.py --project EDF --environment SAT       --release-version 2026.07
  python verify_trigger_branches.py --project EDF --environment UAT_EMEA  --release-version 2026.07
  python verify_trigger_branches.py --project EDF --environment UAT_AMER  --release-version 2026.07
  python verify_trigger_branches.py --project EDF --environment PROD_EMEA --release-version 2026.07
  python verify_trigger_branches.py --project EDF --environment PROD_AMER --release-version 2026.07
"""

import argparse
import base64
import json
import os
import re
import sys

import requests
import yaml

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
CONFIG_FILE    = "config_github.yaml"
GITHUB_API     = "https://api.github.com/repos/{owner}/{repo}"
# Each entry: (filename, expected_template, json_field_or_None)
# json_field: if set, the file is parsed as JSON and that field is compared.
VERIFY_FILES   = [
    ("version.txt",      "{version}",         None),
    ("action-info.txt",  "{build}",            None),
    ("action-info.json", "{commit}",           "tag"),
    ("app-version.txt",  "{version}-{build}",  None),
    ("git-commit.txt",   "{commit}",           None),
]


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

def load_config(path: str = None) -> dict:
    """Load and return the YAML config; exits on any error."""
    config_path = path or os.path.join(os.path.dirname(__file__), CONFIG_FILE)
    if not os.path.exists(config_path):
        sys.exit(f"❌ Config file not found: '{config_path}'")
    try:
        with open(config_path) as f:
            return yaml.safe_load(f)
    except yaml.YAMLError as exc:
        sys.exit(f"❌ Invalid YAML in '{config_path}': {exc}")


# ---------------------------------------------------------------------------
# GitHub API helpers
# ---------------------------------------------------------------------------

def _make_session(token: str) -> requests.Session:
    s = requests.Session()
    s.headers["Authorization"] = f"token {token}"
    return s


def get_latest_workflow_run(session: requests.Session, owner: str, repo: str,
                            release_branch: str) -> tuple[str, str, str | None] | tuple[None, None, None]:
    """
    Return (commit_sha, build_number, full_version) for the latest workflow run on
    *release_branch*, or (None, None, None) on failure.
    full_version is parsed from the run name (e.g. "version 2026.07.01 (#125)" → "2026.07.01").
    """
    url = f"{GITHUB_API.format(owner=owner, repo=repo)}/actions/runs"
    resp = session.get(url, params={"branch": release_branch, "per_page": 1}, timeout=30)

    if resp.status_code != 200:
        print(f"❌ Workflow runs API returned {resp.status_code}: {resp.text}")
        return None, None, None

    runs = resp.json().get("workflow_runs", [])
    if not runs:
        print(f"❌ No workflow runs found for branch '{release_branch}'")
        return None, None, None

    run = runs[0]
    commit = run["head_sha"]
    build  = str(run["run_number"])

    # Extract the full version string from the workflow run name.
    # GitHub Actions names the run after the version tag, e.g. "version 2026.07.01 (#125)".
    # This is the only reliable source of the patch segment (.00 / .01 / etc.).
    run_name      = run.get("name") or run.get("display_title") or ""
    version_match = re.search(r'(\d{4}\.\d{2}\.\d{2})', run_name)
    full_version  = version_match.group(1) if version_match else None

    print(f"\n📊 Latest Workflow Run:")
    print(f"   Run ID     : {run['id']}")
    print(f"   Run Name   : {run_name}")
    print(f"   Build #    : {build}")
    print(f"   Status     : {run['status']}")
    print(f"   Branch     : {run['head_branch']}")
    print(f"   Commit     : {commit[:8]}…")
    if full_version:
        print(f"   Version    : {full_version}")
    else:
        print(f"   Version    : ⚠ not found in run name — will fall back to {{version}}.00")

    return commit, build, full_version


def get_file_content(session: requests.Session, owner: str, repo: str,
                     branch: str, file_path: str) -> tuple[str | None, str | None]:
    """
    Return (decoded_content, None) on success, or (None, error_message) on failure.
    """
    url = f"{GITHUB_API.format(owner=owner, repo=repo)}/contents/{file_path}"
    resp = session.get(url, params={"ref": branch}, timeout=30)

    if resp.status_code == 404:
        return None, f"'{file_path}' not found on branch '{branch}'"
    if resp.status_code != 200:
        return None, f"API returned {resp.status_code}"

    raw = resp.json().get("content", "")
    return base64.b64decode(raw).decode().strip(), None


# ---------------------------------------------------------------------------
# Verification helpers
# ---------------------------------------------------------------------------

def verify_file_across_branches(session: requests.Session, owner: str, repo: str,
                                 branches: list[str], file_path: str,
                                 expected: str, json_field: str | None = None) -> bool:
    """
    Verify *file_path* matches *expected* in every branch.

    If *json_field* is set, the file is parsed as JSON and that field's value
    is compared (e.g. json_field='tag' checks data['tag'] == expected).
    Otherwise the raw text content is compared directly.

    Prints per-branch results and returns True only if all pass.
    """
    passed, failed = [], []

    for branch in branches:
        content, error = get_file_content(session, owner, repo, branch, file_path)
        if error:
            print(f"   ❌ {branch}: {error}")
            failed.append(branch)
            continue

        if json_field:
            try:
                data   = json.loads(content)
                actual = data.get(json_field, "")
                label  = f"{file_path}['{json_field}'] = '{actual}'"
            except json.JSONDecodeError as exc:
                print(f"   ❌ {branch}: failed to parse JSON — {exc}")
                failed.append(branch)
                continue
        else:
            actual = content
            label  = f"'{actual}'"

        if actual == expected:
            print(f"   ✅ {branch}: {label}")
            passed.append(branch)
        else:
            print(f"   ❌ {branch}: expected '{expected}', found {label}")
            failed.append(branch)

    total = len(branches)
    if failed:
        print(f"   ⚠️  Failed in {len(failed)}/{total} branch(es)")
    else:
        print(f"   ✅ Passed in all {total} branch(es)")

    return not failed


# ---------------------------------------------------------------------------
# Main verification orchestrator
# ---------------------------------------------------------------------------

def verify_environment(config: dict, project: str, environment: str,
                       release_branch: str,
                       repo_filter: list[str] | None = None) -> bool:
    """
    Full verification pipeline for one project/environment/release combination.
    Iterates over every repository in the project that defines the environment.

    repo_filter: optional list of repo names (short name, not owner/name) to verify.
      - None / omitted → verify ALL repos that define the environment.
      - Provided       → verify only the listed repos; useful when not all repos
                         have a release for the given version.

    Returns True only if every file in every trigger branch passes for all verified repos.
    """
    projects = config.get("projects", {})

    # ── Validate project ────────────────────────────────────────────────────
    if project not in projects:
        print(f"❌ Unknown project '{project}'")
        print("📋 Available projects:")
        for name, cfg in projects.items():
            print(f"   - {name}: {cfg.get('description', '')}")
        return False

    proj_cfg     = projects[project]
    repositories = proj_cfg.get("repositories", [])

    # ── Find all repos that define the requested environment ─────────────────
    matching: list[tuple[dict, dict]] = []
    for repo in repositories:
        env_cfg = repo.get("environments", {}).get(environment)
        if env_cfg:
            matching.append((repo, env_cfg))

    if not matching:
        all_envs: dict = {}
        for repo in repositories:
            for env_name, env_cfg in repo.get("environments", {}).items():
                all_envs.setdefault(env_name, env_cfg)
        print(f"❌ Unknown environment '{environment}' for project '{project}'")
        print(f"📋 Available environments for {project}:")
        for name, cfg in all_envs.items():
            print(f"   - {name}: {cfg.get('description', '')}")
        return False

    # ── Apply repo filter (use when only some repos have a release) ───────────────
    if repo_filter:
        available = [r["name"] for r, _ in matching]
        unknown   = [n for n in repo_filter if n not in available]
        if unknown:
            print(f"❌ Unknown repo(s) for {project}/{environment}: {', '.join(unknown)}")
            print("📋 Configured repos:")
            for name in available:
                print(f"   - {name}")
            return False
        matching = [(r, e) for r, e in matching if r["name"] in repo_filter]

    token   = config["github"]["token"]
    session = _make_session(token)

    # Determine which files to verify — use project-level override if defined,
    # otherwise fall back to the global VERIFY_FILES list.
    # Each entry in verify_files may be:
    #   - a plain string  : filename only  → template taken from global VERIFY_FILES
    #   - a dict          : {file: ..., template: ...}  → custom template (e.g. EDF version.txt)
    project_files = proj_cfg.get("verify_files")
    if project_files:
        global_map = {fname: (tmpl, jf) for fname, tmpl, jf in VERIFY_FILES}
        active_verify_files: list[tuple[str, str, str | None]] = []
        for entry in project_files:
            if isinstance(entry, str):
                fname = entry
                tmpl, jf = global_map.get(fname, ("{version}", None))
                active_verify_files.append((fname, tmpl, jf))
            else:  # dict with 'file' and optional 'template'
                fname            = entry["file"]
                default_tmpl, jf = global_map.get(fname, ("{version}", None))
                tmpl             = entry.get("template", default_tmpl)
                active_verify_files.append((fname, tmpl, jf))
    else:
        active_verify_files = list(VERIFY_FILES)

    repo_results: list[bool] = []

    for repo, env_cfg in matching:
        # Normalise: trigger_branch may be a str or list in the YAML
        branches = env_cfg["trigger_branch"]
        if isinstance(branches, str):
            branches = [branches]

        repo_label = f"{repo['owner']}/{repo['name']}"

        # ── Header ──────────────────────────────────────────────────────────
        print("\n🔍 Starting Environment Verification…")
        print(f"🎯 Project     : {project} ({proj_cfg.get('description', '')})")
        print(f"📦 Environment : {environment} ({env_cfg.get('description', '')})")
        print(f"   Repository  : {repo_label} — {repo.get('description', '')}")
        print(f"🌿 Release     : {release_branch}")
        print(f"🔗 Trigger(s)  : {', '.join(branches)}")

        # ── Step 1: Fetch latest workflow run ────────────────────────────────
        commit, build, full_version = get_latest_workflow_run(
            session, repo["owner"], repo["name"], release_branch,
        )
        if not commit or not build:
            print("❌ Could not retrieve workflow run data")
            repo_results.append(False)
            continue

        # ── Step 2: Build expected values ────────────────────────────────────
        version = release_branch.removeprefix("release/")
        # full_version: the exact version string from the run name (e.g. 2026.07.01).
        # Falls back to "{version}.00" when the run name does not contain a version.
        resolved_full_version = full_version or f"{version}.00"
        print(f"\n📦 Release Version : {resolved_full_version}")
        print(f"🔗 Git Commit      : {commit}")
        print(f"🏗️  Build Number    : {build}")

        placeholders = {"version": version, "build": build, "commit": commit,
                        "full_version": resolved_full_version}
        checks = [(f, tmpl.format(**placeholders), jf) for f, tmpl, jf in active_verify_files]

        # ── Step 3: Verify all files across all trigger branches ─────────────
        print(f"\n🔍 Verifying files across trigger branch(es)…")
        results = []
        for file_path, expected, json_field in checks:
            label = f"{file_path}['{json_field}']" if json_field else file_path
            print(f"\n📋 {label}  (expected: '{expected}')")
            results.append(
                verify_file_across_branches(
                    session, repo["owner"], repo["name"],
                    branches, file_path, expected, json_field,
                )
            )

        # ── Step 4: Per-repo summary ─────────────────────────────────────────
        passed = sum(results)
        total  = len(results)
        print(f"\n{'='*50}")
        if all(results):
            print(f"✅ SUCCESS: All {total} verifications passed for {project}/{environment} [{repo_label}]!")
            repo_results.append(True)
        else:
            print(f"❌ FAILED: {passed}/{total} verifications passed for {project}/{environment} [{repo_label}]")
            repo_results.append(False)

    # ── Overall summary (shown when more than one repo) ───────────────────────
    if len(repo_results) > 1:
        total_repos  = len(repo_results)
        passed_repos = sum(repo_results)
        print(f"\n{'='*50}")
        if all(repo_results):
            print(f"✅ OVERALL: All {total_repos} repositories passed for {project}/{environment}")
        else:
            print(f"❌ OVERALL: {passed_repos}/{total_repos} repositories passed for {project}/{environment}")

    return all(repo_results)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Verify trigger-branch files for a project environment.",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument(
        "--project",
        required=True,
        help="Project name.\nChoices: CRE, EDF",
    )
    parser.add_argument(
        "--environment",
        required=True,
        help=(
            "Environment name.\n"
            "CRE: SAT, UAT_EMEA, UAT_AMER, UAT_MENA, PROD_EMEA, PROD_AMER, PROD_MENA\n"
            "EDF: SAT, UAT_EMEA, UAT_AMER, PROD_EMEA, PROD_AMER"
        ),
    )
    parser.add_argument(
        "--release-version",
        required=True,
        help="Release version number.\nExample: 2026.07.00",
    )
    parser.add_argument(
        "--repo",
        action="append",
        metavar="REPO_NAME",
        default=None,
        help=(
            "Repository name to verify (optional, repeatable).\n"
            "Omit to verify ALL repositories for the project/environment.\n"
            "Specify one or more when only certain repos have a release\n"
            "for the given version.\n"
            "Example: --repo a208113_oedf-app-s3-sink\n"
            "         --repo a208113_oedf-app-s3-sink --repo a208113_oedf-app-reconciliation"
        ),
    )
    parser.add_argument(
        "--config",
        default=None,
        help=f"Path to YAML config file (optional).\nDefault: {CONFIG_FILE} (same folder as script)",
    )
    args = parser.parse_args()

    config  = load_config(args.config)
    success = verify_environment(config, args.project, args.environment,
                                 f"release/{args.release_version}",
                                 repo_filter=args.repo)
    sys.exit(0 if success else 1)

# Usage — CRE  (release version format: YYYY.MM.DD):
#   python verify_trigger_branches.py --project CRE --environment SAT       --release-version 2026.07.00
#   python verify_trigger_branches.py --project CRE --environment UAT_EMEA  --release-version 2026.07.00
#   python verify_trigger_branches.py --project CRE --environment UAT_AMER  --release-version 2026.07.00
#   python verify_trigger_branches.py --project CRE --environment UAT_MENA  --release-version 2026.07.00
#   python verify_trigger_branches.py --project CRE --environment PROD_EMEA --release-version 2026.07.00
#   python verify_trigger_branches.py --project CRE --environment PROD_AMER --release-version 2026.07.00
#   python verify_trigger_branches.py --project CRE --environment PROD_MENA --release-version 2026.07.00
#
# Usage — EDF  (release version format: YYYY.MM — NO patch segment):
#   python verify_trigger_branches.py --project EDF --environment SAT       --release-version 2026.07
#   python verify_trigger_branches.py --project EDF --environment UAT_EMEA  --release-version 2026.07
#   python verify_trigger_branches.py --project EDF --environment UAT_AMER  --release-version 2026.07
#   python verify_trigger_branches.py --project EDF --environment PROD_EMEA --release-version 2026.07
#   python verify_trigger_branches.py --project EDF --environment PROD_AMER --release-version 2026.07
#
# Usage — EDF (only specific repos released — use --repo to filter):
#   SAT:
#   python verify_trigger_branches.py --project EDF --environment SAT       --release-version 2026.07 --repo a208113_oedf-app-s3-sink
#   python verify_trigger_branches.py --project EDF --environment SAT       --release-version 2026.07 --repo a208113_oedf-app-s3-sink --repo a208113_oedf-app-s3-source
#   python verify_trigger_branches.py --project EDF --environment SAT       --release-version 2026.07 --repo a208113_oedf-app-reconciliation --repo a208113_oedf-app-dete-calc-hist-summary
#
#   UAT:
#   python verify_trigger_branches.py --project EDF --environment UAT_EMEA  --release-version 2026.07 --repo a208113_oedf-app-s3-sink
#   python verify_trigger_branches.py --project EDF --environment UAT_EMEA  --release-version 2026.07 --repo a208113_oedf-app-s3-sink --repo a208113_oedf-app-s3-source
#   python verify_trigger_branches.py --project EDF --environment UAT_AMER  --release-version 2026.07 --repo a208113_oedf-app-reconciliation --repo a208113_oedf-app-dete-calc-hist-summary
#
#   PROD:
#   python verify_trigger_branches.py --project EDF --environment PROD_EMEA --release-version 2026.07 --repo a208113_oedf-app-s3-sink
#   python verify_trigger_branches.py --project EDF --environment PROD_EMEA --release-version 2026.07 --repo a208113_oedf-app-reconciliation --repo a208113_oedf-app-dete-calc-hist-summary
#   python verify_trigger_branches.py --project EDF --environment PROD_AMER  --release-version 2026.07 --repo a208113_oedf-app-s3-sink --repo a208113_oedf-app-s3-source
