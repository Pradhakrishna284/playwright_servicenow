/**
 * TDR — CTask Creation (standalone)
 * ===================================
 *
 * Navigates to one or more existing Change Requests and creates all CTasks.
 * Run this AFTER changeRequest.spec.ts has created and submitted the CR(s).
 * CTasks are determined from TEST_CONFIGURATIONS (per-config ctaskConfigs arrays).
 *
 * ─── HOW TO SPECIFY WHICH CRs TO PROCESS ────────────────────────────────────
 *
 *  Option A — By config name (recommended — auto-looks up CR from registry):
 *    Single:   $env:CR_CONFIG="UAT"
 *    Multiple: $env:CR_CONFIG="UAT,QA"
 *
 *  Option B — Explicit CR numbers (auto-detects config from registry):
 *    Single:   $env:CR_NUMBERS="CHG0233029"
 *    Multiple: $env:CR_NUMBERS="CHG0233029,CHG0233030"
 *
 *  Option C — Legacy single CR (backward-compatible):
 *    $env:CR_NUMBER="CHG0233029"
 *
 * ─── RUN COMMANDS ────────────────────────────────────────────────────────────
 *
 *  Prerequisites:
 *    npx playwright test sso_setup.ts --project=setup --headed
 *    $env:RELEASE_VERSION="2026.06.00"   ← required for CTask descriptions
 *
 *  Single config (1 browser):
 *    $env:CR_CONFIG="UAT"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test TDR/ctasks.spec.ts --project=TDR --headed --workers=1
 *
 *  Multiple configs in parallel (N browsers):
 *    $env:CR_CONFIG="UAT,QA"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test TDR/ctasks.spec.ts --project=TDR --headed --workers=2
 *
 *  All 3 TDR configs in parallel:
 *    $env:CR_CONFIG="GENERATE_DUMP_PROD,UAT,QA"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test TDR/ctasks.spec.ts --project=TDR --headed --workers=3
 *
 *  By explicit CR number:
 *    $env:CR_NUMBERS="CHG0233029"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test TDR/ctasks.spec.ts --project=TDR --headed --workers=1
 *
 *  Target a specific config with --grep:
 *    $env:CR_CONFIG="UAT,QA"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test TDR/ctasks.spec.ts --project=TDR --headed --workers=1 --grep "\[UAT\]"
 *
 *  Dry run (list tests, no browser):
 *    $env:CR_CONFIG="UAT"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test TDR/ctasks.spec.ts --project=TDR --list
 *
 *  HTML report:
 *    npx playwright show-report
 */

import { test, expect, Page, FrameLocator } from '@playwright/test';
import {
  TEST_CONFIGURATIONS,
  COMMON_CONSTANTS,
  EnvironmentTestData,
  ChangeRequestStorage,
  type CtaskConfig,
} from './testDataConfig_TDR';
import {
  ALL_MENU_SELECTOR,
  OPEN_CR_SELECTOR,
  getIframe,
  verifyUrl,
  clickElement,
  scrollMenuUntil,
  fillDateField,
  submitForm,
  detectCtaskPrefix,
  fillCtaskAssignment,
  handleSSOExpiry,
} from '../helpers';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const {
  timeoutElementVisible: T_ELEMENT,
  timeoutPageNav:        T_NAV,
  timeoutAutosuggest:    T_SUGGEST,
} = COMMON_CONSTANTS;

const SERVICENOW_CR_URL = 'https://trenterprise.service-now.com/change_request.do';

// ─────────────────────────────────────────────────────────────────────────────
// CTASK TARGET RESOLUTION
// Precedence: CR_NUMBERS / CR_NUMBER  →  CR_CONFIG registry lookup
// ─────────────────────────────────────────────────────────────────────────────

interface CtaskTarget {
  crNumber: string;
  testData:  EnvironmentTestData;
  label:     string;
}

