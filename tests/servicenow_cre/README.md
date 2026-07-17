# CRE Playwright Automation

Automates **Change Request (CR) creation and CTask management** in ServiceNow for all 7 CRE deployment environments. All environments run **in parallel** using a shared SSO session.

```
SAT → UAT_EMEA → UAT_AMER → UAT_MENA → PROD_EMEA → PROD_AMER → PROD_MENA
```

> **New to Playwright?** See the [Playwright Primer](#playwright-primer) section before you start.

---

## Table of Contents

1. [Playwright Primer](#playwright-primer)
2. [Project Structure](#project-structure)
3. [Prerequisites](#prerequisites)
4. [First-Time Setup](#first-time-setup)
5. [Running the Tests](#running-the-tests)
6. [How It Works](#how-it-works)
7. [Updating Release Data](#updating-release-data)
8. [Environments and CTasks](#environments-and-ctasks)
9. [Files Reference](#files-reference)
10. [Troubleshooting](#troubleshooting)
11. [Checking In to GitHub](#checking-in-to-github)
12. [Demo Notes](#demo-notes)

---

## Playwright Primer

If you have never used Playwright before, here is what you need to know:

- **Playwright** is a Node.js library for automating browsers (Chrome, Firefox, Edge). This project uses Google Chrome.
- **Tests** are TypeScript files ending in `.spec.ts`. Each test opens a real Chrome window and clicks through ServiceNow the same way a human would.
- **`npx playwright test`** is the main command to run tests. You never need to open a browser manually.
- **`--headed`** means you can see the browser window while the test runs. Omit it for headless (invisible) mode.
- **`--grep`** lets you run only tests whose name matches a pattern, e.g. `--grep "\[UAT_MENA\]"`.
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
│   └── servicenow_cre/             ← CRE test folder (you are here)
│       ├── changeRequest.spec.ts   ← creates the Change Request in ServiceNow (full 11-step flow)
│       ├── ctasks.spec.ts          ← adds CTasks to an existing CR
│       ├── riskmanagement.spec.ts  ← submits Risk Assessment and "Submit for Assess"
│       ├── createCR_api.ts         ← API-based CR creation (no browser, much faster)
│       ├── testDataConfig_CRE.ts   ← all test data, date calculations, CTask config
│       ├── cre_release_schedule.yaml ← release dates (update every sprint)
│       ├── cre_flow.html           ← interactive flow diagram (open in browser)
│       └── README.md               ← this file
```

**Generated at runtime — not committed to Git:**
- `auth_servicenow.json` — saved browser session (valid ~8 hours, shared with TDR)
- `servicenow_cre/change_request_registry.yaml` — CR numbers created per run
- `playwright-report/` — HTML test report
- `test-results/` — raw test artefacts (screenshots, videos, traces on failure)

---

## Prerequisites

| Requirement | Details |
|---|---|
| **Node.js >= 18** | Download from https://nodejs.org — choose the LTS version |
| **Google Chrome (latest)** | Must be installed; Playwright uses your system Chrome, not a bundled browser |
| **ServiceNow access** | trenterprise.service-now.com — request access via IT if you don't have it |
| **PingID MFA enrolled** | Required to approve the SSO login during setup |

### Install Node.js dependencies

Run this once from the **repo root** (`playwright_servicenow/`):

```powershell
npm install
```

This installs `@playwright/test`, `js-yaml`, `zod`, `dotenv`, and all other packages listed in `package.json`.

> **Note:** You do NOT need to run `npx playwright install` — this project uses your system-installed Chrome via `channel: 'chrome'`, not Playwright's bundled browsers.

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

```powershell
copy .env.example .env
```

Edit `.env` with your credentials (use any plain-text editor):

```
SSO_USERNAME=YOUR_EMPLOYEE_ID
SSO_PASSWORD=YOUR_SSO_PASSWORD
SSO_URL=https://sso.thomsonreuters.com/idp/SSO.saml2
```

> **Important:** `.env` is in `.gitignore` — it will never be committed. Each team member creates their own copy locally. Never share your password in Slack, Teams, or code reviews.

### Step 4 — Run SSO Setup (once per session, ~8 hours)

This step opens Chrome, logs in to ServiceNow via SSO, and saves the session to `auth_servicenow.json`. Run it from the **repo root**:

```powershell
npx playwright test tests/sso_setup.ts --project=setup --headed
```

1. Chrome opens automatically.
2. Enter your SSO credentials if prompted (they may be pre-filled from `.env`).
3. **Approve the PingID push notification on your phone.**
4. The browser closes and `auth_servicenow.json` is written to the repo root.

> **Shared session:** `auth_servicenow.json` is shared between CRE and TDR. If you ran SSO setup for TDR today, skip this step.

> **Stale session:** If tests redirect you to the SSO login page, the session has expired. Re-run Step 4.

---

## Running the Tests

All commands are run from the **repo root** (`playwright_servicenow/`).

### Full run — all 7 environments in parallel

```powershell
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --headed --workers=7
```

Launches 7 browser windows simultaneously — one per environment.

---

### Run a single environment

```powershell
# SAT
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[SAT\]"

# UAT EMEA
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_EMEA\]"

# UAT AMER
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_AMER\]"

# UAT MENA
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_MENA\]"

# PROD EMEA
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[PROD_EMEA\]"

# PROD AMER
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[PROD_AMER\]"

# PROD MENA
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[PROD_MENA\]"
```

---

### Run a pair or region group in parallel

```powershell
# Both UAT + PROD for a single region (2 browsers)
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --headed --workers=2 --grep "\[UAT_MENA\]|\[PROD_MENA\]"

# All UAT environments (3 browsers)
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --headed --workers=3 --grep "\[UAT_EMEA\]|\[UAT_AMER\]|\[UAT_MENA\]"

# All PROD environments (3 browsers)
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --headed --workers=3 --grep "\[PROD_EMEA\]|\[PROD_AMER\]|\[PROD_MENA\]"
```

---

### Run CTasks only (on an existing CR)

Use this when the CR already exists and you only need to add CTasks.

```powershell
# By config name (looks up CR number from registry automatically)
$env:CR_CONFIG="UAT_MENA"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/ctasks.spec.ts --project=CRE --headed --workers=1

# Multiple configs in parallel
$env:CR_CONFIG="UAT_MENA,PROD_MENA"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/ctasks.spec.ts --project=CRE --headed --workers=2

# All 7 environments in parallel
$env:CR_CONFIG="SAT,UAT_EMEA,UAT_AMER,UAT_MENA,PROD_EMEA,PROD_AMER,PROD_MENA"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/ctasks.spec.ts --project=CRE --headed --workers=7

# By explicit CR number
$env:CR_NUMBERS="CHG0233029"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/ctasks.spec.ts --project=CRE --headed --workers=1
```

---

### Run Risk Assessment only (on an existing CR)

```powershell
# By explicit CR number(s)
$env:CR_NUMBERS="CHG0233029"; npx playwright test servicenow_cre/riskmanagement.spec.ts --project=CRE --headed --workers=1

# Multiple CRs in parallel
$env:CR_NUMBERS="CHG0233029,CHG0233030"; npx playwright test servicenow_cre/riskmanagement.spec.ts --project=CRE --headed --workers=2

# By config name (registry lookup)
$env:CR_CONFIG="UAT_MENA,PROD_MENA"; npx playwright test servicenow_cre/riskmanagement.spec.ts --project=CRE --headed --workers=2
```

---

### API-based CR creation (no browser)

`createCR_api.ts` creates CRs via the ServiceNow REST API — no Chrome needed, much faster (~3 s vs ~3 min per CR). Requires a ServiceNow service account with Basic Auth (corporate SSO does not work here).

```powershell
# All environments
$env:RELEASE_VERSION="2026.05.00"; npx ts-node tests/servicenow_cre/createCR_api.ts

# Specific environments only
$env:CR_CONFIG="UAT_MENA,PROD_MENA"; $env:RELEASE_VERSION="2026.05.00"; npx ts-node tests/servicenow_cre/createCR_api.ts
```

---

### Dry run — verify config without opening a browser

```powershell
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --list
```

---

### View HTML report

```powershell
npx playwright show-report
```

Opens the last test run's HTML report in your browser. Shows every step, timing, screenshots, and traces for failures.

---

### Dry run — verify config without opening a browser

```powershell
$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --list
```

Confirms RELEASE_VERSION and YAML loading are correct before any browser opens.

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
"2026.05.00":
  buildVersion: "Build#3"    # update when a new build is confirmed
  SAT:       "07-05-2026"
  UAT_EMEA:  "27-05-2026"
  UAT_AMER:  "28-05-2026"
  UAT_MENA:  "29-05-2026"
  PROD_EMEA: "03-06-2026"
  PROD_AMER: "04-06-2026"
  PROD_MENA: "05-06-2026"
```

Dates must be `DD-MM-YYYY`. Wrong formats are caught by Zod on startup with a clear error message pointing to the bad field.

---

## Environments and CTasks

### Deployment order

SAT -> UAT_EMEA -> UAT_AMER -> UAT_MENA -> PROD_EMEA -> PROD_AMER -> PROD_MENA

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

| File | Location | Purpose | Edit frequency |
|---|---|---|---|
| `cre_release_schedule.yaml` | `servicenow_cre/` | Dates + buildVersion per release | Every sprint |
| `testDataConfig_CRE.ts` | `servicenow_cre/` | All test data, date calculations, CTask config | Rarely |
| `changeRequest.spec.ts` | `servicenow_cre/` | Creates Change Requests in ServiceNow (11-step flow) | Rarely |
| `ctasks.spec.ts` | `servicenow_cre/` | Adds CTasks to an existing CR | Rarely |
| `riskmanagement.spec.ts` | `servicenow_cre/` | Submits Risk Assessment and "Submit for Assess" | Rarely |
| `createCR_api.ts` | `servicenow_cre/` | API-based CR creation (no browser, fast) | Rarely |
| `cre_flow.html` | `servicenow_cre/` | Interactive flow diagram — open in any browser | Never |
| `sso_setup.ts` | `tests/` | SSO login, saves `auth_servicenow.json` (shared with TDR) | Never |
| `helpers.ts` | `tests/` | Shared browser helper functions used by all specs | Rarely |
| `playwright.config.ts` | repo root | Workers, browser channel, projects (CRE/TDR/setup) | Never |
| `package.json` | repo root | Node.js dependencies and npm scripts | Never |
| `tsconfig.json` | repo root | TypeScript compiler settings | Never |
| `.env` | repo root | Your SSO credentials — **never commit** | Once (personal) |
| `.env.example` | repo root | Safe template — commit this, not `.env` | Rarely |
| `.gitignore` | repo root | Excludes `.env`, auth files, reports, node_modules | Never |

---

## Troubleshooting

**RELEASE_VERSION env var is required**
```powershell
$env:RELEASE_VERSION="2026.05.00"; npx playwright test ...
```

**cre_release_schedule.yaml failed validation**
A date is in the wrong format — must be DD-MM-YYYY. The error message shows the exact field path.

**No schedule entry for release "X"**
The version you passed is not in the YAML. Add the release block to `cre_release_schedule.yaml`.

**auth_servicenow.json is stale**
Session expired (~8 hours). Re-run SSO setup from the repo root:
```powershell
npx playwright test tests/sso_setup.ts --project=setup --headed
```

**PingID approval timed out**
Setup waits up to 2 minutes. Open your PingID app and approve the push promptly.

**CR number not captured**
The form field was not populated before the test read it — usually a slow ServiceNow page load. Increase `timeoutElementVisible` in `COMMON_CONSTANTS` if this happens consistently.

**A CTask step failed**
The console log shows the step number and department. Most failures are transient iframe load delays — the retry logic handles these automatically.

---

## Checking In to GitHub

### What to commit

These files belong in the repository:

```
playwright_servicenow/
├── playwright.config.ts
├── package.json
├── tsconfig.json
├── .env.example                          ← template only — NOT .env
├── .gitignore
└── tests/
    ├── sso_setup.ts
    ├── helpers.ts
    └── servicenow_cre/
        ├── changeRequest.spec.ts
        ├── ctasks.spec.ts
        ├── riskmanagement.spec.ts
        ├── createCR_api.ts
        ├── testDataConfig_CRE.ts
        ├── cre_release_schedule.yaml
        ├── cre_flow.html
        └── README.md
```

### What to NEVER commit

| File / Folder | Why |
|---|---|
| `.env` | Contains your SSO password |
| `auth_servicenow.json` | Contains live browser session cookies |
| `servicenow_cre/change_request_registry.yaml` | Auto-generated run data, local only |
| `playwright-report/` | Generated HTML output |
| `test-results/` | Generated screenshots, videos, traces |
| `node_modules/` | Installed packages — restored via `npm install` |

All of the above are already covered by `.gitignore`.

### Step-by-step checkin workflow

**1. Check your staging area — confirm no secrets are included:**

```powershell
git status
```

Look for `.env` or `auth_servicenow.json` in the output. If you see them, stop — do NOT proceed until you verify `.gitignore` is in place.

**2. Stage the files you changed:**

```powershell
# Stage everything (safe — .gitignore protects secrets)
git add .

# Or stage specific files only
git add tests/servicenow_cre/cre_release_schedule.yaml
git add tests/servicenow_cre/changeRequest.spec.ts
```

**3. Verify what is staged:**

```powershell
git diff --staged --name-only
```

Confirm `.env` and `auth_servicenow.json` are NOT in this list.

**4. Commit with a descriptive message:**

```powershell
git commit -m "CRE: update release schedule for 2026.06.00"
```

**5. Push to your branch:**

```powershell
git push origin your-branch-name
```

**6. Open a Pull Request** on GitHub and ask a team member to review.

### Pre-checkin checklist

- [ ] `git status` shows `.env` is NOT staged
- [ ] `git status` shows `auth_servicenow.json` is NOT staged
- [ ] `cre_release_schedule.yaml` has correct dates for the current sprint
- [ ] `buildVersion` in the YAML is up to date
- [ ] Dry run passes: `$env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --project=CRE --list`
- [ ] No `test.only` is left in any spec file (search for `.only` across the repo)
- [ ] `npm install` runs without errors on a clean clone (ask a colleague to verify if unsure)

---

## Demo Notes

**1. Show the YAML first**
Point out that `buildVersion` and all dates live in one file. No TypeScript changes between releases — just update the YAML.

**2. Run the dry run**
`--list` flag shows all 7 test names loaded correctly before any browser opens. Good confidence check to start with.

**3. Run SSO setup live**
Show the PingID push arriving and being approved. Emphasise this runs once per ~8 hours — not once per test.

**4. Run a single environment for the demo**
Use `--grep "\[SAT\]"` — SAT has only 3 CTasks (fastest to complete). Shows the full 11-step flow without waiting for all AMER steps.

**5. Show the HTML report**
`npx playwright show-report` after a run. Show step-level detail, console logs, timings, and screenshots on failure.

**6. Show change_request_registry.yaml**
Generated after a run. Shows every CR number, sysId, and ServiceNow URL for the release — useful for post-run verification.

**7. Show what is NOT in GitHub**
Walk through `.gitignore`. Confirm `.env` and `auth_servicenow.json` are excluded. This is the most important security point for the team.