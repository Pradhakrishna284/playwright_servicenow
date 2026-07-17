# TDR Playwright Automation

Automates **Change Request (CR) creation, CTask management, and Risk Assessment submission** in ServiceNow for Tax Data Repository (TDR) data refresh operations.

TDR configs run in **mandatory sequential order** — each environment depends on the previous one completing successfully:

```
GENERATE_DUMP_PROD → UAT Data Refresh → QA Data Refresh
```

> **New to Playwright?** See the [Playwright Primer](#playwright-primer) section before you start.  
> **Checking in for the first time?** Jump to [Checking In to GitHub](#checking-in-to-github).

---

## Table of Contents

1. [Playwright Primer](#playwright-primer)
2. [Project Structure](#project-structure)
3. [Prerequisites](#prerequisites)
4. [Installing Dependencies](#installing-dependencies)
5. [First-Time Setup](#first-time-setup)
6. [Environment Variables](#environment-variables)
7. [Running the Tests](#running-the-tests)
8. [How It Works](#how-it-works)
9. [Updating Release Data](#updating-release-data)
10. [Configs and CTasks](#configs-and-ctasks)
11. [Files Reference](#files-reference)
12. [Troubleshooting](#troubleshooting)
13. [Checking In to GitHub](#checking-in-to-github)
14. [Demo Notes](#demo-notes)

---

## Playwright Primer

If you have never used Playwright before, here is what you need to know:

- **Playwright** is a Node.js library for automating browsers (Chrome, Firefox, Edge). This project uses Google Chrome.
- **Tests** are TypeScript files ending in `.spec.ts`. Each test opens a real Chrome window and clicks through ServiceNow the same way a human would.
- **`npx playwright test`** is the main command to run tests. You never need to open a browser manually.
- **`--headed`** means you can see the browser window while the test runs. Omit it for headless (invisible) mode.
- **`--grep`** lets you run only tests whose name matches a pattern, e.g. `--grep "\[UAT\]"`.
- **`--workers=N`** controls how many browser windows open in parallel.
- **`--list`** lists tests without running them — useful for a quick sanity check.
- **`storageState`** is Playwright's way of reusing a saved login session so you only have to log in once.
- **HTML Report** (`npx playwright show-report`) gives you a step-by-step replay of every test run, with screenshots and traces on failure.

---

## Project Structure

```
playwright_servicenow/              ← repo root
├── playwright.config.ts            ← shared config (CRE + TDR projects, workers, reporters)
├── package.json                    ← Node.js dependencies
├── tsconfig.json                   ← TypeScript compiler settings
├── .env                            ← SSO credentials — LOCAL ONLY, never commit
├── .env.example                    ← safe template to share with the team
├── .gitignore                      ← excludes .env, auth files, reports, node_modules
│
├── tests/
│   ├── sso_setup.ts                ← shared SSO login — saves auth_servicenow.json
│   ├── helpers.ts                  ← shared browser helper functions
│   │
│   └── servicenow_tdr/             ← TDR test folder (you are here)
│       ├── changeRequest.spec.ts   ← creates the Change Request in ServiceNow
│       ├── ctasks.spec.ts          ← adds CTasks to an existing CR
│       ├── riskmanagement.spec.ts  ← submits Risk Assessment and "Submit for Assess"
│       ├── testDataConfig_TDR.ts   ← all test data, date calculations, CTask config
│       ├── tdr_release_schedule.yaml ← release dates (update every sprint)
│       ├── tdr_flow.html           ← interactive flow diagram (open in browser)
│       └── README.md               ← this file
```

**Generated at runtime — not committed to Git:**
- `auth_servicenow.json` — saved browser session (valid ~8 hours, shared with CRE)
- `servicenow_tdr/change_request_registry.yaml` — CR numbers created per run
- `playwright-report/` — HTML test report
- `test-results/` — raw test artefacts (screenshots, videos, traces on failure)

---

## Prerequisites

Everything listed below must be in place **before** running `npm install`.

### 1. Node.js >= 18 (LTS recommended)

| OS | Download |
|---|---|
| Windows | https://nodejs.org → click **LTS** |
| macOS | `brew install node` or https://nodejs.org |

Verify after installation:

```powershell
node --version   # must print v18.x or higher
npm --version    # must print 9.x or higher
```

> **Why >= 18?** The code uses `fs.writeFileSync` with the `'wx'` flag and ES2020 features. Node 16 and below will fail with syntax errors.

---

### 2. Google Chrome (latest)

Playwright is configured with `channel: 'chrome'` — it drives your **system-installed Chrome**, not a bundled browser.  
This is required because corporate policy blocks Playwright's bundled Chromium binary.

- Download: https://www.google.com/chrome/
- Version: any recent stable release (120+)
- You do **not** need to run `npx playwright install`

> **Verify Chrome is on PATH (Windows):**
> ```powershell
> & "C:\Program Files\Google\Chrome\Application\chrome.exe" --version
> ```

---

### 3. Git

Required to clone the repository and create branches.

- Windows: https://git-scm.com/download/win — accept all defaults during install
- Verify: `git --version`

---

### 4. A code editor (VS Code recommended)

- Download: https://code.visualstudio.com
- Recommended extensions:
  - **Playwright Test for VS Code** (`ms-playwright.playwright`) — run/debug tests from the IDE
  - **YAML** (`redhat.vscode-yaml`) — schema validation for `.yaml` files
  - **ESLint** (`dbaeumer.vscode-eslint`) — catch TypeScript errors inline

---

### 5. ServiceNow access

You must have a login to `trenterprise.service-now.com`.  
Request access from your IT help desk if you do not already have it.

---

### 6. PingID MFA enrolled

SSO setup triggers a PingID push notification to your phone.  
Enroll at https://pingid.pingidentity.com if not already done.

---

## Installing Dependencies

Run **once** from the **repo root** (`playwright_servicenow/`):

```powershell
cd playwright_servicenow
npm install
```

This installs all packages listed in `package.json`:

| Package | Version | Purpose |
|---|---|---|
| `@playwright/test` | ^1.57.0 | Test runner, browser automation, assertions |
| `js-yaml` | ^4.1.1 | Parse `tdr_release_schedule.yaml` and `change_request_registry.yaml` |
| `@types/js-yaml` | ^4.0.9 | TypeScript type definitions for js-yaml |
| `dotenv` | ^17.2.3 | Load `.env` credentials into `process.env` at startup |
| `zod` | ^4.3.6 | Runtime schema validation for the YAML release schedule |
| `xlsx` | ^0.18.5 | Excel/spreadsheet support (used by other scripts in this repo) |
| `typescript` | ^6.0.2 | TypeScript compiler (dev) |
| `@types/node` | ^25.0.3 | TypeScript definitions for Node.js built-ins (fs, path, etc.) |

> **No `npx playwright install` needed.**  
> Because `channel: 'chrome'` is set in `playwright.config.ts`, Playwright uses the Chrome binary already on your machine. Downloading Playwright's bundled browsers is not required and may be blocked by the corporate proxy.

---

## First-Time Setup

### Step 1 — Clone the repository

```powershell
git clone <repository-url>
cd playwright_servicenow
```

### Step 2 — Install dependencies

```powershell
npm install
```

### Step 3 — Create your `.env` file

The `.env` file stores your SSO credentials locally. It is listed in `.gitignore` and will never be committed.

```powershell
# Windows PowerShell — create the file
New-Item .env -ItemType File
notepad .env
```

Paste the following template and fill in your own values:

```dotenv
SSO_USERNAME="YOUR_EMPLOYEE_ID"
SSO_PASSWORD="YOUR_SSO_PASSWORD"
SSO_URL="https://sso.thomsonreuters.com/idp/SSO.saml2"
```

| Variable | Value |
|---|---|
| `SSO_USERNAME` | Your TR employee ID (e.g. `6106377`) |
| `SSO_PASSWORD` | Your Windows / SSO login password |
| `SSO_URL` | `https://sso.thomsonreuters.com/idp/SSO.saml2` (do not change) |

> **Security:** Never paste your `.env` values into Slack, Teams, code review comments, or commit messages.  
> If you accidentally commit `.env`, contact your security team immediately.

### Step 4 — Run SSO Setup (once per session, valid ~8 hours)

This opens Chrome, logs in to ServiceNow via SSO, saves the browser session, then closes.

```powershell
npx playwright test tests/sso_setup.ts --project=setup --headed
```

**What happens:**
1. Chrome opens automatically.
2. SSO credentials from `.env` are used to log in.
3. **Approve the PingID push notification on your phone** (required).
4. Chrome closes and `auth_servicenow.json` is written to the repo root.

> **Shared session:** `auth_servicenow.json` is shared between CRE and TDR tests. If you already ran SSO setup today for CRE, skip this step.  
> **Stale session:** If any spec redirects you to the login page mid-run, re-run this step.

---

## Environment Variables

All environment variables are set in PowerShell **inline** before the test command (they are not persisted after the terminal session closes).

| Variable | Required by | Example | Description |
|---|---|---|---|
| `RELEASE_VERSION` | `changeRequest.spec.ts`, `ctasks.spec.ts` | `2026.06.00` | Target release — must match a key in `tdr_release_schedule.yaml` |
| `CR_CONFIG` | `ctasks.spec.ts`, `riskmanagement.spec.ts` | `UAT,QA` | Comma-separated config names for CTask/Risk runs; looked up from registry |
| `CR_NUMBERS` | `ctasks.spec.ts`, `riskmanagement.spec.ts` | `CHG0233029,CHG0233030` | Explicit CR numbers; bypasses registry lookup |
| `CR_NUMBER` | `ctasks.spec.ts`, `riskmanagement.spec.ts` | `CHG0233029` | Legacy single-CR fallback for `CR_NUMBERS` |

**Precedence for CR resolution:**  
`CR_NUMBERS` / `CR_NUMBER` → `CR_CONFIG` (registry lookup)

---

## Running the Tests

All commands are run from the **repo root** (`playwright_servicenow/`).  
Always set `RELEASE_VERSION` before running any TDR spec.

---

### Full run — all 3 configs, 3 parallel browsers

```powershell
$env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --headed --workers=3
```

Opens 3 Chrome windows simultaneously — GENERATE_DUMP_PROD, UAT, QA.

---

### Run a single config

```powershell
# GENERATE_DUMP_PROD only
$env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --headed --workers=1 --grep "\[GENERATE_DUMP_PROD\]"

# UAT only
$env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --headed --workers=1 --grep "\[UAT\]"

# QA only
$env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --headed --workers=1 --grep "\[QA\]"
```

---

### Run any two configs in parallel

```powershell
$env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --headed --workers=2 --grep "\[UAT\]|\[QA\]"
$env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --headed --workers=2 --grep "\[GENERATE_DUMP_PROD\]|\[UAT\]"
```

---

### Run CTasks only (after CRs already exist)

Use when the CR was created in a previous run and you only need to add CTasks.

```powershell
# Single config — looks up CR from registry automatically
$env:CR_CONFIG="UAT"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/ctasks.spec.ts --project=TDR --headed --workers=1

# Multiple configs in parallel
$env:CR_CONFIG="UAT,QA"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/ctasks.spec.ts --project=TDR --headed --workers=2

# All 3 configs
$env:CR_CONFIG="GENERATE_DUMP_PROD,UAT,QA"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/ctasks.spec.ts --project=TDR --headed --workers=3

# By explicit CR number (bypasses registry)
$env:CR_NUMBERS="CHG0233029"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/ctasks.spec.ts --project=TDR --headed --workers=1

# Multiple explicit CRs in parallel
$env:CR_NUMBERS="CHG0233029,CHG0233030"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/ctasks.spec.ts --project=TDR --headed --workers=2

# Target a specific config when using explicit CR numbers
$env:CR_NUMBERS="CHG0233029"; $env:CR_CONFIG="UAT"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/ctasks.spec.ts --project=TDR --headed --workers=1
```

---

### Run Risk Assessment only (after CRs already exist)

```powershell
# By config name — single
$env:CR_CONFIG="UAT"; npx playwright test servicenow_tdr/riskmanagement.spec.ts --project=TDR --headed --workers=1

# By config name — multiple in parallel
$env:CR_CONFIG="UAT,QA"; npx playwright test servicenow_tdr/riskmanagement.spec.ts --project=TDR --headed --workers=2

# All 3 from registry
$env:CR_CONFIG="GENERATE_DUMP_PROD,UAT,QA"; npx playwright test servicenow_tdr/riskmanagement.spec.ts --project=TDR --headed --workers=3

# By explicit CR number(s)
$env:CR_NUMBERS="CHG0233029"; npx playwright test servicenow_tdr/riskmanagement.spec.ts --project=TDR --headed --workers=1
$env:CR_NUMBERS="CHG0233029,CHG0233030,CHG0233031"; npx playwright test servicenow_tdr/riskmanagement.spec.ts --project=TDR --headed --workers=3

# Target a single CR with --grep
$env:CR_NUMBERS="CHG0233029,CHG0233030"; npx playwright test servicenow_tdr/riskmanagement.spec.ts --project=TDR --headed --workers=1 --grep "CHG0233029"
```

---

### Dry run — verify config without opening a browser

```powershell
$env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --list
```

Prints all test names in execution order. No browser is opened. Use this to confirm the YAML is valid before a real run.

---

### View HTML report

```powershell
npx playwright show-report
```

Opens the last run's report in your browser. Shows every step, timing, screenshots, and full trace replay on failure.

---

## How It Works

### Authentication

Same as CRE — auth_servicenow.json is shared. See sso_setup.ts for details.

### Sequential execution

```
TEST_CONFIGURATIONS_ORDERED = [
  GENERATE_DUMP_PROD,   <- Content CTasks
  UAT,                  <- Oracle + Content + RM CTasks
  QA,                   <- Oracle + Content + RM CTasks
]
```

Tests are registered in this order so Playwright runs them sequentially, not in parallel.

### Date calculation

Dates are derived automatically from 3 anchor dates in tdr_release_schedule.yaml:

```
generateDumpProd -> getDumpDates()    : start noon, end 9pm next day
uatDataRefresh   -> getUATDates()     : Oracle 4 days, TDR 2 business days
qaDataRefresh    -> getQADates()      : Oracle 2 days, TDR same day
```

All CTasks receive per-task dates (Oracle window vs TDR window) automatically.

### Per-config test steps

| Step | Action |
|---|---|
| 1 | Navigate to ServiceNow (session from auth_servicenow.json) |
| 2 | Open All menu → Change → Create New |
| 3 | Select Normal change model |
| 4 | Verify CR form URL |
| 5 | Fill CR form (category, config item, dates, descriptions, groups) |
| 6 | Submit and wait for redirect |
| 7 | Navigate to Open Change Requests list |
| 8 | Search and verify the new CR appears |
| 9 | Create all CTasks (Oracle, Content, RM — each with own dates) |
| 10 | Create Risk Assessment |
| 11 | Submit for Assess |

---

## Updating Release Data

Edit `tdr_release_schedule.yaml` only — no TypeScript changes needed.

```yaml
"2026.06.00":
  buildVersion:     "Build#3"     # update when a new build is confirmed
  generateDumpProd: "06-07-2026"  # PROD dump start date (also UAT/QA backup date)
  uatDataRefresh:   "10-07-2026"  # Oracle Support start for UAT
  qaDataRefresh:    "18-07-2026"  # Oracle Support start for QA
```

Dates must be DD-MM-YYYY. Wrong formats are caught by Zod on startup.

---

## Configs and CTasks

### Execution order

```
GENERATE_DUMP_PROD → UAT → QA
```

### CTask assignments per config

| Config | Oracle Support | Content Processing | RM |
|---|---|---|---|
| GENERATE_DUMP_PROD | — | Dharmalingam (dump files) | Radha Krishna |
| UAT | Oracle team (no assignee) | Dharmalingam (validation) | Radha Krishna |
| QA | Oracle team (no assignee) | Dharmalingam (validation) | Radha Krishna |

### CTask date windows

| Config | Oracle window | TDR/Content window |
|---|---|---|
| GENERATE_DUMP_PROD | noon → 9pm next day | same as above |
| UAT | 4 consecutive days from uatDataRefresh | next 2 business days |
| QA | 2 consecutive days from qaDataRefresh | same day after Oracle ends |

### Database instances

| Config | Environment | Database |
|---|---|---|
| GENERATE_DUMP_PROD | PROD | cdp0797a1 |
| UAT | UAT | cdu0791a1 |
| QA | QA | cdq0782a1 |

---

## Files Reference

### Files committed to Git

| File | Location | Purpose | Edit frequency |
|---|---|---|---|
| `tdr_release_schedule.yaml` | `tests/servicenow_tdr/` | Anchor dates + `buildVersion` per release. **Only file you update each sprint.** | Every sprint |
| `testDataConfig_TDR.ts` | `tests/servicenow_tdr/` | All test data, date calculations, CR text, CTask config, registry helpers | Rarely |
| `changeRequest.spec.ts` | `tests/servicenow_tdr/` | Creates Change Requests in ServiceNow (3 configs, 11-step flow each) | Rarely |
| `ctasks.spec.ts` | `tests/servicenow_tdr/` | Adds CTasks to existing CRs; supports all 3 input modes (config, number, legacy) | Rarely |
| `riskmanagement.spec.ts` | `tests/servicenow_tdr/` | Fills Risk Assessment form and clicks "Submit for Assess" | Rarely |
| `tdr_flow.html` | `tests/servicenow_tdr/` | Interactive HTML flow diagram — open in any browser | Never |
| `README.md` | `tests/servicenow_tdr/` | This file | As needed |
| `sso_setup.ts` | `tests/` | SSO login via PingID — saves `auth_servicenow.json` (shared with CRE) | Never |
| `helpers.ts` | `tests/` | Shared Playwright helper functions used by all specs | Rarely |
| `playwright.config.ts` | repo root | Browser channel, workers, reporters, baseURL, project definitions | Never |
| `package.json` | repo root | Node.js dependencies and `npm run` scripts | Rarely |
| `tsconfig.json` | repo root | TypeScript compiler settings (ES2020, CommonJS, strict: false) | Never |
| `.env.example` | repo root | Credential template — safe to commit; never put real values in it | Rarely |
| `.gitignore` | repo root | Excludes `.env`, `auth_servicenow.json`, reports, `node_modules`, registry | Never |

### Files NOT committed to Git (local only)

| File / Folder | Created by | Why excluded |
|---|---|---|
| `.env` | You (manually) | Contains your SSO username and password |
| `auth_servicenow.json` | `sso_setup.ts` | Contains live browser session cookies — valid ~8 hours |
| `change_request_registry.yaml` | `changeRequest.spec.ts` | Auto-generated per run — tracks CR numbers locally |
| `change_request_registry.lock` | Runtime lock guard | Temporary file; deleted after each run |
| `playwright-report/` | Any test run | Generated HTML report |
| `test-results/` | Any test run | Screenshots, videos, and traces on failure |
| `node_modules/` | `npm install` | Restored via `npm install`; ~300 MB, no need to store in Git |

### `playwright.config.ts` — key settings explained

| Setting | Value | Meaning |
|---|---|---|
| `channel: 'chrome'` | `'chrome'` | Uses system-installed Chrome, not Playwright's bundled Chromium |
| `headless: false` | `false` | Always runs visible (headed); override in CI with `--headed=false` |
| `baseURL` | `https://trenterprise.service-now.com/now/sow/home` | Default navigation target for `page.goto('/')` |
| `workers` | `7` (default) | Max parallel browsers; always override via `--workers=N` per run |
| `screenshot` | `'only-on-failure'` | Screenshots saved only when a test fails |
| `video` | `'retain-on-failure'` | Video saved only when a test fails |
| `trace` | `'retain-on-failure'` | Trace Viewer data saved only when a test fails |
| `retries` | `0` locally, `1` on CI | No automatic retries in local runs |
| `reporter` | HTML + list + JSON + JUnit | Reports written to `playwright-report/`, `test-results.json`, `test-results.xml` |

---

## Troubleshooting

---

**`❌ RELEASE_VERSION env var is required`**

```powershell
$env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts ...
```

The variable must be set in the same terminal session as the test command.

---

**`❌ tdr_release_schedule.yaml failed validation`**

A field has the wrong format or is missing. The error shows the exact path, e.g.:
```
• [releases.2026.06.00.generateDumpProd] Date must be DD-MM-YYYY
```
Fix the value in `tdr_release_schedule.yaml` and re-run. Common mistakes: wrong separator (use `-`, not `/`), wrong order (must be `DD-MM-YYYY`, not `YYYY-MM-DD`).

---

**`❌ No schedule entry for release "2026.07.00"`**

Add a new block to `tdr_release_schedule.yaml`:
```yaml
"2026.07.00":
  buildVersion:     "Build#0"
  generateDumpProd: "10-08-2026"
  uatDataRefresh:   "14-08-2026"
  qaDataRefresh:    "22-08-2026"
```

---

**`auth_servicenow.json` is missing or stale (redirected to SSO login)**

Re-run SSO setup from the repo root:
```powershell
npx playwright test tests/sso_setup.ts --project=setup --headed
```
Approve the PingID push notification. The session lasts ~8 hours.

---

**`No registry entry found for CR CHG0XXXXXX`**

The CR was not saved to `change_request_registry.yaml`, or the registry file is missing.  
Options:
1. Re-run `changeRequest.spec.ts` to re-create the CR and populate the registry.
2. Provide the CR number explicitly via `$env:CR_NUMBERS="CHG0XXXXXX"`.
3. Provide both `$env:CR_NUMBERS` and `$env:CR_CONFIG` to override the config lookup.

---

**`❌ Config "UAT" not found in TEST_CONFIGURATIONS`**

Config names are case-sensitive. Valid values: `GENERATE_DUMP_PROD`, `UAT`, `QA`.

---

**Chrome doesn't open / `channel: 'chrome'` error**

Chrome is not installed or not on the expected path.
- Windows: install from https://www.google.com/chrome/
- Verify: `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --version`
- Do **not** run `npx playwright install` — this project intentionally uses system Chrome.

---

**CTask date looks wrong (Oracle and TDR windows overlap)**

Dates are calculated from `deployment_times` in `tdr_release_schedule.yaml`.  
Check these values:
- `qa_oracle_days`: number of consecutive days Oracle runs for QA (default: `2`)
- `uat_oracle_days`: number of consecutive days Oracle runs for UAT (default: `4`)
- `qa_tdr_start` / `qa_tdr_end`: time window for TDR QA refresh (default: `12:00:00` – `23:30:00`)
- `uat_tdr_start` / `uat_tdr_end`: time window for TDR UAT refresh (default: `12:00:00` – `21:00:00`)

Do not change these values without consulting the RM team.

---

**Risk Assessment iframe not found**

The assessment form loads inside an iframe. The spec polls for up to 60 seconds.  
If it consistently times out, try:
1. Increase the deadline in `createRiskAssessmentTask()` in `helpers.ts`.
2. Run with `--workers=1` to reduce browser resource contention.
3. Check whether ServiceNow is running slow (try loading the CR manually first).

---

**`npm install` fails with proxy/certificate errors**

On a corporate network, npm may need proxy settings:
```powershell
npm config set proxy http://your-proxy:8080
npm config set https-proxy http://your-proxy:8080
npm config set strict-ssl false
npm install
```

---

**TypeScript errors on `npx playwright test`**

Playwright compiles TypeScript on the fly via `ts-jest`. If you see compilation errors:
1. Confirm `node --version` is >= 18.
2. Run `npm install` again — a missing `@types/node` or `typescript` package causes most TS errors.
3. Check `tsconfig.json` — the target is `ES2020` and module is `commonjs`.

---

## Checking In to GitHub

### What belongs in the repository

```
playwright_servicenow/
├── playwright.config.ts
├── package.json
├── tsconfig.json
├── .env.example                          ← credential template — NOT .env
├── .gitignore
└── tests/
    ├── sso_setup.ts
    ├── helpers.ts
    └── servicenow_tdr/
        ├── changeRequest.spec.ts
        ├── ctasks.spec.ts
        ├── riskmanagement.spec.ts
        ├── testDataConfig_TDR.ts
        ├── tdr_release_schedule.yaml
        ├── tdr_flow.html
        └── README.md
```

### What must NEVER be committed

| File / Folder | Reason |
|---|---|
| `.env` | Contains your SSO username and **password** |
| `auth_servicenow.json` | Contains live browser session cookies |
| `change_request_registry.yaml` | Auto-generated local run data |
| `change_request_registry.lock` | Temporary runtime lock file |
| `playwright-report/` | Generated output |
| `test-results/` | Screenshots, videos, traces |
| `node_modules/` | Restored via `npm install` |

All of the above are already covered by `.gitignore`. To verify your `.gitignore` is working, run `git status` — none of the above should appear as staged or untracked.

---

### Step-by-step checkin workflow

**1. Create a feature branch**

```powershell
git checkout -b feature/tdr-2026.06.00-servicenow-cr-automation
```

Use a descriptive name. Never commit directly to `main` or `master`.

**2. Confirm no secrets are staged**

```powershell
git status
```

If `.env` or `auth_servicenow.json` appear anywhere in the output, stop immediately.  
Do **not** proceed until you verify `.gitignore` contains both entries.

**3. Verify `.gitignore` is protecting your secrets**

```powershell
git check-ignore -v .env
git check-ignore -v auth_servicenow.json
```

Both should print a line starting with `.gitignore:` — confirming they are excluded.  
If either command prints nothing, add the file name to `.gitignore` immediately.

**4. Run the dry run to confirm the YAML is valid**

```powershell
$env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --list
```

Should print all 3 test names without errors. Fix any YAML validation errors before staging.

**5. Check for accidental `test.only`**

```powershell
# PowerShell — search for .only in all spec files
Select-String -Path "tests\**\*.spec.ts" -Pattern "\.only\(" -Recurse
```

If any match is found, remove the `.only` before committing.

**6. Stage your changes**

```powershell
# Stage everything (safe — .gitignore protects secrets)
git add .

# Or stage only the files you changed
git add tests/servicenow_tdr/tdr_release_schedule.yaml
git add tests/servicenow_tdr/testDataConfig_TDR.ts
```

**7. Confirm what is staged**

```powershell
git diff --staged --name-only
```

Read the list carefully. `.env` and `auth_servicenow.json` must NOT appear.

**8. Commit with a descriptive message**

```powershell
# Updating release dates only
git commit -m "TDR: update release schedule dates for 2026.06.00"

# Code changes
git commit -m "TDR: add Oracle CTask for GENERATE_DUMP_PROD config"

# Multiple changes
git commit -m "TDR: add 2026.07.00 schedule; fix UAT CTask end date calculation"
```

**9. Push to your branch**

```powershell
git push origin feature/tdr-2026.06.00-servicenow-cr-automation
```

**10. Open a Pull Request**

Go to the repository on GitHub, click **Compare & pull request**, fill in the description, and assign a reviewer.

---

### Pre-checkin checklist

- [ ] `git status` — `.env` is **not** listed
- [ ] `git status` — `auth_servicenow.json` is **not** listed
- [ ] `git check-ignore -v .env` — prints a `.gitignore:` match
- [ ] `tdr_release_schedule.yaml` has correct dates for the release being deployed
- [ ] `buildVersion` in the YAML is up to date
- [ ] Dry run passes: `--list` shows all 3 test names with no errors
- [ ] No `test.only` left in any spec file
- [ ] `git diff --staged --name-only` shows only the files you intended to change
- [ ] Commit message clearly describes what changed and for which release

---

## Demo Notes

**1. Show the YAML first**
Three date fields per release drive everything — dump date, UAT start, QA start. All CTask dates are calculated automatically from deployment_times.

**2. Explain the execution order**
PROD dump must run before UAT (UAT needs the dump files). UAT must run before QA (QA uses files moved during UAT). Show TEST_CONFIGURATIONS_ORDERED in testDataConfig_TDR.ts.

**3. Show the flow diagram**
Open tdr_flow.html in a browser. Walk through the three sequential config blocks and the shared 11-step per-config flow.

**4. Run a dry run live**
`--list` flag shows all 3 test names in the correct order. Good confidence check before the demo.

**5. Run GENERATE_DUMP_PROD only**
Use `--grep "\[GENERATE_DUMP_PROD\]"` for a focused demo — shows the full 11-step flow for one config.

**6. Show the HTML report**
`npx playwright show-report` after a run. Show step-level detail and per-CTask console output.

**7. Show change_request_registry.yaml**
Generated after a run. Contains CR numbers and timestamps for audit purposes.