function resolveCtaskTargets(): CtaskTarget[] {
  // Option B/C — explicit CR numbers
  // If CR_CONFIG is also set it acts as a config override (useful when the registry
  // configName doesn't match TEST_CONFIGURATIONS keys, e.g. a manually-written YAML).
  const explicit = (process.env.CR_NUMBERS ?? process.env.CR_NUMBER ?? '').trim();
  const configOverride = (process.env.CR_CONFIG ?? '').trim();
  if (explicit) {
    const crNums      = explicit.split(',').map(s => s.trim()).filter(Boolean);
    const overrides   = configOverride ? configOverride.split(',').map(s => s.trim()).filter(Boolean) : [];
    return crNums.map((crNumber, idx) => {
      // Use positional override if provided, otherwise fall back to registry lookup
      const manualConfig = overrides[idx] ?? overrides[0];
      let configName: string | undefined = manualConfig;
      if (!configName) {
        const registry = ChangeRequestStorage.loadAll();
        configName = registry[crNumber]?.configName;
      }
      if (!configName) throw new Error(
        `❌ No registry entry found for CR ${crNumber}.\n` +
        'Provide $env:CR_CONFIG="<configName>" alongside $env:CR_NUMBERS to override,\n' +
        'or run changeRequest.spec.ts first to populate the registry.',
      );
      const testData = TEST_CONFIGURATIONS[configName];
      if (!testData) throw new Error(
        `❌ Config "${configName}" not found in TEST_CONFIGURATIONS.\n` +
        `Valid keys: ${Object.keys(TEST_CONFIGURATIONS).join(', ')}`,
      );
      return { crNumber, testData, label: `${configName} / ${crNumber}` };
    });
  }

  // Option A — config names → CR number from registry + testData from TEST_CONFIGURATIONS
  const configs = (process.env.CR_CONFIG ?? '').trim();
  if (configs) {
    const names = configs.split(',').map(s => s.trim()).filter(Boolean);
    const targets: CtaskTarget[] = [];
    for (const configName of names) {
      const crNumber = ChangeRequestStorage.getByConfig(configName);
      if (!crNumber) {
        console.warn(`⚠ No CR found in registry for config "${configName}" — skipping`);
        continue;
      }
      const testData = TEST_CONFIGURATIONS[configName];
      if (!testData) {
        console.warn(`⚠ Config "${configName}" not found in TEST_CONFIGURATIONS — skipping`);
        continue;
      }
      console.log(`✓ Registry lookup: ${configName} → ${crNumber}`);
      targets.push({ crNumber, testData, label: configName });
    }
    return targets;
  }

  return [];
}

const CTASK_TARGETS = resolveCtaskTargets();

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL SETUP — validate before any browser opens
// ─────────────────────────────────────────────────────────────────────────────

