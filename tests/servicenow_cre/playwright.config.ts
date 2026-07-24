/**
 * PLAYWRIGHT CONFIG — CRE (ONESOURCE Determination)
 * ==================================================
 *
 * Folder structure:
 *   servicenow_cre/
 *   ├── sso_setup.ts          <- SSO setup (runs once, saves session)
 *   ├── playwright.config.ts  <- this file
 *   ├── changeRequest.spec.ts
 *   ├── ctasks.spec.ts
 *   ├── riskmanagement.spec.ts
 *   ├── testDataConfig_CRE.ts
 *   └── cre_release_schedule.yaml
 *
 * ─── PARALLEL EXECUTION ───────────────────────────────────────────────────────
 *
 * `workers` is a TOP-LEVEL only setting in Playwright — it cannot be set per
 * project. Set workers at the top level, defaulting to 7 (all CRE envs), but
 * always override at runtime via --workers=N on the CLI to match the exact
 * number of tests you are running.
 *
 * The --workers=N CLI flag always overrides the config value, so you never need
 * to edit this file for different run sizes.
 *
 * ─── SESSION NOTE ─────────────────────────────────────────────────────────────
 *
 * auth_servicenow.json is valid for 2 hours after SSO setup runs.
 * Re-run sso_setup.ts if auth_servicenow.json is missing, stale, or tests
 * redirect to the SSO login page.
 *
 * ─── CRE RUN COMMANDS ─────────────────────────────────────────────────────────
 *
 *   Setup (once):
 *     npx playwright test sso_setup.ts --project=setup --headed
 *
 *   CRE — run a single environment (1 browser):
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[SAT\]"
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_EMEA\]"
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_AMER\]"
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_MENA\]"
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[PROD_EMEA\]"
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[PROD_AMER\]"
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[PROD_MENA\]"
 *
 *   CRE — run both envs for a specific region (2 browsers in parallel):
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=2 --grep "\[UAT_EMEA\]|\[PROD_EMEA\]"
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=2 --grep "\[UAT_AMER\]|\[PROD_AMER\]"
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=2 --grep "\[UAT_MENA\]|\[PROD_MENA\]"
 *
 *   CRE — run all UAT or all PROD regions (3 browsers in parallel):
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=3 --grep "\[UAT_EMEA\]|\[UAT_AMER\]|\[UAT_MENA\]"
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=3 --grep "\[PROD_EMEA\]|\[PROD_AMER\]|\[PROD_MENA\]"
 *
 *   CRE — run all 7 environments in parallel (7 browsers):
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=7
 *
 * ─── DRY RUN & REPORT ─────────────────────────────────────────────────────────
 *
 *   CRE dry run (list tests, no browser):
 *     $env:RELEASE_VERSION="2026.05.00"; npx playwright test changeRequest.spec.ts --project=CRE --list
 *
 *   HTML report:
 *     npx playwright show-report
 */

import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '.env') });

// ─── SHARED BROWSER CONFIG ────────────────────────────────────────────────────
// channel: 'chrome' uses the system-installed Google Chrome instead of the
// Playwright-bundled Chromium binary. Required when the bundled binary is
// blocked by corporate policy.
const CHROME = {
  ...devices['Desktop Chrome'],
  channel:  'chrome',
  headless: false,
} as const;

export default defineConfig({
  testDir: '.',

  /* Run all tests in parallel across workers */
  fullyParallel: true,

  /* Fail the build on CI if test.only is accidentally left in code */
  forbidOnly: !!process.env.CI,

  /* No retries locally; 1 on CI */
  retries: process.env.CI ? 1 : 0,

  /**
   * TOP-LEVEL worker count — this is the ONLY place Playwright reads it.
   * (Project-level `workers` is not a valid key and is silently ignored.)
   *
   * Default: 7 (enough for all CRE environments at once).
   * Always override at runtime with --workers=N to match the number of tests:
   *
   *   CRE: --workers=1 (single) | --workers=2 (pair) | --workers=3 (region) | --workers=7 (all)
   */
  workers: process.env.CI ? 1 : 7,

  /* Per-test timeout: 10 min covers the full CR + CTask + Risk Assessment loop
   * on slow ServiceNow environments. The setup project overrides this to 3 min. */
  timeout: 10 * 60 * 1_000,

  /* Multi-reporter: HTML report + console formats + JSON/JUnit for CI */
  reporter: [
    ['html', { open: 'on-failure', outputFolder: 'playwright-report' }],
    ['list'],
    ['line'],
    ['dot'],
    ['json',  { outputFile: 'test-results.json' }],
    ['junit', { outputFile: 'test-results.xml'  }],
  ],

  use: {
    baseURL: 'https://trenterprise.service-now.com/now/sow/home',

    /* Capture screenshot / video only on failure to save disk space */
    screenshot: 'only-on-failure',
    video:      'retain-on-failure',

    /* Collect trace on failure so Trace Viewer can replay failed tests */
    trace: 'retain-on-failure',
  },

  projects: [
    // ── SSO Setup — runs once, saves session to auth_servicenow.json ──────────
    // dependencies: ['setup'] on CRE guarantees this finishes before any test
    // worker opens a browser. Workers then load the session from disk and land
    // directly on the ServiceNow dashboard — no SSO redirect.
    {
      name:      'setup',
      testMatch: /sso_setup\.ts/,
      use:       { ...CHROME },
      timeout:   3 * 60 * 1_000, // 3 min — override global 15 min for SSO setup
    },

    // ── CRE — ONESOURCE Determination CR automation (up to 7 envs in parallel) ─
    // Pass --workers=N on the CLI to choose how many browsers open at once.
    {
      name:         'CRE',
      testMatch:    /(changeRequest|riskmanagement|ctasks)\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        ...CHROME,
        storageState: path.join(__dirname, 'auth_servicenow.json'),        // Always capture screenshot + video for debugging (override global settings).
        // Review playwright-report/ after a run to see every step visually.
        screenshot: 'on',
        video:      'on',      },
    },

    // ── chromium — generic fallback / ad-hoc test runs ────────────────────────
    {
      name: 'chromium',
      use:  { ...CHROME },
    },
  ],
});
