"""
Teams Meeting Automation via Power Automate — HTTP Trigger Edition
==================================================================
Triggers Power Automate flows via HTTP POST requests instead of browser
automation. Each flow must be configured with a "When an HTTP request is
received" trigger in Power Automate, which generates a webhook URL stored
in the YAML config under the `power_automate.create_flow_url` key.

Why this is better than browser automation:
  - No browser, no Chrome, no Playwright — pure HTTP calls
  - ~1-2 seconds per meeting instead of ~30-60 seconds
  - Not fragile to Power Automate UI changes
  - No cookie copying, no profile locks, no popup suppression

ONE-TIME SETUP — create the shared create flow in Power Automate
-----------------------------------------------------------------
  Step 1 — Create a new flow in Power Automate:
            Trigger : "When an HTTP request is received"
            Paste this JSON schema into the trigger's Request Body JSON Schema:
            {
              "type": "object",
              "properties": {
                "subject":                { "type": "string" },
                "release_version":        { "type": "string" },
                "description":            { "type": "string" },
                "start_date":             { "type": "string" },
                "start_time":             { "type": "string" },
                "end_date":               { "type": "string" },
                "end_time":               { "type": "string" },
                "start_datetime":         { "type": "string" },
                "end_datetime":           { "type": "string" },
                "required_attendees":     { "type": "string" },
                "optional_attendees":     { "type": "string" },
                "release_schedule_url":   { "type": "string" },
                "release_readiness_url":  { "type": "string" },
                "release_notes_url":      { "type": "string" },
                "security_scorecard_url": { "type": "string" }
              }
            }
            Action : "Create a Teams meeting" — map each field from the trigger body.
                     Use coalesce(triggerBody()?['optional_attendees'], '') for
                     optional fields so missing values don't break the flow.

  Step 2 — Save the flow. Power Automate generates an HTTP POST URL.

  Step 3 — Copy that URL and paste it into the YAML config as `create_flow_url`
            under the `power_automate` section (one place, applies to all meetings):

              power_automate:
                url: "https://make.powerautomate.com/..."
                create_flow_url: "https://..."   # <-- paste here

  Step 4 — Run the script. All meetings will use this single URL.

NOTE — URL migration (August 2025):
  Microsoft is migrating HTTP trigger URLs from logic.azure.com to
  environment.api.powerplatform.com. Use the new-format URLs when
  setting up triggers. Old URLs stop working after November 2025.

Config file (single source of truth):
    config/config_tdr.yaml        — TDR meetings
    config/config_tdr_test.yaml   — TDR test config
    config/config_cre.yaml        — CRE meetings

Usage:
    python create_teams_meeting.py --project TDR --release-version 2026.07.00
    python create_teams_meeting.py --project CRE --release-version 2026.07.00
    python create_teams_meeting.py --project TDR --release-version 2026.07.00 --config config/config_tdr_test.yaml

Arguments:
    --project          Project name.            Choices: CRE, TDR
    --release-version  Release version number.  Example: 2026.07.00

Optional:
    --config           Path to YAML config file.
                       Default: config/config_<project>.yaml
    --dry-run          Print what would be sent without making HTTP calls.
    --meeting          Run only the named meeting (exact match).

Requirements:
    pip install requests pyyaml
"""

import argparse
import os
import sys
import time
import traceback
from datetime import datetime

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

import requests
import yaml

# Ensure this file's directory is on sys.path so utils.py is always importable,
# regardless of the working directory from which this script is invoked.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from utils import (           # noqa: E402  (import after sys.path patch)
    HR, HR2,
    HTTP_TIMEOUT, HTTP_RETRIES, RETRY_BACKOFF,
    _PROJECT_FULL_NAMES,
    get_config_path,
    load_config,
    extract_version,
    normalize_release_number,
    decrement_version,
    build_release_branch_name,
    get_version_schedule,
    format_date_display,
    trigger_flow,
    _print_summary,
    print_available_versions,
    print_available_meetings,
)


# normalize_release_number, extract_version, decrement_version,
# build_release_branch_name  →  moved to utils.py


# ══════════════════════════════════════════════════════════════════════════════
#  URL helpers
# ══════════════════════════════════════════════════════════════════════════════

