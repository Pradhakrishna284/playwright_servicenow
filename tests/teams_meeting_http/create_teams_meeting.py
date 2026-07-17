"""
Teams Meeting Automation via Power Automate — HTTP Trigger Edition
==================================================================
Triggers Power Automate flows via HTTP POST requests instead of browser
automation. Each flow must be configured with a "When an HTTP request is
received" trigger in Power Automate, which generates a webhook URL stored
in the YAML config under each meeting's `trigger_url` key.

Why this is better than browser automation:
  - No browser, no Chrome, no Playwright — pure HTTP calls
  - ~1-2 seconds per meeting instead of ~30-60 seconds
  - Not fragile to Power Automate UI changes
  - No cookie copying, no profile locks, no popup suppression

One-time setup per flow (do this once in Power Automate):
  1. Open the flow in Power Automate
  2. Change the trigger from "Manually trigger a flow" to
     "When an HTTP request is received"
  3. Paste the JSON schema below into the trigger's schema field:
     {
       "type": "object",
       "properties": {
         "subject":                { "type": "string" },
         "description":            { "type": "string" },
         "start_date":             { "type": "string" },
         "start_time":             { "type": "string" },
         "end_date":               { "type": "string" },
         "end_time":               { "type": "string" },
         "required_attendees":     { "type": "string" },
         "optional_attendees":     { "type": "string" },
         "release_schedule_url":   { "type": "string" },
         "release_readiness_url":  { "type": "string" },
         "release_notes_url":      { "type": "string" },
         "security_scorecard_url": { "type": "string" }
       }
     }
  4. Save the flow. Power Automate generates an HTTP POST URL.
  5. Copy that URL and add it to the YAML config as `trigger_url`
     under the corresponding meeting definition.

NOTE — URL migration (August 2025):
  Microsoft is migrating HTTP trigger URLs from logic.azure.com to
  environment.api.powerplatform.com. Use the new-format URLs when
  setting up triggers. Old URLs stop working after November 2025.

Config file (single source of truth):
    config/config_tdr.yaml        — TDR meetings
    config/config_tdr_test.yaml   — TDR test config
    config/config_cre.yaml        — CRE meetings

Usage:
    python create_teams_meeting.py --project TDR --release-version 2026.05.00
    python create_teams_meeting.py --project CRE --release-version 2026.05.00
    python create_teams_meeting.py --project TDR --release-version 2026.05.00 --config config/config_tdr_test.yaml

Arguments:
    --project          Project name.            Choices: CRE, TDR
    --release-version  Release version number.  Example: 2026.05.00

Optional:
    --config           Path to YAML config file.
                       Default: config/config_<project>.yaml
    --dry-run          Print what would be sent without making HTTP calls.

Requirements:
    pip install requests pyyaml
"""

import argparse
import os
import sys
import traceback
from datetime import datetime

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

import requests
import yaml


# ── Datetime helpers ──────────────────────────────────────────────────────────
# The Power Automate "Create a Teams meeting" action has Time zone set to
# "India Standard Time" (confirmed in PA flow UI). So we send plain datetime
# strings with no Z and no offset — PA interprets them as IST directly.
#
#   start_datetime = "2026-05-19T12:30:00"  → PA creates meeting at 12:30 IST
#   end_datetime   = "2026-05-19T13:00:00"  → PA ends meeting at  13:00 IST

def _build_datetime_str(date_str: str, time_str: str) -> str:
    """
    Combine date and time into a plain ISO 8601 datetime string.
    No timezone suffix — the PA flow's hardcoded "India Standard Time"
    timezone setting handles interpretation.

    Example: date="2026-05-19", time="12:30:00"
             → "2026-05-19T12:30:00"
    """
    return f"{date_str}T{time_str}"


# ── HTTP settings ─────────────────────────────────────────────────────────────
HTTP_TIMEOUT   = 30    # seconds — per-request timeout
HTTP_RETRIES   = 3     # retry attempts on transient failures
RETRY_BACKOFF  = 2     # seconds between retries (doubles each attempt)

_CONFIG_PATHS = {
    "TDR": "config/config_tdr_test.yaml",
    "CRE": "config/config_cre.yaml",
}

# HTTP status codes that are safe to retry
_RETRYABLE_CODES = {429, 500, 502, 503, 504}