test.beforeAll(() => {
  if (!process.env.RELEASE_VERSION) {
    throw new Error(
      '❌ RELEASE_VERSION env var is required.\n' +
      'Example:  $env:RELEASE_VERSION="2026.06.00"',
    );
  }
  if (CTASK_TARGETS.length === 0) {
    throw new Error(
      '❌ No CTask targets resolved. Provide one of:\n\n' +
      '  Option A — config name (registry lookup):\n' +
      '    $env:CR_CONFIG="UAT"\n' +
      '    $env:CR_CONFIG="UAT,QA"\n\n' +
      '  Option B — explicit CR numbers:\n' +
      '    $env:CR_NUMBERS="CHG0233029"\n' +
      '    $env:CR_NUMBERS="CHG0233029,CHG0233030"\n\n' +
      '  Option C — legacy single CR:\n' +
      '    $env:CR_NUMBER="CHG0233029"',
    );
  }
  console.log(`📋 TDR CTasks to create (${CTASK_TARGETS.length} CR(s)): ${CTASK_TARGETS.map(t => t.label).join(', ')}`);
  console.log(`📋 Release Version: ${process.env.RELEASE_VERSION}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fast path: navigate to the CR via nav_to.do (one page load).
 * nav_to.do loads the full ServiceNow portal shell, which places the form
 * inside #gsft_main — required for all subsequent iframe interactions.
 * Navigating directly to change_request.do?sys_id=... bypasses the portal
 * shell and renders the form at page level (no #gsft_main).
 */
async function navigateBySysId(page: Page, sysId: string): Promise<void> {
  const listFilter = encodeURIComponent(
    'active=true^short_description>=Tax Data Repository^ORDERBYshort_description',
  );
  const recordUri = encodeURIComponent(`change_request.do?sys_id=${sysId}&sysparm_record_list=${listFilter}`);
  await page.goto(`https://trenterprise.service-now.com/nav_to.do?uri=${recordUri}`, { waitUntil: 'load', timeout: T_NAV });
  await page.waitForURL(/change_request\.do/i, { timeout: T_NAV });
  await page.waitForLoadState('load');
}

/**
 * Slow path: open the CR list, search by number, click the row.
 * Used as a fallback when no sys_id is available.
 */
async function navigateByListSearch(page: Page, crNumber: string): Promise<void> {
  const allMenu = page.locator(ALL_MENU_SELECTOR);
  await expect(allMenu).toBeVisible();
  await allMenu.click();
  await page.waitForLoadState('domcontentloaded');

  const openItem = await scrollMenuUntil(page, OPEN_CR_SELECTOR, 'Open (under Change)');
  await openItem.scrollIntoViewIfNeeded();
  await expect(openItem).toBeVisible({ timeout: 5_000 });
  await openItem.click();
  await page.waitForURL(/change_request_list\.do/, { timeout: T_NAV });
  await page.waitForLoadState('domcontentloaded');
  console.log('  ✓ Open Change Requests list loaded');

  const iframe = await getIframe(page);
  await iframe.getByRole('listbox', { name: /Change Requests list/ }).selectOption('number');

  const search = iframe.getByLabel('Search', { exact: true });
  await search.waitFor({ state: 'visible', timeout: T_ELEMENT });
  await search.click();
  await search.clear();
  await page.waitForTimeout(300);
  await search.type(crNumber, { delay: 50 });
  await page.waitForTimeout(1_000);
  expect(await search.inputValue()).toBe(crNumber);
  await search.press('Enter');

  const rows = iframe.locator('table > tbody.list2_body.-sticky-group-headers > tr.list_row');
  await rows.last().waitFor({ state: 'visible', timeout: T_ELEMENT });

  const crRow = rows.filter({ hasText: crNumber });
  await crRow.waitFor({ state: 'visible', timeout: T_ELEMENT });
  console.log(`  ✓ Found ${crNumber} in list`);

  await crRow.locator('td').nth(2).click();
  await page.waitForLoadState('domcontentloaded');
}

/**
 * Returns the sys_id for a CR number from the TDR registry (flat structure).
 */
function getSysIdForCr(crNumber: string): string | undefined {
  const registry = ChangeRequestStorage.loadAll();
  return (registry[crNumber] as any)?.crSysId;
}

// ─────────────────────────────────────────────────────────────────────────────
// CTASK CREATION HELPER
// ─────────────────────────────────────────────────────────────────────────────

async function createCtask(
  page: Page,
  iframe: FrameLocator,
  ctask: CtaskConfig,
  crStartDate: string,
  crEndDate: string,
): Promise<void> {
  await iframe
    .locator('button[id*="sysverb_insert"], button[id*="sysverb_submit"]')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });

  const prefix = await detectCtaskPrefix(iframe);

  // assignedTo empty string means no person assigned (e.g. ORACLE-SUPPORT-TR)
  await fillCtaskAssignment(iframe, prefix, ctask.assignmentGroup, ctask.assignedTo || undefined, T_SUGGEST);

  // Use ctask-specific dates if provided, otherwise fall back to CR dates
  await fillDateField(page, iframe, `${prefix}.planned_start_date`, ctask.plannedStartDate ?? crStartDate, 'Start Date', T_SUGGEST);
  await fillDateField(page, iframe, `${prefix}.planned_end_date`,   ctask.plannedEndDate   ?? crEndDate,   'End Date',   T_SUGGEST);

  if (ctask.shortDescription)    await iframe.locator(`input[id="${prefix}.short_description"]`).fill(ctask.shortDescription);
  if (ctask.detailedDescription) await iframe.locator(`textarea[id="${prefix}.description"]`).fill(ctask.detailedDescription);

  await submitForm(iframe);
}