def get_versioned_url(config: dict, version: str, url_type: str) -> str:
    tmpl = config.get("releases", {}).get("url_templates", {}).get(url_type, "")
    return tmpl.format(version=version) if tmpl else ""


def get_retro_url(config: dict, release_number: str, meeting_name: str) -> str:
    releases  = config.get("releases", {})
    templates = releases.get("url_templates", {})
    version   = extract_version(release_number)

    if "release_retro_url" in templates:
        lookup_ver = (
            decrement_version(version)
            if meeting_name == "Release Retro & Release Scope Review"
            else version
        )
        url = get_versioned_url(config, lookup_ver, "release_retro_url")
        if not url:
            print(f"  ⚠ release_retro_url not found for version '{lookup_ver}'")
        return url

    url = releases.get("release_retro_url", "")
    if not url:
        print("  ⚠ release_retro_url not found in releases config.")
    return url


# ══════════════════════════════════════════════════════════════════════════════
#  Change Request registry helpers
# ══════════════════════════════════════════════════════════════════════════════

_MEETING_TO_CONFIG_KEY: dict[str, str] = {
    # CRE deployment meetings → configName in CR registry
    "SAT APP":              "SAT",
    "UAT EMEA":             "UAT_EMEA",
    "UAT AMER":             "UAT_AMER",
    "PROD EMEA":            "PROD_EMEA",
    "PROD AMER":            "PROD_AMER",
    # TDR meetings → configName in CR registry
    "UAT_DATA_REFRESH":     "UAT_DATA_REFRESH",
    "GENERATE_DUMP_PROD":   "GENERATE_DUMP_PROD",
    "QA_DATA_REFRESH":      "QA_DATA_REFRESH",
}


