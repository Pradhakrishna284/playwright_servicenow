"""
Shared utilities for Teams Meeting HTTP automation.

Used by both create_teams_meeting.py and cancel_teams_meeting.py.
Do not add script-specific logic here.
"""

import os
import time
from datetime import datetime

import requests
import yaml


# ── Display separators ────────────────────────────────────────────────────────
HR  = "─" * 70   # thin rule  (section dividers, per-meeting)
HR2 = "=" * 70   # thick rule (top/bottom of summary blocks)


# ── HTTP settings ─────────────────────────────────────────────────────────────
# The Power Automate "Create a Teams meeting" action has Time zone set to
# "India Standard Time" (confirmed in PA flow UI). So we send plain datetime
# strings with no Z and no offset — PA interprets them as IST directly.
#
#   start_datetime = "2026-05-19T12:30:00"  → PA creates meeting at 12:30 IST
#   end_datetime   = "2026-05-19T13:00:00"  → PA ends meeting at  13:00 IST
HTTP_TIMEOUT   = 30    # seconds — per-request timeout
HTTP_RETRIES   = 3     # retry attempts on transient failures
RETRY_BACKOFF  = 2     # seconds between retries (doubles each attempt)

# HTTP status codes that are safe to retry
_RETRYABLE_CODES = {429, 500, 502, 503, 504}

_CONFIG_PATHS = {
    "TDR": "config/config_tdr.yaml",
    "CRE": "config/config_cre.yaml",
}

_PROJECT_FULL_NAMES = {
    "CRE": "Content Rate Extract",
    "TDR": "Tax Data Repository",
}


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


def load_config(project_name: str, config_file: str = None) -> tuple[dict, str]:
    """
    Load and fully expand a YAML project config.

    Returns (config_dict, resolved_path) so callers never need to re-derive
    the path themselves.

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
    return config, path


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

    The prefix number is the *next* month (i.e. version month + 1):
      2026.06.00  Release Branch date 2026-05-20  →  release/06.20260520-B
      2026.12.00  Release Branch date 2026-12-16  →  release/01.20261216-B
    """
    try:
        month = int(version.split(".")[1])
        next_month   = (month % 12) + 1
        date_compact = release_branch_date.replace("-", "")
        return f"release/{next_month:02d}.{date_compact}-B"
    except Exception as exc:
        print(f"  ⚠ build_release_branch_name('{version}', '{release_branch_date}'): {exc}")
        return ""


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
        suffix = "th" if 11 <= day <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
        return f"{day}{suffix} {d.strftime('%b %Y')}"
    except ValueError:
        return str(date_str)


# ══════════════════════════════════════════════════════════════════════════════
#  HTTP trigger — core
# ══════════════════════════════════════════════════════════════════════════════

def trigger_flow(trigger_url: str, payload: dict, dry_run: bool = False) -> bool:
    """
    POST the payload to the flow's HTTP trigger URL.

    Returns True on success (HTTP 2xx / 202 Accepted).
    Retries on transient failures (429, 5xx) with exponential backoff.
    """
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

            if resp.status_code in (200, 202):
                print(f"  ✓ Flow triggered  (HTTP {resp.status_code})")
                return True

            if resp.status_code in _RETRYABLE_CODES and attempt < HTTP_RETRIES:
                print(f"  ⚠ HTTP {resp.status_code} — retry {attempt}/{HTTP_RETRIES} in {delay}s...")
                time.sleep(delay)
                delay *= 2
                continue

            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")

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
#  Shared summary printer
# ══════════════════════════════════════════════════════════════════════════════

def _print_summary(
    title: str,
    display_release: str,
    run_list: list,
    skip_meetings: list,
    results: dict,
) -> None:
    """Print the final execution summary (shared by create and cancel scripts)."""
    print(f"\n{HR2}")
    print(f"  {title}  —  {display_release}")
    print(HR2)
    print(f"  Total available : {len(run_list) + len(skip_meetings)}")
    print(f"  Skipped         : {len(skip_meetings)}")
    print(f"  Executed        : {len(run_list)}")
    print(f"  Passed          : {results['success_count']}")
    print(f"  Failed          : {results['failed_count']}")
    if run_list:
        pct = results["success_count"] / len(run_list) * 100
        print(f"  Pass rate       : {pct:.1f}%")
    print(HR)
    for i, info in enumerate(results["passed_flows"], 1):
        print(f"  {i:2}. ✓ {info['flow_name']}  ({format_date_display(info['date'])})")
    for i, info in enumerate(results["failed_flows"], 1):
        print(f"  {i:2}. ✗ {info['flow_name']}  ({format_date_display(info['date'])})")
        print(f"        Error: {info['error']}")
    for i, (n, reason) in enumerate(skip_meetings, 1):
        print(f"  {i:2}. ⊘ {n}  ({reason})")
    print(f"{HR2}\n")


# ══════════════════════════════════════════════════════════════════════════════
#  Discovery helpers  (--list-versions / --list-meetings)
# ══════════════════════════════════════════════════════════════════════════════

def print_available_versions(project_name: str, config_file: str = None) -> None:
    """Print all release versions defined in releases.schedule."""
    config, path = load_config(project_name, config_file)
    versions = sorted(config.get("releases", {}).get("schedule", {}).keys())
    print(f"\nAvailable versions for {project_name.upper()}  ({path}):")
    if versions:
        for v in versions:
            print(f"  {v}")
    else:
        print("  (none found — check releases.schedule in the config)")


def print_available_meetings(project_name: str, config_file: str = None) -> None:
    """Print all meeting names defined in meetings."""
    config, path = load_config(project_name, config_file)
    meetings = list(config.get("meetings", {}).keys())
    print(f"\nMeetings defined in config  ({path})  [{len(meetings)} total]:")
    for i, name in enumerate(meetings, 1):
        print(f"  {i:2}. {name}")