# ══════════════════════════════════════════════════════════════════════════════
#  Config loading
# ══════════════════════════════════════════════════════════════════════════════

def get_config_path(project_name: str) -> str:
    return _CONFIG_PATHS.get(project_name.upper(),
                             f"config/config_{project_name.lower()}.yaml")


def _resolve(value, lookup: dict, section: str):
    """Replace a '$name' string with the value from lookup; warn on miss."""
    if isinstance(value, str) and value.startswith("$"):
        key = value[1:]
        if key in lookup:
            return lookup[key]
        print(f"  ⚠ Reference '{value}' not found in {section} — left unresolved.")
    return value


def load_config(project_name: str, config_file: str = None) -> dict:
    """
    Load and fully expand a YAML project config.

    Expansions applied in order for each meeting:
      1. time_slot ref  → default_start_time / default_end_time
      2. attendee group refs
      3. form field set ref
    """
    path = config_file or get_config_path(project_name)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Config file not found: '{path}'")

    with open(path, encoding="utf-8") as fh:
        config = yaml.safe_load(fh)

    attendee_groups = config.get("attendee_groups", {})
    form_field_sets = config.get("form_field_sets", {})
    time_slots      = config.get("time_slots", {})

    for name, mtg in config.get("meetings", {}).items():
        slot_ref = mtg.pop("time_slot", None)
        if slot_ref:
            slot = _resolve(slot_ref, time_slots, "time_slots")
            if isinstance(slot, dict):
                mtg["default_start_time"] = slot["start"]
                mtg["default_end_time"]   = slot["end"]
            else:
                print(f"  ⚠ time_slot for '{name}' could not be resolved.")

        mtg["required_attendees"] = _resolve(
            mtg.get("required_attendees", []), attendee_groups, "attendee_groups"
        )
        if "optional_attendees" in mtg:
            mtg["optional_attendees"] = _resolve(
                mtg["optional_attendees"], attendee_groups, "attendee_groups"
            )

        mtg["form_fields"] = _resolve(
            mtg.get("form_fields", []), form_field_sets, "form_field_sets"
        )

    print(f"✓ Config loaded: '{path}'")
    return config


# ══════════════════════════════════════════════════════════════════════════════
#  Release / version helpers
# ══════════════════════════════════════════════════════════════════════════════

def normalize_release_number(project_name: str, release_number: str) -> str:
    prefix = project_name.upper() + " "
    return release_number if release_number.startswith(prefix) else prefix + release_number


def extract_version(release_number: str) -> str:
    parts = release_number.split()
    return parts[-1] if len(parts) > 1 else release_number


def decrement_version(version: str) -> str:
    try:
        y, m, d = version.split(".")
        year, month = int(y), int(m)
        year, month = (year - 1, 12) if month == 1 else (year, month - 1)
        return f"{year}.{month:02d}.{d}"
    except Exception as exc:
        print(f"  ⚠ decrement_version('{version}'): {exc}")
        return version