def load_cr_registry(config_file: str) -> dict:
    config_dir    = os.path.dirname(os.path.abspath(config_file))
    registry_path = os.path.join(config_dir, "change_request_registry.yaml")
    if not os.path.exists(registry_path):
        return {}
    try:
        with open(registry_path, encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        return data.get("change_request_registry", data)
    except Exception as exc:
        print(f"  ⚠ Could not load CR registry: {exc}")
        return {}


def get_cr_for_meeting(registry: dict, release_ver: str,
                       schedule_col: str) -> dict | None:
    config_key = _MEETING_TO_CONFIG_KEY.get(schedule_col)
    if not config_key:
        return None
    for cr_data in registry.get(release_ver, {}).values():
        if cr_data.get("configName") == config_key:
            return cr_data
    return None


def build_cr_description_line(cr_number: str, cr_url: str, short_desc: str) -> str:
    """
    CR reference for Teams meeting body.
    Only the CR number is a hyperlink — description follows as plain text.
    Format: [CHG0165333] - Tax Data Repository | 2026.07.00 | ...
    """
    return f'<a href="{cr_url}">[{cr_number}]</a> - {short_desc}<br><br>'


# get_version_schedule, format_date_display  →  moved to utils.py


# ══════════════════════════════════════════════════════════════════════════════
#  HTTP trigger — core
# ══════════════════════════════════════════════════════════════════════════════

# All fields sent to the single shared create flow.
# The flow uses coalesce() for optional fields so empty values are safe.
_ALL_PAYLOAD_FIELDS = [
    "subject",
    "release_version",
    "description",
    "start_date",
    "start_time",
    "end_date",
    "end_time",
    "start_datetime",
    "end_datetime",
    "required_attendees",
    "optional_attendees",
    "release_schedule_url",
    "release_readiness_url",
    "release_notes_url",
    "security_scorecard_url",
    "release_retro_url",
]


def _build_payload(meeting_name: str, meeting_cfg: dict, flow_data: dict) -> dict:
    """
    Build the JSON payload for the HTTP POST from flow_data.

    Sends all fields to the single shared create flow. Empty/missing fields
    are included as empty strings so the flow's coalesce() expressions work.
    Attendee lists are joined to semicolon-separated strings.
    """
    payload = {}
    for key in _ALL_PAYLOAD_FIELDS:
        value = flow_data.get(key, "")
        if isinstance(value, list):
            value = ";".join(value)
        payload[key] = str(value) if value else ""
    return payload


# trigger_flow, _print_summary  →  moved to utils.py


# ══════════════════════════════════════════════════════════════════════════════
#  Core flow runner
# ══════════════════════════════════════════════════════════════════════════════

def run_flow(
    meeting_name: str,
    meeting_date: str,
    meeting_cfg:  dict,
    flow_data:    dict,
    dry_run:      bool = False,
) -> None:
    """
    Trigger one Power Automate flow via its HTTP trigger URL.

    Raises RuntimeError if create_flow_url is missing or the HTTP call fails.
    """
    trigger_url = meeting_cfg.get("_resolved_create_flow_url", "").strip()
    if not trigger_url:
        raise RuntimeError(
            f"No create_flow_url set for '{meeting_name}'.\n"
            f"  Set up the shared create flow in Power Automate and add the URL\n"
            f"  as 'create_flow_url' under power_automate in the YAML config."
        )

    print(f"  Date    : {format_date_display(meeting_date)}"
          f"  ({meeting_cfg.get('default_start_time', '?')} -"
          f" {meeting_cfg.get('default_end_time', '?')})")
    print(f"  Subject : {flow_data.get('subject', '')}")

    payload = _build_payload(meeting_name, meeting_cfg, flow_data)
    print(f"  Fields  : {', '.join(payload.keys())}")
    print(f"  URL     : ...{trigger_url[-60:]}")

    trigger_flow(trigger_url, payload, dry_run=dry_run)


# ══════════════════════════════════════════════════════════════════════════════
#  Orchestrator
# ══════════════════════════════════════════════════════════════════════════════

def create_teams_meeting(
    project_name:   str,
    release_number: str,
    config_file:    str = None,
    dry_run:        bool = False,
    meeting_filter: str = None,
) -> dict:
    """
    Trigger all Teams meeting flows for a project + release via HTTP.

    Returns:
        dict with keys: total_flows, success_count, failed_count,
                        passed_flows, failed_flows
    """
    results = {
        "total_flows":   0,
        "success_count": 0,
        "failed_count":  0,
        "passed_flows":  [],
        "failed_flows":  [],
    }

    version         = extract_version(release_number)
    display_release = normalize_release_number(project_name, release_number)
    project_abbr      = project_name.upper()
    project_full_name = _PROJECT_FULL_NAMES.get(project_abbr, project_abbr)
    project_tag       = f"[{project_abbr} {version}]"

    print(f"\n{HR2}")
    print(f"  {project_name.upper()} Release Meeting Automation  —  {display_release}")
    if dry_run:
        print("  *** DRY RUN — no HTTP calls will be made ***")
    if meeting_filter:
        print(f"  *** FILTER — only: '{meeting_filter}' ***")
    print(f"{HR2}\n")

    config, resolved_config_file = load_config(project_name, config_file)
    cr_registry = load_cr_registry(resolved_config_file)

    shared_create_url = config.get("power_automate", {}).get("create_flow_url", "").strip()
    if shared_create_url:
        print(f"  Create flow URL : ...{shared_create_url[-60:]}")
    else:
        print("  Create flow URL : (not set — fill in power_automate.create_flow_url in the YAML)")

    version_schedule = get_version_schedule(config, version)
    if not version_schedule:
        available = sorted(config.get("releases", {}).get("schedule", {}).keys())
        raise ValueError(
            f"Version '{version}' not found in releases.schedule.\n"
            f"Available: {available}"
        )

    release_entry = config.get("releases", {}).get("schedule", {}).get(version, {})
    build_version = release_entry.get("buildVersion", "")

    print(f"  Config file     : {resolved_config_file}")
    print(f"  Version         : {version}")
    print(f"  Scheduled dates : {dict(version_schedule)}")
    print()

    # Pre-compute release-level constants once for the whole run
    releases              = config.get("releases", {})
    url_templates         = releases.get("url_templates", {})
    release_schedule_url  = url_templates.get("release_schedule_url", "")
    release_readiness_url = get_versioned_url(config, version, "release_readiness_url")
    release_notes_url     = get_versioned_url(config, version, "release_notes_url")
    security_scorecard_url = url_templates.get("security_scorecard_url", "")

    _rb_date = version_schedule.get("Release Branch", "")
    release_branch_name = build_release_branch_name(version, str(_rb_date)) if _rb_date else ""
    if release_branch_name:
        print(f"  Release branch  : {release_branch_name}")
    else:
        print("  Release branch  : (no Release Branch date in schedule — branch name unavailable)")
    print()

    meetings      = config.get("meetings", {})
    run_meetings  = []
    skip_meetings = []

    for name, meeting_cfg in meetings.items():
        date = version_schedule.get(name)
        if not date:
            skip_meetings.append((name, "no date in schedule"))
            continue
        if meeting_filter and name != meeting_filter:
            skip_meetings.append((name, f"filtered out (--meeting '{meeting_filter}')"))
            continue

        start_time = meeting_cfg.get("default_start_time", "09:00:00")
        end_time   = meeting_cfg.get("default_end_time",   "10:00:00")

        base_description = meeting_cfg["description_template"].format(
            release_number=release_number,
            release_version=version,
            release_branch_name=release_branch_name,
            release_schedule_url=release_schedule_url,
            release_readiness_url=release_readiness_url,
            release_notes_url=release_notes_url,
            security_scorecard_url=security_scorecard_url,
        )

        schedule_col = meeting_cfg.get("schedule_column", "")
        cr_entry = get_cr_for_meeting(cr_registry, version, schedule_col)
        if cr_entry:
            cr_line = build_cr_description_line(
                cr_entry.get("crNumber", ""),
                cr_entry.get("crUrl", ""),
                cr_entry.get("shortDescription", f"{project_name} | {version}"),
            )
            description = f"{cr_line}{base_description}"
        else:
            description = base_description

        start_datetime = f"{date}T{start_time}"
        end_datetime   = f"{date}T{end_time}"

        flow_data = {
            "subject": meeting_cfg.get("subject_template", "[{release_number}]").format(
                release_number=display_release,
                project_full_name=project_full_name,
                project_tag=project_tag,
                build_version=build_version,
            ),
            "release_version":        display_release,
            "release_branch_name":    release_branch_name,
            "description":            description,
            "start_date":             str(date),
            "end_date":               str(date),
            "start_time":             start_time,
            "end_time":               end_time,
            "start_datetime":         start_datetime,
            "end_datetime":           end_datetime,
            "required_attendees":     meeting_cfg.get("required_attendees", []),
            "optional_attendees":     meeting_cfg.get("optional_attendees", []),
            "release_schedule_url":   release_schedule_url,
            "release_readiness_url":  release_readiness_url,
            "release_notes_url":      release_notes_url,
            "security_scorecard_url": security_scorecard_url,
            "release_retro_url":      get_retro_url(config, release_number, name),
        }

        meeting_cfg["_resolved_create_flow_url"] = shared_create_url
        run_meetings.append((name, str(date), meeting_cfg, flow_data))

    # Warn when --meeting filter matched nothing at all
    if meeting_filter and not run_meetings:
        known = set(meetings.keys())
        if meeting_filter not in known:
            print(f"  ⚠ WARNING: No meeting named '{meeting_filter}' exists in config.")
            print(f"  Run with --list-meetings to see available names.")
        else:
            print(f"  ⚠ WARNING: Meeting '{meeting_filter}' is defined but has no date")
            print(f"  in releases.schedule for version '{version}'. Nothing to run.")

    results["total_flows"] = len(run_meetings)

    # Pre-execution summary
    print(HR)
    print(f"  To run   : {len(run_meetings)}")
    print(f"  To skip  : {len(skip_meetings)}")
    print(HR)
    for i, (n, *_)     in enumerate(run_meetings,  1): print(f"  {i:2}. ✓ {n}")
    for i, (n, reason) in enumerate(skip_meetings, 1): print(f"  {i:2}. ⊘ {n}  ({reason})")
    print(f"{HR}\n")

    # Trigger flows
    for idx, (meeting_name, meeting_date, meeting_cfg, flow_data) in enumerate(run_meetings, 1):
        print(f"\n[{idx}/{len(run_meetings)}] {meeting_name}")
        print(HR)
        try:
            run_flow(meeting_name, meeting_date, meeting_cfg, flow_data, dry_run)
            results["success_count"] += 1
            results["passed_flows"].append({"flow_name": meeting_name, "date": meeting_date})
            print(f"  ✓ Done: {meeting_name}")
        except Exception as exc:
            results["failed_count"] += 1
            results["failed_flows"].append({
                "flow_name": meeting_name,
                "date":      meeting_date,
                "error":     str(exc),
            })
            print(f"  ✗ Failed: {meeting_name} — {exc}")
            print(traceback.format_exc())

    _print_summary("SUMMARY", display_release, run_meetings, skip_meetings, results)
    return results


# ══════════════════════════════════════════════════════════════════════════════
#  Entry point
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Trigger Teams meeting flows via Power Automate HTTP triggers.",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument("--project",         required=True,
                        help="Project name.\nChoices: CRE, TDR")
    parser.add_argument("--release-version", required=True,
                        help="Release version number.\nExample: 2026.07.00")
    parser.add_argument("--config",          default=None,
                        help="Path to YAML config file (optional).\n"
                             "Default: config/config_<project>.yaml")
    parser.add_argument("--dry-run",         action="store_true",
                        help="Print what would be sent without making HTTP calls.\n"
                             "Useful for verifying config before a real run.")
    parser.add_argument("--meeting",         default=None,
                        help="Run only the named meeting (exact match).\n"
                             'Example: --meeting "CCA Details"')
    parser.add_argument("--list-versions",   action="store_true",
                        help="List all release versions available in the config and exit.")
    parser.add_argument("--list-meetings",   action="store_true",
                        help="List all meeting names defined in the config and exit.")
    args = parser.parse_args()

    if args.list_versions:
        print_available_versions(args.project, args.config)
        sys.exit(0)

    if args.list_meetings:
        print_available_meetings(args.project, args.config)
        sys.exit(0)

    results = create_teams_meeting(
        args.project,
        args.release_version,
        args.config,
        dry_run=args.dry_run,
        meeting_filter=args.meeting,
    )
    sys.exit(1 if results["failed_count"] > 0 else 0)

