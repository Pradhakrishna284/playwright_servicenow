# CRE Playwright Automation

Automates **Change Request (CR) creation, CTask management, and Risk Assessment submission** in ServiceNow for all 7 CRE deployment environments. 

```
SAT → UAT_EMEA → UAT_MENA → UAT_AMER → PROD_EMEA → PROD_MENA → PROD_AMER
```

## Table of Contents

1. [Project Structure](#project-structure)
2. [Prerequisites](#prerequisites)
3. [Installing Dependencies](#installing-dependencies)
4. [First-Time Setup](#first-time-setup)
5. [Environment Variables](#environment-variables)
6. [Running the Tests](#running-the-tests)
7. [How It Works](#how-it-works)
8. [Updating Release Data](#updating-release-data)
9. [Environments and CTasks](#environments-and-ctasks)
10. [Files Reference](#files-reference)
11. [Troubleshooting](#troubleshooting)
12. [Checking In to GitHub](#checking-in-to-github)
13. [Demo Notes](#demo-notes)

---

## Project Structure

```
playwright_scripts/servicenow_cre/      ← project root (run all commands from here)
├── playwright.config.ts                ← browser config, projects, reporters
├── package.json                        ← Node.js dependencies
├── tsconfig.json                       ← TypeScript compiler settings
├── .env                                ← SSO credentials — LOCAL ONLY, never commit
├── .gitignore                          ← excludes .env, auth files, reports, node_modules
│
├── sso_setup.ts                        ← SSO login — saves auth_servicenow.json
├── helpers.ts                          ← shared browser helper functions
│
├── changeRequest.spec.ts               ← creates the Change Request in ServiceNow (full 11-step flow)
├── ctasks.spec.ts                      ← adds CTasks to an existing CR
├── riskmanagement.spec.ts              ← submits Risk Assessment and "Submit for Assess"
├── testDataConfig_CRE.ts               ← all test data, date calculations, CTask config
├── cre_release_schedule.yaml           ← release dates (update every sprint)
├── cre_flow.html                       ← interactive flow diagram (open in browser)
└── README.md                           ← this file
```

**Generated at runtime — not committed to Git:**
- `auth_servicenow.json` — saved browser session (valid ~2 hours)
- `change_request_registry.yaml` — CR numbers created per run
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

Run **once** from `playwright_scripts\servicenow_cre\`:

```powershell
cd playwright_scripts\servicenow_cre
npm install
```

This installs all packages listed in `package.json`:

| Package | Version | Purpose |
|---|---|---|
| `@playwright/test` | ^1.61.1 | Test runner, browser automation, assertions |
| `js-yaml` | ^5.2.1 | Parse `cre_release_schedule.yaml` and `change_request_registry.yaml` |
| `@types/js-yaml` | ^4.0.9 | TypeScript type definitions for js-yaml |
| `dotenv` | ^17.4.2 | Load `.env` credentials into `process.env` at startup |
| `zod` | ^4.4.3 | Runtime schema validation for the YAML release schedule |
| `typescript` | ^6.0.3 | TypeScript compiler (dev) |
| `@types/node` | ^26.1.0 | TypeScript definitions for Node.js built-ins (fs, path, etc.) |

> **No `npx playwright install` needed.**
> Because `channel: 'chrome'` is set in `playwright.config.ts`, Playwright uses the Chrome binary already on your machine. Downloading Playwright's bundled browsers is not required and may be blocked by the corporate proxy.

---

## First-Time Setup

### Step 1 — Clone the repository and navigate to the project

```powershell
git clone <repository-url>
cd a206449_IDT_ReleaseManagement\playwright_scripts\servicenow_cre
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
| `SSO_USERNAME` | Your TR employee ID (e.g. `123456`) |
| `SSO_PASSWORD` | Your SSO login password |
| `SSO_URL` | `https://sso.thomsonreuters.com/idp/SSO.saml2` (do not change) |

> **Security:** Never paste your `.env` values into Slack, Teams, code review comments, or commit messages.
> If you accidentally commit `.env`, contact your security team immediately.

### Step 4 — Run SSO Setup (once per session, valid ~8 hours)

This opens Chrome, logs in to ServiceNow via SSO, saves the browser session, then closes.

```powershell
npx playwright test sso_setup.ts --project=setup --headed
```

**What happens:**
1. Chrome opens automatically.
2. SSO credentials from `.env` are used to log in.
3. **Approve the PingID push notification on your phone** (required).
4. Chrome closes and `auth_servicenow.json` is written to the `servicenow_cre/` folder.

> **Stale session:** If any spec redirects you to the login page mid-run, re-run this step.

---

## Environment Variables

All environment variables are set in PowerShell **inline** before the test command (they are not persisted after the terminal session closes).

| Variable | Required by | Example | Description |
|---|---|---|---|
| `RELEASE_VERSION` | `changeRequest.spec.ts`, `ctasks.spec.ts` | `2026.05.00` | Target release — must match a key in `cre_release_schedule.yaml` |
| `CR_CONFIG` | `ctasks.spec.ts`, `riskmanagement.spec.ts` | `UAT_MENA,PROD_MENA` | Comma-separated config names for CTask/Risk runs; looked up from registry |
| `CR_NUMBERS` | `ctasks.spec.ts`, `riskmanagement.spec.ts` | `CHG0233029,CHG0233030` | Explicit CR numbers; bypasses registry lookup |
| `CR_NUMBER` | `ctasks.spec.ts`, `riskmanagement.spec.ts` | `CHG0233029` | Legacy single-CR fallback for `CR_NUMBERS` |

**Precedence for CR resolution:**
`CR_NUMBERS` / `CR_NUMBER` → `CR_CONFIG` (registry lookup)

---

## Running the Tests

All commands are run from `playwright_scripts\servicenow_cre\`.
Always set `RELEASE_VERSION` before running any CRE spec.

### Full run — all 7 environments in parallel

```powershell
$env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=7
```

Launches 7 browser windows simultaneously — one per environment.

---

### Run a single environment

```powershell
# SAT
$env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[SAT\]"

# UAT EMEA
$env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_EMEA\]"

# UAT AMER
$env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_AMER\]"

# UAT MENA
$env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_MENA\]"

# PROD EMEA
$env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[PROD_EMEA\]"

# PROD AMER
$env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[PROD_AMER\]"

# PROD MENA
$env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[PROD_MENA\]"
```

### Run 2 environments by region (in parallel)

```powershell
# EMEA pair (UAT_EMEA + PROD_EMEA)
$env:RELEASE_VERSION="2026.07.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=2 --grep "\[UAT_EMEA\]|\[PROD_EMEA\]"

# AMER pair (UAT_AMER + PROD_AMER)
$env:RELEASE_VERSION="2026.07.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=2 --grep "\[UAT_AMER\]|\[PROD_AMER\]"

# MENA pair (UAT_MENA + PROD_MENA)
$env:RELEASE_VERSION="2026.07.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=2 --grep "\[UAT_MENA\]|\[PROD_MENA\]"
```

### Run all UAT or all PROD environments (3 in parallel)

```powershell
# All UAT (UAT_EMEA, UAT_MENA, UAT_AMER — 3 browsers)
$env:RELEASE_VERSION="2026.07.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=3 --grep "\[UAT_EMEA\]|\[UAT_AMER\]|\[UAT_MENA\]"

# All PROD (PROD_EMEA, PROD_MENA, PROD_AMER — 3 browsers)
$env:RELEASE_VERSION="2026.07.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=3 --grep "\[PROD_EMEA\]|\[PROD_AMER\]|\[PROD_MENA\]"
```

### Run CTasks only (on an existing CR)

Use this when the CR already exists and you only need to add CTasks.

```powershell
# By explicit CR number
$env:CR_NUMBERS="CHG0233029"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test ctasks.spec.ts --project=CRE --headed --workers=1
```

---

### Run Risk Assessment only (on an existing CR)

```powershell
# By explicit CR number(s)
$env:CR_NUMBERS="CHG0233029"; npx playwright test riskmanagement.spec.ts --project=CRE --headed --workers=1

---

### View HTML report

```powershell
npx playwright show-report
```

Opens the last test run's HTML report in your browser. Shows every step, timing, screenshots, and traces for failures.

---

## How It Works

### Authentication

```
sso_setup.ts (once per ~8 hours)
  Navigate to ServiceNow → redirected to SSO login
  Fill credentials from .env
  Wait for PingID MFA approval (manual, up to 2 min)
  Save session to auth_servicenow.json (valid ~8 hours)

changeRequest.spec.ts (up to 7 parallel workers)
  Each worker loads auth_servicenow.json via storageState
  No login prompt — proceeds directly to ServiceNow dashboard
```

### Per-environment steps

| Step | Action |
|---|---|
| 1 | Navigate to ServiceNow (session from auth_servicenow.json) |
| 2 | Open All menu → Change → Create New |
| 3 | Select Normal change model |
| 4 | Verify CR form URL |
| 5 | Fill CR form (category, service, dates, descriptions, approval groups) |
| 6 | Submit and wait for redirect |
| 7 | Navigate to Open Change Requests list |
| 8 | Search and verify the new CR appears |
| 9 | Create all CTasks (RM, DevOps, TechOps, QA — varies by env) |
| 10 | Create Risk Assessment |
| 11 | Submit for Assess |

### Data flow

```
RELEASE_VERSION (terminal env var)
        |
        v
cre_release_schedule.yaml  ← Zod validates on startup
        |
        v
testDataConfig_CRE.ts  → builds TEST_CONFIGURATIONS (7 env objects)
        |
        v
changeRequest.spec.ts  → runs up to 7 parallel tests
        |
        v
change_request_registry.yaml  ← CR numbers saved after each run
```

---

## Updating Release Data

Edit `cre_release_schedule.yaml` only — no TypeScript changes needed.

```yaml
releases:
  schedule:
    "2026.07.00":
      buildVersion: "Build#0"    # update when a new build is confirmed
      deployment_dates:
        SAT:       "17-07-2026"
        UAT_EMEA:  "24-07-2026"
        UAT_MENA:  "24-07-2026"
        UAT_AMER:  "29-07-2026"
        PROD_EMEA: "05-08-2026"
        PROD_MENA: "05-08-2026"
        PROD_AMER: "06-08-2026"
```

Dates must be `DD-MM-YYYY`. Wrong formats are caught by Zod on startup with a clear error message pointing to the bad field.

> **Note:** Only `deployment_dates` are needed for Playwright CR automation. The `meeting_dates` block (YYYY-MM-DD format) is used exclusively by the Teams meeting automation (`teams_meeting.py`) and does not affect test runs.

---

## Environments and CTasks

### Deployment order

SAT → UAT_EMEA → UAT_MENA → UAT_AMER → PROD_EMEA → PROD_MENA → PROD_AMER

### CTask steps per environment

| Environment | RM | DevOps | TechOps | QA | Total |
|---|---|---|---|---|---|
| SAT | Step 0 | Steps 1-2 | — | — | 3 |
| UAT EMEA | Step 0 | — | Steps 1-2 | Step 3 | 4 |
| UAT AMER | Step 0 | — | Steps 1-4 | Step 5 | 6 |
| UAT MENA | Step 0 | — | Steps 1-2 | Step 3 | 4 |
| PROD EMEA | Step 0 | — | Steps 1-2 | Step 3 | 4 |
| PROD AMER | Step 0 | — | Steps 1-4 | Step 5 | 6 |
| PROD MENA | Step 0 | — | Steps 1-2 | Step 3 | 4 |

### Assignment groups

| Department | ServiceNow Group |
|---|---|
| RM | IDT-RELEASE-MGMT-TR |
| DevOps | APP-DEVOPS-IDT |
| TechOps | APP-SUPPORT-IDT |
| QA | APP-IDT-QA |

---

## Files Reference

### Files committed to Git

| File | Purpose | Edit frequency |
|---|---|---|
| `cre_release_schedule.yaml` | Dates + `buildVersion` per release. **Only file you update each sprint.** | Every sprint |
| `testDataConfig_CRE.ts` | All test data, date calculations, CR text, CTask config, registry helpers | Rarely |
| `changeRequest.spec.ts` | Creates Change Requests in ServiceNow (7 envs, 11-step flow each) | Rarely |
| `ctasks.spec.ts` | Adds CTasks to an existing CR | Rarely |
| `riskmanagement.spec.ts` | Submits Risk Assessment and "Submit for Assess" | Rarely |
| `helpers.ts` | Shared Playwright helper functions used by all specs | Rarely |
| `sso_setup.ts` | SSO login via PingID — saves `auth_servicenow.json` | Never |
| `cre_flow.html` | Interactive HTML flow diagram — open in any browser | Never |
| `README.md` | This file | As needed |
| `playwright.config.ts` | Browser channel, workers, reporters, baseURL, project definitions | Never |
| `package.json` | Node.js dependencies | Rarely |
| `tsconfig.json` | TypeScript compiler settings (ES2020, CommonJS, strict: false) | Never |
| `.gitignore` | Excludes `.env`, `auth_servicenow.json`, reports, `node_modules`, registry | Never |

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

**`RELEASE_VERSION` env var is required**
```powershell
$env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts ...
```

---

**`cre_release_schedule.yaml` failed validation**
A date is in the wrong format — must be `DD-MM-YYYY`. The error message shows the exact field path.

---

**No schedule entry for release "X"**
The version you passed is not in the YAML. Add the release block to `cre_release_schedule.yaml`.

---

**`auth_servicenow.json` is missing or stale (redirected to SSO login)**

Re-run SSO setup from `playwright_scripts\servicenow_cre\`:
```powershell
npx playwright test sso_setup.ts --project=setup --headed
```
Approve the PingID push notification. The session lasts ~2 hours.

---

**PingID approval timed out**
Setup waits up to 2 minutes. Open your PingID app and approve the push promptly.

---

**`No registry entry found for CR CHG0XXXXXX`**

The CR was not saved to `change_request_registry.yaml`, or the registry file is missing.
Options:
1. Re-run `changeRequest.spec.ts` to re-create the CR and populate the registry.
2. Provide the CR number explicitly via `$env:CR_NUMBERS="CHG0XXXXXX"`.
3. Provide both `$env:CR_NUMBERS` and `$env:CR_CONFIG` to override the config lookup.

---

**`❌ Config "UAT_MENA" not found in TEST_CONFIGURATIONS`**
Config names are case-sensitive. Valid values: `SAT`, `UAT_EMEA`, `UAT_AMER`, `UAT_MENA`, `PROD_EMEA`, `PROD_AMER`, `PROD_MENA`.

---

**Chrome doesn't open / `channel: 'chrome'` error**

Chrome is not installed or not on the expected path.
- Windows: install from https://www.google.com/chrome/
- Verify: `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --version`
- Do **not** run `npx playwright install` — this project intentionally uses system Chrome.

---

**CR number not captured**
The form field was not populated before the test read it — usually a slow ServiceNow page load. Increase `timeoutElementVisible` in `COMMON_CONSTANTS` if this happens consistently.

---

**A CTask step failed**
The console log shows the step number and department. Most failures are transient iframe load delays — the retry logic handles these automatically.

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

Playwright compiles TypeScript on the fly. If you see compilation errors:
1. Confirm `node --version` is >= 18.
2. Run `npm install` again — a missing `@types/node` or `typescript` package causes most TS errors.
3. Check `tsconfig.json` — the target is `ES2020` and module is `commonjs`.

---

## Checking In to GitHub

### What belongs in the repository

```
playwright_scripts/servicenow_cre/
├── playwright.config.ts
├── package.json
├── tsconfig.json
├── .gitignore
├── sso_setup.ts
├── helpers.ts
├── changeRequest.spec.ts
├── ctasks.spec.ts
├── riskmanagement.spec.ts
├── testDataConfig_CRE.ts
├── cre_release_schedule.yaml
├── cre_flow.html
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
git checkout -b feature/cre-servicenow-cr-automation
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

**4. Check for accidental `test.only`**

```powershell
# PowerShell — search for .only in all spec files
Select-String -Path "*.spec.ts" -Pattern "\.only\("
```

If any match is found, remove the `.only` before committing.

**5. Stage your changes**

```powershell
# Stage everything (safe — .gitignore protects secrets)
git add .

# Or stage only the files you changed
git add cre_release_schedule.yaml
git add testDataConfig_CRE.ts
```

**6. Confirm what is staged**

```powershell
git diff --staged --name-only
```

Read the list carefully. `.env` and `auth_servicenow.json` must NOT appear.

**7. Commit with a descriptive message**

```powershell
# Updating release dates only
git commit -m "CRE: update release schedule dates for 2026.05.00"

# Code changes
git commit -m "CRE: add PROD_MENA CTask configuration"

# Multiple changes
git commit -m "CRE: add 2026.06.00 schedule; fix UAT_AMER CTask assignment group"
```

**8. Push to your branch**

```powershell
git push origin feature/cre-servicenow-cr-automation
```

**9. Open a Pull Request**

Go to the repository on GitHub, click **Compare & pull request**, fill in the description, and assign a reviewer.

---

### Pre-checkin checklist

- [ ] `git status` — `.env` is **not** listed
- [ ] `git status` — `auth_servicenow.json` is **not** listed
- [ ] `git check-ignore -v .env` — prints a `.gitignore:` match
- [ ] `cre_release_schedule.yaml` has correct dates for the release being deployed
- [ ] `buildVersion` in the YAML is up to date
- [ ] Dry run passes: `$env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --list`
- [ ] No `test.only` left in any spec file
- [ ] `git diff --staged --name-only` shows only the files you intended to change
- [ ] Commit message clearly describes what changed and for which release

---

## Demo Notes

**1. Show the YAML first**
Point out that `buildVersion` and all dates live in one file. No TypeScript changes between releases — just update the YAML.

**2. Run SSO setup live**
Show the PingID push arriving and being approved. Emphasise this runs once per ~2 hours — not once per test.

**3. Run a single environment for the demo**
Use `--grep "\[SAT\]"` — SAT has only 3 CTasks (fastest to complete). Shows the full 11-step flow without waiting for all AMER steps.

**4. Show the HTML report**
`npx playwright show-report` after a run. Show step-level detail, console logs, timings, and screenshots on failure.

**5. Show change_request_registry.yaml**
Generated after a run. Shows every CR number, sysId, and ServiceNow URL for the release — useful for post-run verification.

**6. Show what is NOT in GitHub**
Walk through `.gitignore`. Confirm `.env` and `auth_servicenow.json` are excluded. This is the most important security point for the team.