# Teams Meeting Single HTTP

Automates creation and cancellation of Microsoft Teams release meetings by triggering **Power Automate HTTP flows** via plain HTTP POST requests — no browser, no Playwright, no UI automation.

## Overview

| Script | Purpose |
|---|---|
| `create_teams_meeting.py` | Create all scheduled Teams meetings for a release |
| `cancel_teams_meeting.py` | Cancel all scheduled Teams meetings for a release |

Both scripts are **config-driven**. All meeting definitions, attendees, time slots, and release schedules live in YAML files under the `config/` folder. The scripts read the config, build payloads, and POST them to a single shared Power Automate flow.

### Why HTTP instead of browser automation?

| | HTTP (this folder) | Browser automation |
|---|---|---|
| Speed | ~1–2 seconds per meeting | ~30–60 seconds per meeting |
| Fragility | None — pure API call | Fragile to UI changes, popups, profile locks |
| Dependencies | `requests`, `pyyaml` | Playwright, Chrome, cookies |

---

## Folder Structure

```
teams_meeting_single_http/
├── create_teams_meeting.py        # Create meetings via Power Automate HTTP trigger
├── cancel_teams_meeting.py        # Cancel meetings via Power Automate HTTP trigger
└── config/
    ├── config_cre.yaml            # CRE (Content Rate Extract) — full config (FY 2026)
    ├── config_cre_test.yaml       # CRE — test config (single flow for safe testing)
    ├── config_tdr.yaml            # TDR (Tax Data Repository) — full config (FY 2026)
    ├── config_tdr_test.yaml       # TDR — test config
    └── change_request_registry.yaml  # CR numbers and URLs keyed by release version
```

---

## Prerequisites

Install Python dependencies (one-time only):

```bash
pip install requests pyyaml
```

---

## One-Time Power Automate Setup

You need **two Power Automate flows** — one for creation, one for cancellation. Each flow is shared across **all** meetings.

### Create flow

1. In Power Automate, create a new flow with trigger: **"When an HTTP request is received"**
2. Paste the following JSON schema into the trigger's **Request Body JSON Schema**:

```json
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
```

3. Add action: **"Create a Teams meeting"** — map each field from the trigger body. Use `coalesce(triggerBody()?['optional_attendees'], '')` for optional fields.
4. Save the flow. Copy the generated HTTP POST URL.
5. Paste it as `create_flow_url` under `power_automate` in your YAML config.

> **Datetime note:** The Power Automate "Create a Teams meeting" action uses **India Standard Time (IST)**. Send plain datetime strings with no `Z` and no offset — e.g. `"2026-05-19T12:30:00"` — and the flow will interpret them as IST directly.

### Cancel flow

1. Create another flow with trigger: **"When an HTTP request is received"**
2. Use this JSON schema:

```json
{
  "type": "object",
  "properties": {
    "subject":         { "type": "string" },
    "release_version": { "type": "string" },
    "start_datetime":  { "type": "string" },
    "end_datetime":    { "type": "string" }
  }
}
```

3. Add action **"Get events (V4)"** — filter: `subject eq '@{triggerBody()['subject']}' and start/dateTime eq '@{triggerBody()['start_datetime']}'`
4. Add action **"Delete event (V3)"** using the event ID returned from step 3.
5. Save, copy the URL, paste as `cancel_flow_url` in your YAML config.

> **URL migration note (August 2025):** Microsoft is migrating HTTP trigger URLs from `logic.azure.com` to `environment.api.powerplatform.com`. Use new-format URLs. Old URLs stop working after November 2025.

---

## Usage

Run from the `teams_meeting_single_http/` directory.

### Create meetings

```bash
# TDR — full config
python create_teams_meeting.py --project TDR --release-version 2026.06.00

# CRE — full config
python create_teams_meeting.py --project CRE --release-version 2026.06.00

# Use a specific config file (e.g. test config)
python create_teams_meeting.py --project TDR --release-version 2026.06.00 --config config/config_tdr_test.yaml

# Dry run — print payloads without making HTTP calls
python create_teams_meeting.py --project TDR --release-version 2026.06.00 --dry-run

# Run a single specific meeting only
python create_teams_meeting.py --project TDR --release-version 2026.06.00 --meeting "UAT Deployment"
```

### Cancel meetings

```bash
# TDR — cancel all meetings for a release
python cancel_teams_meeting.py --project TDR --release-version 2026.06.00

# CRE — cancel all meetings
python cancel_teams_meeting.py --project CRE --release-version 2026.06.00

# Use a specific config file
python cancel_teams_meeting.py --project TDR --release-version 2026.06.00 --config config/config_tdr_test.yaml

# Dry run — verify what would be cancelled without making HTTP calls
python cancel_teams_meeting.py --project TDR --release-version 2026.06.00 --dry-run

# Cancel a single specific meeting
python cancel_teams_meeting.py --project TDR --release-version 2026.06.00 --meeting "Release Branch"
```

