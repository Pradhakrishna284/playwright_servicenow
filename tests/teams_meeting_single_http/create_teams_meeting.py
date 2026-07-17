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
    --yes / -y         Skip the bulk-run confirmation prompt.
    --verbose          Enable DEBUG logging (full tracebacks on failures).
    --log-file PATH    Write logs to a file in addition to stdout.

Requirements:
    pip install requests pyyaml
"""

import logging
import os
import sys
import traceback

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

import yaml

# Ensure this file's directory is on sys.path so utils.py is always importable,
# regardless of the working directory from which this script is invoked.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from utils import (           # noqa: E402  (import after sys.path patch)
    HR, HR2,
    _PROJECT_FULL_NAMES,
    build_arg_parser,
    configure_logging,
    confirm_bulk_run,
    warn_filter_no_match,
    get_config_path,
    load_config,
    extract_version,
    normalize_release_number,
    decrement_version,
    build_release_branch_name,
    get_version_schedule,
    format_date_display,
    validate_flow_url,
    trigger_flow,
    _print_summary,
    print_available_versions,
    print_available_meetings,
)

log = logging.getLogger(__name__)


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
        if meeting_name == "Release Retro & Release Scope Review":
            try:
                lookup_ver = decrement_version(version)
            except ValueError as exc:
                log.warning("Could not decrement version for retro URL: %s", exc)
                lookup_ver = version
        else:
            lookup_ver = version
        url = get_versioned_url(config, lookup_ver, "release_retro_url")
        if not url:
            log.warning("release_retro_url not found for version '%s'.", lookup_ver)
            print(f"  ⚠ release_retro_url not found for version '{lookup_ver}'")
        return url

    url = releases.get("release_retro_url", "")
    if not url:
        log.warning("release_retro_url not found in releases config.")
        print("  ⚠ release_retro_url not found in releases config.")
    return url


# ══════════════════════════════════════════════════════════════════════════════
#  Change Request registry helpers
# ══════════════════════════════════════════════════════════════════════════════

def load_cr_registry(config_file: str) -> dict:
    """
    Load the change_request_registry.yaml that lives alongside the config file.

    Returns an empty dict (with a printed notice) if the file is absent, so
    meetings simply get no CR prefix rather than silently failing.
    """
    config_dir    = os.path.dirname(os.path.abspath(config_file))
    registry_path = os.path.join(config_dir, "change_request_registry.yaml")
    if not os.path.exists(registry_path):
        # Explicit notice — previously silent, easy to miss
        print(f"  ℹ No CR registry found at '{registry_path}' — CR lines will be omitted.")
        log.info("CR registry not found at '%s'. CR lines will be omitted.", registry_path)
        return {}
    try:
        with open(registry_path, encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        log.info("CR registry loaded: '%s'.", registry_path)
        return data.get("change_request_registry", data)
    except Exception as exc:
        print(f"  ⚠ Could not load CR registry: {exc}")
        log.warning("Could not load CR registry: %s", exc)
        return {}


def get_cr_for_meeting(
    registry: dict,
    release_ver: str,
    schedule_col: str,
    cr_config_key: str | None,
) -> dict | None:
    """
    Look up the CR entry for a meeting using the cr_config_key defined in the
    YAML meeting definition (e.g. cr_config_key: UAT_EMEA).

    Falls back gracefully to None if the key is absent or unmatched — the
    meeting is still created, just without a CR hyperlink in its description.
    """
    if not cr_config_key:
        return None
    for cr_data in registry.get(release_ver, {}).values():
        if cr_data.get("configName") == cr_config_key:
            return cr_data
    return None


def build_cr_description_line(cr_number: str, cr_url: str, short_desc: str) -> str:
    """
    CR reference for Teams meeting body.
    Only the CR number is a hyperlink — description follows as plain text.
    Format: [CHG0165333] - Tax Data Repository | 2026.07.00 | ...
    """
    return f'<a href="{cr_url}">[{cr_number}]</a> - {short_desc}<br><br>'


# ══════════════════════════════════════════════════════════════════════════════
#  Payload builder
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


def _build_payload(flow_data: dict) -> dict:
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


# ══════════════════════════════════════════════════════════════════════════════
#  Core flow runner
# ══════════════════════════════════════════════════════════════════════════════

def run_flow(
    meeting_name: str,
    meeting_date: str,
    meeting_cfg:  dict,
    flow_data:    dict,
    trigger_url:  str,
    dry_run:      bool = False,
) -> None:
    """
    Trigger one Power Automate flow via its HTTP trigger URL.

    The trigger_url is passed explicitly — it is no longer injected into
    meeting_cfg as a side-channel key.

    Raises RuntimeError if trigger_url is missing or the HTTP call fails.
    """
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

    payload = _build_payload(flow_data)
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
    skip_confirm:   bool = False,
) -> dict:
    """
    Trigger all Teams meeting flows for a project + release via HTTP.

    Parameters:
        project_name    — "CRE" or "TDR"
        release_number  — e.g. "2026.07.00" or "TDR 2026.07.00"
        config_file     — override the default YAML config path
        dry_run         — print payloads without making HTTP calls
        meeting_filter  — if set, only this one meeting is run (exact name)
        skip_confirm    — bypass the bulk-run confirmation prompt (--yes flag)

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

    version           = extract_version(release_number)
    display_release   = normalize_release_number(project_name, release_number)
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

    # Validate the URL format before any HTTP calls are attempted
    validate_flow_url(shared_create_url, "power_automate.create_flow_url")

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
    releases               = config.get("releases", {})
    url_templates          = releases.get("url_templates", {})
    release_schedule_url   = url_templates.get("release_schedule_url", "")
    release_readiness_url  = get_versioned_url(config, version, "release_readiness_url")
    release_notes_url      = get_versioned_url(config, version, "release_notes_url")
    security_scorecard_url = url_templates.get("security_scorecard_url", "")

    _rb_date = version_schedule.get("Release Branch", "")
    release_branch_name = build_release_branch_name(version, _rb_date) if _rb_date else ""
    if release_branch_name:
        print(f"  Release branch  : {release_branch_name}")
    else:
        print("  Release branch  : (no Release Branch date in schedule — branch name unavailable)")
    print()

    meetings      = config.get("meetings", {})
    run_meetings  = []   # (meeting_name, date, meeting_cfg, flow_data, trigger_url)
    skip_meetings = []   # (meeting_name, reason)

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

        # description_template is required; missing key is a config error
        tmpl = meeting_cfg.get("description_template", "")
        if not tmpl:
            log.warning("Meeting '%s' has no description_template — description will be empty.", name)
        try:
            base_description = tmpl.format(
                release_number=release_number,
                release_version=version,
                release_branch_name=release_branch_name,
                release_schedule_url=release_schedule_url,
                release_readiness_url=release_readiness_url,
                release_notes_url=release_notes_url,
                security_scorecard_url=security_scorecard_url,
            )
        except KeyError as exc:
            raise ValueError(
                f"Meeting '{name}': description_template references unknown "
                f"placeholder {exc}. Check the YAML."
            ) from exc

        # CR lookup now uses the YAML-defined cr_config_key field, so no
        # hardcoded mapping is needed in Python code.
        cr_config_key = meeting_cfg.get("cr_config_key") or meeting_cfg.get("schedule_column")
        cr_entry = get_cr_for_meeting(cr_registry, version, name, cr_config_key)
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
            "start_date":             date,
            "end_date":               date,
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

        # trigger_url passed explicitly in the tuple — no more dict mutation
        run_meetings.append((name, date, meeting_cfg, flow_data, shared_create_url))

    warn_filter_no_match(meeting_filter, run_meetings, meetings, version)

    results["total_flows"] = len(run_meetings)

    # Pre-execution summary
    print(HR)
    print(f"  To run   : {len(run_meetings)}")
    print(f"  To skip  : {len(skip_meetings)}")
    print(HR)
    for i, (n, *_)     in enumerate(run_meetings,  1): print(f"  {i:2}. ✓ {n}")
    for i, (n, reason) in enumerate(skip_meetings, 1): print(f"  {i:2}. ⊘ {n}  ({reason})")
    print(f"{HR}\n")

    # Confirmation gate for bulk live runs
    if not dry_run and not meeting_filter and not skip_confirm:
        if not confirm_bulk_run("CREATE", len(run_meetings), display_release):
            sys.exit(0)

    # Trigger flows
    for idx, (meeting_name, meeting_date, meeting_cfg, flow_data, trigger_url) in \
            enumerate(run_meetings, 1):
        print(f"\n[{idx}/{len(run_meetings)}] {meeting_name}")
        print(HR)
        try:
            run_flow(meeting_name, meeting_date, meeting_cfg, flow_data,
                     trigger_url, dry_run)
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
            # Full traceback only at DEBUG level (--verbose)
            log.debug("Traceback for '%s':\n%s", meeting_name, traceback.format_exc())

    _print_summary("SUMMARY", display_release, run_meetings, skip_meetings, results)
    return results