def build_release_branch_name(version: str, release_branch_date: str) -> str:
    """
    Build the release branch name from the version and the Release Branch date.

    Format: release/<month+1 zero-padded>.<yyyymmdd>-B

    The prefix number is the *next* month (i.e. version month + 1), mirroring
    the convention used in practice:
      2026.05.00  Release Branch date 2026-05-20  →  release/06.20260520-B
      2026.06.00  Release Branch date 2026-06-17  →  release/07.20260617-B
      2026.12.00  Release Branch date 2026-12-16  →  release/01.20261216-B

    Args:
        version:             e.g. "2026.05.00"
        release_branch_date: e.g. "2026-05-20"

    Returns:
        e.g. "release/06.20260520-B"
    """
    try:
        month = int(version.split(".")[1])
        next_month = (month % 12) + 1          # 12 → 1, everything else +1
        date_compact = release_branch_date.replace("-", "")   # "2026-05-20" → "20260520"
        return f"release/{next_month:02d}.{date_compact}-B"
    except Exception as exc:
        print(f"  ⚠ build_release_branch_name('{version}', '{release_branch_date}'): {exc}")
        return ""


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
    else:
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
    Format: [CHG0165333] - Tax Data Repository | 2026.05.00 | ...
    where only [CHG0165333] is clickable.
    """
    return f'<a href="{cr_url}">[{cr_number}]</a> - {short_desc}<br><br>'


# ══════════════════════════════════════════════════════════════════════════════
#  Schedule lookup
# ══════════════════════════════════════════════════════════════════════════════

def get_version_schedule(config: dict, version: str) -> dict:
    """Return the flat {meeting_name: date} dict for a version in one traversal."""
    entry  = config.get("releases", {}).get("schedule", {}).get(version, {})
    nested = entry.get("meeting_dates")
    return nested if nested is not None else entry


# ══════════════════════════════════════════════════════════════════════════════
#  Date formatting
# ══════════════════════════════════════════════════════════════════════════════

def format_date_display(date_str) -> str:
    if not date_str:
        return "N/A"
    try:
        d   = datetime.strptime(str(date_str), "%Y-%m-%d")
        day = d.day
        if 11 <= day <= 13:
            suffix = "th"
        else:
            suffix = {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
        return f"{day}{suffix} {d.strftime('%b %Y')}"
    except ValueError:
        return str(date_str)


# ══════════════════════════════════════════════════════════════════════════════
#  HTTP trigger — core
# ══════════════════════════════════════════════════════════════════════════════

def _build_payload(meeting_name: str, meeting_cfg: dict, flow_data: dict) -> dict:
    """
    Build the JSON payload for the HTTP POST from flow_data.

    Only the fields listed in the meeting's form_fields are included so the
    flow receives exactly what it expects — nothing more, nothing less.
    Attendee lists are joined to comma-separated strings since Power Automate
    HTTP triggers receive plain string inputs.
    """
    form_fields = meeting_cfg.get("form_fields", [])
    payload = {}

    for key in form_fields:
        value = flow_data.get(key)
        if not value:
            continue
        # Attendee lists → comma-separated string for PA input
        if isinstance(value, list):
            value = ";".join(value)
        payload[key] = str(value)

    return payload


def trigger_flow(trigger_url: str, payload: dict,
                 dry_run: bool = False) -> bool:
    """
    POST the payload to the flow's HTTP trigger URL.

    Returns True on success (HTTP 2xx or 202 Accepted).
    Retries on transient failures (429, 5xx) with exponential backoff.
    """
    import time

    if dry_run:
        print(f"  [DRY RUN] Would POST to: {trigger_url[:80]}...")
        print(f"  [DRY RUN] Payload: {payload}")
        return True

    delay = RETRY_BACKOFF
    for attempt in range(1, HTTP_RETRIES + 1):
        try:
            resp = requests.post(
                trigger_url,
                json=payload,
                timeout=HTTP_TIMEOUT,
                headers={"Content-Type": "application/json"},
            )

            # Power Automate HTTP triggers return 202 Accepted on success
            if resp.status_code in (200, 202):
                print(f"  ✓ Flow triggered  (HTTP {resp.status_code})")
                return True

            if resp.status_code in _RETRYABLE_CODES and attempt < HTTP_RETRIES:
                print(f"  ⚠ HTTP {resp.status_code} — retry {attempt}/{HTTP_RETRIES} in {delay}s...")
                time.sleep(delay)
                delay *= 2
                continue

            # Non-retryable error
            raise RuntimeError(
                f"HTTP {resp.status_code}: {resp.text[:200]}"
            )

        except requests.exceptions.Timeout:
            if attempt < HTTP_RETRIES:
                print(f"  ⚠ Timeout — retry {attempt}/{HTTP_RETRIES} in {delay}s...")
                time.sleep(delay)
                delay *= 2
            else:
                raise RuntimeError(f"Request timed out after {HTTP_TIMEOUT}s")

        except requests.exceptions.ConnectionError as exc:
            if attempt < HTTP_RETRIES:
                print(f"  ⚠ Connection error — retry {attempt}/{HTTP_RETRIES} in {delay}s...")
                time.sleep(delay)
                delay *= 2
            else:
                raise RuntimeError(f"Connection failed: {exc}")

    return False


# ══════════════════════════════════════════════════════════════════════════════
#  Core flow runner
# ══════════════════════════════════════════════════════════════════════════════

def run_flow(
    meeting_name:  str,
    meeting_date:  str,
    meeting_cfg:   dict,
    flow_data:     dict,
    dry_run:       bool = False,
) -> None:
    """
    Trigger one Power Automate flow via its HTTP trigger URL.

    Raises RuntimeError if trigger_url is missing from the meeting config
    or if the HTTP call fails after all retries.
    """
    trigger_url = meeting_cfg.get("trigger_url", "").strip()
    if not trigger_url:
        raise RuntimeError(
            f"No trigger_url set for '{meeting_name}'.\n"
            f"  Set up the HTTP trigger in Power Automate and add the URL\n"
            f"  as 'trigger_url' under this meeting in the YAML config."
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

def create_teams_meeting(project_name: str, release_number: str,
                         config_file: str = None,
                         dry_run: bool = False,
                         meeting_filter: str = None) -> dict:
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

    print(f"\n{'='*70}")
    print(f"  {project_name.upper()} Release Meeting Automation  —  {display_release}")
    if dry_run:
        print(f"  *** DRY RUN — no HTTP calls will be made ***")
    if meeting_filter:
        print(f"  *** FILTER — only: '{meeting_filter}' ***")
    print(f"{'='*70}\n")

    config = load_config(project_name, config_file)

    resolved_config_file = config_file or get_config_path(project_name)
    cr_registry = load_cr_registry(resolved_config_file)

    # Extract version schedule once
    version_schedule = get_version_schedule(config, version)
    if not version_schedule:
        available = sorted(config.get("releases", {}).get("schedule", {}).keys())
        raise ValueError(
            f"Version '{version}' not found in releases.schedule.\n"
            f"Available: {available}"
        )

    # ── Diagnostics — printed so you can confirm the right config is loaded ──
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

    # Compute the release branch name once from the schedule's Release Branch date.
    # Format: release/<month+1 zero-padded>.<yyyymmdd>-B
    # Example: 2026.05.00, Release Branch date 2026-05-20 → release/06.20260520-B
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
        if name == "QA Data Refresh" and not version_schedule.get("RK QA Change Creation"):
            skip_meetings.append((name, "RK QA Change Creation is empty"))
            continue

        start_time = meeting_cfg.get("default_start_time", "09:00:00")
        end_time   = meeting_cfg.get("default_end_time",   "10:00:00")

        base_description = meeting_cfg["description_template"].format(
            release_number=release_number,
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

        # Build datetime strings and pass the timezone name separately.
        # The Power Automate flow uses startTimeZone="India Standard Time" so
        # Teams stores and displays the meeting in IST for all attendees.
        start_datetime = _build_datetime_str(str(date), start_time)
        end_datetime   = _build_datetime_str(str(date), end_time)

        flow_data = {
            "subject": meeting_cfg.get("subject_template", "[{release_number}]").format(
                release_number=display_release
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

        run_meetings.append((name, str(date), meeting_cfg, flow_data))

    results["total_flows"] = len(run_meetings)

    # Pre-execution summary
    print(f"{'─'*70}")
    print(f"  To run   : {len(run_meetings)}")
    print(f"  To skip  : {len(skip_meetings)}")
    print(f"{'─'*70}")
    for i, (n, *_)     in enumerate(run_meetings,  1): print(f"  {i:2}. ✓ {n}")
    for i, (n, reason) in enumerate(skip_meetings, 1): print(f"  {i:2}. ⊘ {n}  ({reason})")
    print(f"{'─'*70}\n")

    # Trigger flows
    for idx, (meeting_name, meeting_date, meeting_cfg, flow_data) in enumerate(run_meetings, 1):
        print(f"\n[{idx}/{len(run_meetings)}] {meeting_name}")
        print(f"{'─'*70}")
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

    # Final summary
    print(f"\n{'='*70}")
    print(f"  SUMMARY  —  {display_release}")
    print(f"{'='*70}")
    print(f"  Total available : {len(run_meetings) + len(skip_meetings)}")
    print(f"  Skipped         : {len(skip_meetings)}")
    print(f"  Executed        : {len(run_meetings)}")
    print(f"  Passed          : {results['success_count']}")
    print(f"  Failed          : {results['failed_count']}")
    if run_meetings:
        pct = results["success_count"] / len(run_meetings) * 100
        print(f"  Pass rate       : {pct:.1f}%")
    print(f"{'─'*70}")
    for i, info in enumerate(results["passed_flows"], 1):
        print(f"  {i:2}. ✓ {info['flow_name']}  ({format_date_display(info['date'])})")
    for i, info in enumerate(results["failed_flows"], 1):
        print(f"  {i:2}. ✗ {info['flow_name']}  ({format_date_display(info['date'])})")
        print(f"        Error: {info['error']}")
    for i, (n, reason) in enumerate(skip_meetings, 1):
        print(f"  {i:2}. ⊘ {n}  ({reason})")
    print(f"{'='*70}\n")

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
                        help="Release version number.\nExample: 2026.05.00")
    parser.add_argument("--config",          default=None,
                        help="Path to YAML config file (optional).\n"
                             "Default: config/config_<project>.yaml")
    parser.add_argument("--dry-run",         action="store_true",
                        help="Print what would be sent without making HTTP calls.\n"
                             "Useful for verifying config before a real run.")
    parser.add_argument("--meeting",         default=None,
                        help="Run only the named meeting (exact match).\n"
                             "Example: --meeting \"CCA Details\"")
    args = parser.parse_args()

    create_teams_meeting(
        args.project,
        args.release_version,
        args.config,
        dry_run=args.dry_run,
        meeting_filter=args.meeting,
    )

# ── How to run ────────────────────────────────────────────────────────────────
#
# SETUP
#   Step 1: Navigate to the project folder
#           cd teams_meeting_http
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
#   python create_teams_meeting.py --project TDR --release-version 2026.05.00 --config config/config_tdr_test.yaml --dry-run
#
#   Real run — trigger all meetings that have dates in the schedule
#   python create_teams_meeting.py --project TDR --release-version 2026.05.00 --config config/config_tdr_test.yaml
#
#   Run a single specific meeting
#   python create_teams_meeting.py --project TDR --release-version 2026.05.00 --config config/config_tdr_test.yaml --meeting "Determination Enterprise Cloud Component Details"
#   python create_teams_meeting.py --project TDR --release-version 2026.05.00 --config config/config_tdr_test.yaml --meeting "SDI & GPG Details"
#   python create_teams_meeting.py --project TDR --release-version 2026.05.00 --config config/config_tdr_test.yaml --meeting "CCA Details"
#
# ─────────────────────────────────────────────────────────────────────────────
# TDR — FULL CONFIG  (config_tdr.yaml)  |  12 releases  |  FY 2026
# Use this for actual release runs once all 19 trigger URLs are set up.
# ─────────────────────────────────────────────────────────────────────────────
#
#   # 2026.01.00  (17 meetings scheduled)
#   python create_teams_meeting.py --project TDR --release-version 2026.01.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.01.00 --config config/config_tdr.yaml
#
#   # 2026.02.00  (18 meetings scheduled)
#   python create_teams_meeting.py --project TDR --release-version 2026.02.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.02.00 --config config/config_tdr.yaml
#
#   # 2026.03.00  (16 meetings scheduled)
#   python create_teams_meeting.py --project TDR --release-version 2026.03.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.03.00 --config config/config_tdr.yaml
#
#   # 2026.04.00  (18 meetings scheduled)
#   python create_teams_meeting.py --project TDR --release-version 2026.04.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.04.00 --config config/config_tdr.yaml
#
#   # 2026.05.00  (17 meetings scheduled)
#   python create_teams_meeting.py --project TDR --release-version 2026.05.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.05.00 --config config/config_tdr.yaml
#
#   # 2026.06.00  (19 meetings scheduled)
#   python create_teams_meeting.py --project TDR --release-version 2026.06.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.06.00 --config config/config_tdr.yaml
#
#   # 2026.07.00  (17 meetings scheduled)
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.07.00 --config config/config_tdr.yaml
#
#   # 2026.08.00  (19 meetings scheduled)
#   python create_teams_meeting.py --project TDR --release-version 2026.08.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.08.00 --config config/config_tdr.yaml
#
#   # 2026.09.00  (17 meetings scheduled)
#   python create_teams_meeting.py --project TDR --release-version 2026.09.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.09.00 --config config/config_tdr.yaml
#
#   # 2026.10.00  (19 meetings scheduled)
#   python create_teams_meeting.py --project TDR --release-version 2026.10.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.10.00 --config config/config_tdr.yaml
#
#   # 2026.11.00  (17 meetings scheduled)
#   python create_teams_meeting.py --project TDR --release-version 2026.11.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.11.00 --config config/config_tdr.yaml
#
#   # 2026.12.00  (18 meetings scheduled)
#   python create_teams_meeting.py --project TDR --release-version 2026.12.00 --config config/config_tdr.yaml --dry-run
#   python create_teams_meeting.py --project TDR --release-version 2026.12.00 --config config/config_tdr.yaml
#
# ─────────────────────────────────────────────────────────────────────────────
# CRE — TEST CONFIG  (config_cre_test.yaml)
# Use this while setting up and testing individual flows.
# ─────────────────────────────────────────────────────────────────────────────
#
#   Dry run — verify config and payload without triggering any flows
#   python create_teams_meeting.py --project CRE --release-version 2026.05.00 --config config/config_cre_test.yaml --dry-run
#
#   Real run — trigger all meetings that have dates in the schedule
#   python create_teams_meeting.py --project CRE --release-version 2026.05.00 --config config/config_cre_test.yaml
#
#   Run a single specific meeting
#   python create_teams_meeting.py --project CRE --release-version 2026.05.00 --config config/config_cre_test.yaml --meeting "Inform CRE team about freeze activities"
#   python create_teams_meeting.py --project CRE --release-version 2026.05.00 --config config/config_cre_test.yaml --meeting "CRE freeze activities Meeting"
#
# ─────────────────────────────────────────────────────────────────────────────
# CRE — FULL CONFIG  (config_cre.yaml)  |  10 releases  |  FY 2026
# Use this for actual release runs once all 15 trigger URLs are set up.
# ─────────────────────────────────────────────────────────────────────────────
#
#   # 2026.01.00  (14 meetings scheduled)
#   python create_teams_meeting.py --project CRE --release-version 2026.01.00 --config config/config_cre.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.01.00 --config config/config_cre.yaml
#
#   # 2026.02.00  (14 meetings scheduled)
#   python create_teams_meeting.py --project CRE --release-version 2026.02.00 --config config/config_cre.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.02.00 --config config/config_cre.yaml
#
#   # 2026.03.00  (14 meetings scheduled)
#   python create_teams_meeting.py --project CRE --release-version 2026.03.00 --config config/config_cre.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.03.00 --config config/config_cre.yaml
#
#   # 2026.04.00  (14 meetings scheduled)
#   python create_teams_meeting.py --project CRE --release-version 2026.04.00 --config config/config_cre.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.04.00 --config config/config_cre.yaml
#
#   # 2026.05.00  (14 meetings scheduled)
#   python create_teams_meeting.py --project CRE --release-version 2026.05.00 --config config/config_cre.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.05.00 --config config/config_cre.yaml
#
#   # 2026.06.00  (14 meetings scheduled)
#   python create_teams_meeting.py --project CRE --release-version 2026.06.00 --config config/config_cre.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.06.00 --config config/config_cre.yaml
#
#   # 2026.07.00  (14 meetings scheduled)
#   python create_teams_meeting.py --project CRE --release-version 2026.07.00 --config config/config_cre.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.07.00 --config config/config_cre.yaml
#
#   # 2026.08.00  (14 meetings scheduled)
#   python create_teams_meeting.py --project CRE --release-version 2026.08.00 --config config/config_cre.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.08.00 --config config/config_cre.yaml
#
#   # 2026.09.00  (14 meetings scheduled)
#   python create_teams_meeting.py --project CRE --release-version 2026.09.00 --config config/config_cre.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.09.00 --config config/config_cre.yaml
#
#   # 2026.10.00  (14 meetings scheduled)
#   python create_teams_meeting.py --project CRE --release-version 2026.10.00 --config config/config_cre.yaml --dry-run
#   python create_teams_meeting.py --project CRE --release-version 2026.10.00 --config config/config_cre.yaml
#
# ─────────────────────────────────────────────────────────────────────────────
# NOTES
#   --dry-run        Prints the payload that would be sent — no HTTP calls made.
#                    Always run this first to verify before a real run.
#   --meeting        Run only one named meeting. Exact match required.
#                    Useful for re-running a failed meeting without re-triggering
#                    the ones that already succeeded.
#   --config         Path to the YAML config file, relative to teams_meeting_http/.
#   --release-version  Version number only — no project prefix needed.
#                      The script adds "TDR " or "CRE " prefix automatically.
# ─────────────────────────────────────────────────────────────────────────────