### Arguments

| Argument | Required | Description |
|---|---|---|
| `--project` | Yes | Project name: `CRE` or `TDR` |
| `--release-version` | Yes | Release version, e.g. `2026.06.00` |
| `--config` | No | Path to YAML config. Default: `config/config_<project>.yaml` |
| `--dry-run` | No | Print payloads without making HTTP calls |
| `--meeting` | No | Run/cancel only this named meeting (exact match) |

---

## How It Works

### create_teams_meeting.py

1. **Load config** — reads the YAML file, expanding `$ref` pointers for time slots, attendee groups, and form field sets.
2. **Look up schedule** — finds the meeting dates for the requested release version under `releases.schedule`.
3. **Build payloads** — for each meeting, constructs a JSON payload containing subject, description, attendees (semicolon-separated), start/end datetimes, and all URL fields. CR numbers from `change_request_registry.yaml` are embedded in the description where applicable.
4. **Trigger flows** — POSTs each payload to the single `create_flow_url`. Retries up to 3 times on transient failures (HTTP 429/5xx) with exponential backoff (2 s, 4 s, 8 s, timeout 30 s).
5. **Print summary** — shows pass/fail counts and per-meeting results.

### cancel_teams_meeting.py

Imports all helpers from `create_teams_meeting.py`. The cancel-specific logic:

1. Reads the same YAML config to get the meeting schedule and subject templates.
2. For each meeting with a scheduled date, builds a minimal payload: `subject` + `start_datetime` + `end_datetime`.
3. POSTs to the single `cancel_flow_url`.
4. The Power Automate flow finds the calendar event by subject and start datetime, then deletes it.

---

## Config File Structure

Each YAML config has these top-level sections:

```yaml
power_automate:
  url:              "https://make.powerautomate.com/..."   # PA environment URL
  create_flow_url:  "https://..."   # HTTP trigger URL for the shared create flow
  cancel_flow_url:  "https://..."   # HTTP trigger URL for the shared cancel flow

attendee_groups:                    # Named lists of email addresses
  group_name:
    - user@company.com

time_slots:                         # Named start/end time pairs (IST)
  slot_30_1245: { start: "12:45:00", end: "13:15:00" }

meetings:                           # Meeting definitions
  Meeting Name:
    subject_template:      "..."    # Supports {release_number}, {project_tag}, etc.
    description_template:  "..."    # Supports {release_schedule_url}, etc.
    schedule_column:       "..."    # Column name in releases.schedule
    time_slot:             $slot_30_1245   # Reference to a time_slots entry
    required_attendees:    $group_name     # Reference to an attendee_groups entry
    optional_attendees:    $group_name

releases:
  url_templates:
    release_schedule_url:   "https://..."
    release_readiness_url:  "https://.../{version}/..."
    release_notes_url:      "https://.../{version}/..."
  schedule:
    2026.06.00:
      Release Branch: 2026-05-20
      UAT Deployment: 2026-05-26
      # ... more meetings
```

### Config files by project

| File | Use case |
|---|---|
| `config_cre.yaml` | CRE production runs — full attendee lists, all releases |
| `config_cre_test.yaml` | CRE safe testing — minimal attendees for flow verification |
| `config_tdr.yaml` | TDR production runs — full attendee lists, all releases |
| `config_tdr_test.yaml` | TDR safe testing — minimal attendees for flow verification |

---

## HTTP Retry Behaviour

| Setting | Value |
|---|---|
| Timeout per request | 30 seconds |
| Retry attempts | 3 |
| Retry backoff | 2 s → 4 s → 8 s (doubles each attempt) |
| Retryable status codes | 429, 500, 502, 503, 504 |

---

## Change Request Registry

`config/change_request_registry.yaml` stores ServiceNow CR numbers keyed by release version and environment. When the script builds a meeting description, it looks up the relevant CR for that meeting type and prepends a hyperlinked CR reference:

```
[CHG0165333] - Tax Data Repository | 2026.06.00 | ...
```

The meeting-to-CR mapping is defined in `create_teams_meeting.py` under `_MEETING_TO_CONFIG_KEY`.

---

## Tips

- **Always dry-run first** — use `--dry-run` to verify subjects, dates, and attendees before triggering real flows.
- **Use test configs for setup** — `config_cre_test.yaml` / `config_tdr_test.yaml` have minimal attendee lists so you can safely verify a new flow without sending invites to the full team.
- **Single meeting re-runs** — if one meeting fails, use `--meeting "Exact Meeting Name"` to retry just that one without re-triggering the others.
- **Meetings are skipped** if they have no date entry in `releases.schedule` for the requested version, or if they are excluded by `--meeting`.