# ══════════════════════════════════════════════════════════════════════════════
#  Entry point
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    parser = build_arg_parser(
        "Trigger Teams meeting flows via Power Automate HTTP triggers."
    )
    args = parser.parse_args()

    configure_logging(verbose=args.verbose, log_file=args.log_file)

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
        skip_confirm=args.yes,
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
# TDR — FULL CONFIG  (config_tdr.yaml)
# ─────────────────────────────────────────────────────────────────────────────
#
#   Dry run — verify config and payload without triggering any flows
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --dry-run
#
#   Real run (with confirmation prompt)
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00
#
#   Real run — skip confirmation (CI / unattended)
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --yes
#
#   Run a single specific meeting (no confirmation prompt required)
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --meeting "UAT Deployment"
#
# ─────────────────────────────────────────────────────────────────────────────
# CRE — FULL CONFIG  (config_cre.yaml)
# ─────────────────────────────────────────────────────────────────────────────
#
#   python create_teams_meeting.py --project CRE --release-version 2026.07.00 --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.07.00 --yes
#
# ─────────────────────────────────────────────────────────────────────────────
# TEST CONFIGS  (minimal attendees — safe for flow verification)
# ─────────────────────────────────────────────────────────────────────────────
#
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --config config/config_tdr_test.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.07.00 --config config/config_cre_test.yaml --dry-run
#
# ─────────────────────────────────────────────────────────────────────────────
# VERBOSE / LOGGING
# ─────────────────────────────────────────────────────────────────────────────
#
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --dry-run --verbose
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --yes --log-file runs/2026-07-00.log
#
# ─────────────────────────────────────────────────────────────────────────────
# NOTES
#
#   CR CONFIG KEY
#   ─────────────
#   The meeting-to-CR mapping is no longer hardcoded in Python. Add a
#   cr_config_key field to any meeting in the YAML to enable CR lookup:
#
#     UAT EMEA:
#       cr_config_key: UAT_EMEA   # ← matches configName in CR registry
#
#   If omitted, the meeting is created without a CR hyperlink.
#
#   --yes            Skip confirmation prompt. Useful in CI pipelines.
#   --dry-run        Prints the payload that would be sent — no HTTP calls made.
#   --meeting        Run only one named meeting. Useful for re-running a failed one.
#   --verbose        Show DEBUG logs and full tracebacks on failures.
#   --log-file PATH  Append all log output to a file.
# ─────────────────────────────────────────────────────────────────────────────