# ── How to run ────────────────────────────────────────────────────────────────
#
# SETUP
#   Step 1: Navigate to the project folder
#           cd teams_meeting_single_http
#
#   Step 2: Install dependencies (one-time only)
#           pip install requests pyyaml
#
# ─────────────────────────────────────────────────────────────────────────────
# TDR — TEST CONFIG  (config_tdr_test.yaml)
# Use this while setting up and testing individual flows.
# ─────────────────────────────────────────────────────────────────────────────
#
#   Dry run — verify config and payload without triggering any flows
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --config config/config_tdr_test.yaml --dry-run
#
#   Real run — trigger all meetings that have dates in the schedule
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --config config/config_tdr_test.yaml
#
#   Run a single specific meeting
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --config config/config_tdr_test.yaml --meeting "Determination Enterprise Cloud Component Details"
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --config config/config_tdr_test.yaml --meeting "SDI & GPG Details"
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --config config/config_tdr_test.yaml --meeting "UAT Deployment"
#
# ─────────────────────────────────────────────────────────────────────────────
# TDR — FULL CONFIG  (config_tdr.yaml)  |  12 releases  |  FY 2026
# ─────────────────────────────────────────────────────────────────────────────
#
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --config config/config_tdr.yaml
#
# ─────────────────────────────────────────────────────────────────────────────
# CRE — TEST CONFIG  (config_cre_test.yaml)
# ─────────────────────────────────────────────────────────────────────────────
#
#   python create_teams_meeting.py --project CRE --release-version 2026.07.00 --config config/config_cre_test.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.07.00 --config config/config_cre_test.yaml
#
# ─────────────────────────────────────────────────────────────────────────────
# CRE — FULL CONFIG  (config_cre.yaml)
# ─────────────────────────────────────────────────────────────────────────────
#
#   python create_teams_meeting.py --project CRE --release-version 2026.07.00 --config config/config_cre.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.07.00 --config config/config_cre.yaml
#
# ─────────────────────────────────────────────────────────────────────────────
# NOTES
#
#   SINGLE FLOW FOR ALL MEETINGS
#   ─────────────────────────────
#   You only need ONE create flow in Power Automate. The same flow handles every
#   meeting because it accepts all possible fields and uses coalesce() for optional
#   ones. Every meeting sends the full field set; the flow ignores empty values.
#
#   --dry-run        Prints the payload that would be sent — no HTTP calls made.
#   --meeting        Run only one named meeting (exact match). Useful for re-running
#                    a failed meeting without re-triggering those that already succeeded.
#   --config         Path to the YAML config file.
#   --release-version  Version number only — no project prefix needed.
# ─────────────────────────────────────────────────────────────────────────────