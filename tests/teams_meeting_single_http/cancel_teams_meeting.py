"""
Teams Meeting Cancellation via Power Automate — HTTP Trigger Edition
====================================================================
Cancels Teams meetings that were previously scheduled by create_teams_meeting.py.

HOW IT WORKS
------------
This script does NOT cancel meetings directly. It calls a single shared
Power Automate flow via HTTP POST, and that flow does the actual cancellation
in Teams/Outlook.

The same one flow handles ALL meetings. It receives the meeting subject
and start datetime, finds the matching event on the organiser's calendar,
and deletes it.

ONE-TIME SETUP — create the shared cancel flow in Power Automate
----------------------------------------------------------------
  Step 1 — Create a new flow in Power Automate:
            Trigger : "When an HTTP request is received"
            Paste this JSON schema into the trigger's Request Body JSON Schema:
            {
              "type": "object",
              "properties": {
                "subject":         { "type": "string" },
                "release_version": { "type": "string" },
                "start_datetime":  { "type": "string" },
                "end_datetime":    { "type": "string" }
              }
            }
            Action 1: "Get events (V4)"
                      — Filter: subject eq '@{triggerBody()['subject']}' and
                                start/dateTime eq '@{triggerBody()['start_datetime']}'
            Action 2: "Delete event (V3)"
                      — Event Id: the event ID returned from Action 1

  Step 2 — Save the flow. Power Automate generates an HTTP POST URL.

  Step 3 — Copy that URL and paste it into the YAML config as `cancel_flow_url`
            under the `power_automate` section:

              power_automate:
                url: "https://make.powerautomate.com/..."
                cancel_flow_url: "https://..."   # <-- paste here

  Step 4 — Run the cancel script. All meetings will use this single URL.

Usage:
    python cancel_teams_meeting.py --project TDR --release-version 2026.05.00
    python cancel_teams_meeting.py --project TDR --release-version 2026.05.00 --config config/config_tdr_test.yaml
    python cancel_teams_meeting.py --project TDR --release-version 2026.05.00 --dry-run
    python cancel_teams_meeting.py --project TDR --release-version 2026.05.00 --meeting "Release Branch"

Arguments:
    --project          Project name.            Choices: CRE, TDR
    --release-version  Release version number.  Example: 2026.05.00

Optional:
    --config           Path to YAML config file.
                       Default: config/config_<project>.yaml
    --dry-run          Print what would be sent without making HTTP calls.
    --meeting          Cancel only the named meeting (exact match).
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
    load_config,
    extract_version,
    normalize_release_number,
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
#  Cancel payload builder
# ══════════════════════════════════════════════════════════════════════════════

def _build_cancel_payload(
    display_release: str,
    subject:         str,
    date:            str,
    start_time:      str,
    end_time:        str,
) -> dict:
    """
    Build the minimal JSON payload sent to the cancellation flow.

    The PA flow uses subject + start_datetime to identify the correct event
    on the organiser's calendar and then deletes / cancels it.
    """
    return {
        "subject":         subject,
        "release_version": display_release,
        "start_datetime":  f"{date}T{start_time}",
        "end_datetime":    f"{date}T{end_time}",
    }


# ══════════════════════════════════════════════════════════════════════════════
#  Orchestrator
# ══════════════════════════════════════════════════════════════════════════════

def cancel_teams_meetings(
    project_name:   str,
    release_number: str,
    config_file:    str = None,
    dry_run:        bool = False,
    meeting_filter: str = None,
    skip_confirm:   bool = False,
) -> dict:
    """
    Trigger cancellation flows for all scheduled meetings of a release.

    Uses the single shared cancel_flow_url defined under power_automate in
    the YAML config. If cancel_flow_url is not set, all meetings are skipped.

    Parameters:
        project_name    — "CRE" or "TDR"
        release_number  — e.g. "2026.05.00" or "TDR 2026.05.00"
        config_file     — override the default YAML config path
        dry_run         — print payloads without making HTTP calls
        meeting_filter  — if set, only this one meeting is cancelled (exact name)
        skip_confirm    — bypass the bulk-run confirmation prompt (--yes flag)

    Returns:
        dict with keys: total_flows, success_count, failed_count,
                        passed_flows, failed_flows, skipped_flows
    """
    results = {
        "total_flows":   0,
        "success_count": 0,
        "failed_count":  0,
        "passed_flows":  [],
        "failed_flows":  [],
        "skipped_flows": [],
    }

    version           = extract_version(release_number)
    display_release   = normalize_release_number(project_name, release_number)
    project_abbr      = project_name.upper()
    project_full_name = _PROJECT_FULL_NAMES.get(project_abbr, project_abbr)

    print(f"\n{HR2}")
    print(f"  {project_name.upper()} Release Meeting CANCELLATION  —  {display_release}")
    if dry_run:
        print("  *** DRY RUN — no HTTP calls will be made ***")
    if meeting_filter:
        print(f"  *** FILTER — only: '{meeting_filter}' ***")
    print(f"{HR2}\n")

    config, resolved_config_file = load_config(project_name, config_file)

    shared_cancel_url = config.get("power_automate", {}).get("cancel_flow_url", "").strip()

    # Validate the URL format before any HTTP calls are attempted
    validate_flow_url(shared_cancel_url, "power_automate.cancel_flow_url")

    if shared_cancel_url:
        print(f"  Cancel flow URL : ...{shared_cancel_url[-60:]}")
    else:
        print("  Cancel flow URL : (not set — fill in power_automate.cancel_flow_url in the YAML)")

    version_schedule = get_version_schedule(config, version)
    if not version_schedule:
        available = sorted(config.get("releases", {}).get("schedule", {}).keys())
        raise ValueError(
            f"Version '{version}' not found in releases.schedule.\n"
            f"Available: {available}"
        )

    release_entry = config.get("releases", {}).get("schedule", {}).get(version, {})
    build_version = release_entry.get("buildVersion", "")

    # project_tag is only used in subject_template formatting
    project_tag = f"[{project_abbr} {version}]"

    print(f"  Config file     : {resolved_config_file}")
    print(f"  Version         : {version}")
    print(f"  Scheduled dates : {dict(version_schedule)}")

    _rb_date = version_schedule.get("Release Branch", "")
    release_branch_name = build_release_branch_name(version, _rb_date) if _rb_date else ""
    if release_branch_name:
        print(f"  Release branch  : {release_branch_name}")
    print()

    meetings      = config.get("meetings", {})
    run_cancels   = []   # (meeting_name, date, cancel_url, payload)
    skip_meetings = []   # (meeting_name, reason)

    for name, meeting_cfg in meetings.items():
        # Must have a date in the schedule
        date = version_schedule.get(name)
        if not date:
            skip_meetings.append((name, "no date in schedule"))
            continue

        # Honour --meeting filter
        if meeting_filter and name != meeting_filter:
            skip_meetings.append((name, f"filtered out (--meeting '{meeting_filter}')"))
            continue

        if not shared_cancel_url:
            skip_meetings.append((name, "cancel_flow_url not set in power_automate config — skipped"))
            results["skipped_flows"].append({"flow_name": name, "date": date})
            continue

        start_time = meeting_cfg.get("default_start_time", "09:00:00")
        end_time   = meeting_cfg.get("default_end_time",   "10:00:00")

        subject = meeting_cfg.get("subject_template", "[{release_number}]").format(
            release_number=display_release,
            project_full_name=project_full_name,
            project_tag=project_tag,
            build_version=build_version,
        )

        payload = _build_cancel_payload(
            display_release=display_release,
            subject=subject,
            date=date,
            start_time=start_time,
            end_time=end_time,
        )

        run_cancels.append((name, date, shared_cancel_url, payload))

    warn_filter_no_match(meeting_filter, run_cancels, meetings, version)

    results["total_flows"] = len(run_cancels)

    # Pre-execution summary
    print(HR)
    print(f"  To cancel : {len(run_cancels)}")
    print(f"  To skip   : {len(skip_meetings)}")
    print(HR)
    for i, (n, *_)     in enumerate(run_cancels,   1): print(f"  {i:2}. ✓ {n}")
    for i, (n, reason) in enumerate(skip_meetings, 1): print(f"  {i:2}. ⊘ {n}  ({reason})")
    print(f"{HR}\n")

    # Confirmation gate for bulk live runs
    if not dry_run and not meeting_filter and not skip_confirm:
        if not confirm_bulk_run("CANCEL", len(run_cancels), display_release):
            sys.exit(0)

    # Trigger cancellation flows
    for idx, (meeting_name, meeting_date, cancel_url, payload) in \
            enumerate(run_cancels, 1):
        print(f"\n[{idx}/{len(run_cancels)}] CANCEL → {meeting_name}")
        print(HR)
        print(f"  Date    : {format_date_display(meeting_date)}")
        print(f"  Subject : {payload.get('subject', '')}")
        print(f"  Start   : {payload.get('start_datetime', '')}")
        print(f"  URL     : ...{cancel_url[-60:]}")

        try:
            trigger_flow(cancel_url, payload, dry_run=dry_run)
            results["success_count"] += 1
            results["passed_flows"].append({"flow_name": meeting_name, "date": meeting_date})
            print(f"  ✓ Cancellation triggered: {meeting_name}")
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

    _print_summary("CANCELLATION SUMMARY", display_release, run_cancels, skip_meetings, results)
    return results


# ══════════════════════════════════════════════════════════════════════════════
#  Entry point
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    parser = build_arg_parser(
        "Cancel Teams meetings via Power Automate HTTP cancel triggers."
    )
    args = parser.parse_args()

    configure_logging(verbose=args.verbose, log_file=args.log_file)

    if args.list_versions:
        print_available_versions(args.project, args.config)
        sys.exit(0)

    if args.list_meetings:
        print_available_meetings(args.project, args.config)
        sys.exit(0)

    results = cancel_teams_meetings(
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
# CRE — FULL CONFIG  (config_cre.yaml)
# ─────────────────────────────────────────────────────────────────────────────
#
#   Dry run — verify what would be cancelled
#   python cancel_teams_meeting.py --project CRE --release-version 2026.07.00 --dry-run
#
#   Real run (with confirmation prompt)
#   python cancel_teams_meeting.py --project CRE --release-version 2026.07.00
#
#   Real run — skip confirmation (CI / unattended)
#   python cancel_teams_meeting.py --project CRE --release-version 2026.07.00 --yes
#
#   Cancel a single specific meeting (no confirmation prompt required)
#   python cancel_teams_meeting.py --project CRE --release-version 2026.07.00 --meeting "UAT EMEA"
#
# ─────────────────────────────────────────────────────────────────────────────
# TDR — FULL CONFIG  (config_tdr.yaml)
# ─────────────────────────────────────────────────────────────────────────────
#
#   python cancel_teams_meeting.py --project TDR --release-version 2026.05.00 --dry-run
#   python cancel_teams_meeting.py --project TDR --release-version 2026.05.00 --yes
#   python cancel_teams_meeting.py --project TDR --release-version 2026.05.00 --meeting "Release Branch"
#
# ─────────────────────────────────────────────────────────────────────────────
# TEST CONFIGS  (minimal attendees — safe for flow verification)
# ─────────────────────────────────────────────────────────────────────────────
#
#   python cancel_teams_meeting.py --project TDR --release-version 2026.05.00 --config config/config_tdr_test.yaml --dry-run
#   python cancel_teams_meeting.py --project CRE --release-version 2026.07.00 --config config/config_cre_test.yaml --dry-run
#
# ─────────────────────────────────────────────────────────────────────────────
# VERBOSE / LOGGING
# ─────────────────────────────────────────────────────────────────────────────
#
#   python cancel_teams_meeting.py --project TDR --release-version 2026.05.00 --dry-run --verbose
#   python cancel_teams_meeting.py --project TDR --release-version 2026.05.00 --yes --log-file runs/cancel-2026-05-00.log
#
# ─────────────────────────────────────────────────────────────────────────────
# NOTES
#
#   SINGLE FLOW FOR ALL MEETINGS
#   ─────────────────────────────
#   You only need ONE cancel flow in Power Automate. The cancel payload is identical
#   for all meetings (subject + start_datetime + end_datetime). The flow finds the
#   event on the organiser's calendar by matching those values and deletes it.
#
#   SKIPPED MEETINGS
#   ─────────────────
#   If cancel_flow_url has not been filled in yet, all meetings are skipped
#   automatically without causing an error.
#
#   --dry-run always runs safely — no HTTP calls, no cancellations.
#   --yes     skips the confirmation prompt for unattended/CI use.
#   --meeting lets you re-run just one failed cancellation.
# ─────────────────────────────────────────────────────────────────────────────