// ─────────────────────────────────────────────────────────────────────────────
// PARAMETRIZED TEST SUITE  (one test per CR — each runs in its own worker)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('TDR — CTask Creation', () => {
  for (const { crNumber, testData, label } of CTASK_TARGETS) {

    test(`[${label}] Create CTasks for ${crNumber}`, async ({ page }) => {
      test.setTimeout(15 * 60 * 1000); // 15 min — TDR CTasks have longer descriptions

      // ── 1. Open Change Request ─────────────────────────────────────────────
      // Two-tier navigation: sys_id (fast) → list search (fallback).
      // SSO check runs after the first goto — before any waitForURL call —
      // to avoid PingID closing the page mid-navigation.
      await test.step('1. Open Change Request', async () => {
        const sysId = getSysIdForCr(crNumber);

        if (sysId) {
          console.log(`  → Fast path: navigating by sys_id (${sysId})`);
          await navigateBySysId(page, sysId);
        } else {
          console.log(`  → Slow path: navigating to ServiceNow home (no sys_id for ${crNumber})`);
          await page.goto('https://trenterprise.service-now.com/', { waitUntil: 'domcontentloaded', timeout: 120_000 });
        }
        await page.waitForLoadState('domcontentloaded');

        // Session check — must happen before any waitForURL call.
        const finalUrl = page.url();
        if (/sso\.thomsonreuters\.com|pingone\.com|pingid\.com/i.test(finalUrl)) {
          await handleSSOExpiry(page);
          // Session recovered — proceed with list search from ServiceNow home
          if (!sysId) await navigateByListSearch(page, crNumber);
        }

        if (!sysId) {
          // No sys_id — use menu list search now that session is confirmed valid
          await navigateByListSearch(page, crNumber);
        }

        await page.waitForURL(/change_request\.do/i, { timeout: T_NAV });
        await page.waitForLoadState('load', { timeout: T_NAV });
        console.log(`✓ Opened CR ${crNumber}`);
      });

      // ── 2. Create all CTasks ───────────────────────────────────────────────
      await test.step('2. Create Change Tasks', async () => {
        const ctaskConfigs = testData.ctaskConfigs ?? [];
        if (ctaskConfigs.length === 0) {
          console.log('ℹ No CTasks configured for this environment — skipping');
          return;
        }
        console.log(`Creating ${ctaskConfigs.length} CTask(s)…`);

        for (let i = 0; i < ctaskConfigs.length; i++) {
          const ctask = ctaskConfigs[i];
          console.log(`\n[CTask ${i + 1}/${ctaskConfigs.length}] ${ctask.assignmentGroup}`);

          let iframe = await getIframe(page);
          await clickElement(page, iframe.locator('span[role="tab"]:has-text("Change Tasks")'), 'Change Tasks tab');
          await page.waitForTimeout(2000);

          iframe = await getIframe(page);
          await clickElement(page, iframe.locator('button').filter({ hasText: /^New$/ }).first(), 'New CTask button');
          await page.waitForTimeout(2000);

          await verifyUrl(page, /change_task\.do%3F.*sys_id%3D-1/);

          iframe = await getIframe(page);
          await createCtask(page, iframe, ctask, testData.plannedStartDate, testData.plannedEndDate);

          await page.waitForLoadState('domcontentloaded');
          await verifyUrl(page, /change_request\.do(%3F|\?).*sys_id(%3D|=)/i);
          await page.waitForTimeout(1000);
          console.log(`✓ CTask ${i + 1} (${ctask.assignmentGroup}) created`);
        }

        console.log(`\n✓ All ${ctaskConfigs.length} CTasks created for ${crNumber}`);
      });

    });
  }
});

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO RUN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * STEP 1 — SSO setup (run once; re-run if auth_servicenow.json is older than 8 hours)
 *   npx playwright test sso_setup.ts --project=setup --headed
 *
 * ── Single config (1 browser) ────────────────────────────────────────────────
 *   $env:CR_CONFIG="UAT"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/ctasks.spec.ts --project=TDR --headed --workers=1
 *
 * ── Multiple configs in parallel (N browsers) ────────────────────────────────
 *   $env:CR_CONFIG="UAT,QA"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/ctasks.spec.ts --project=TDR --headed --workers=2
 *
 * ── All 3 TDR configs in parallel ────────────────────────────────────────────
 *   $env:CR_CONFIG="GENERATE_DUMP_PROD,UAT,QA"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/ctasks.spec.ts --project=TDR --headed --workers=3
 *
 * ── By explicit CR number ────────────────────────────────────────────────────
 *   $env:CR_NUMBERS="CHG0196795"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_tdr/ctasks.spec.ts --project=TDR --headed --workers=1
 *
 * ── Target a specific config with --grep ─────────────────────────────────────
 *   $env:CR_CONFIG="UAT,QA"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_tdr/ctasks.spec.ts --project=TDR --headed --workers=1 --grep "\[UAT\]"
 *
 * ── Dry run (list tests, no browser) ─────────────────────────────────────────
 *   $env:CR_CONFIG="UAT"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test serivcenow_tdr/ctasks.spec.ts --project=TDR --list
 *
 * ── HTML report ───────────────────────────────────────────────────────────────
 *   npx playwright show-report
 * ─────────────────────────────────────────────────────────────────────────────
 */
