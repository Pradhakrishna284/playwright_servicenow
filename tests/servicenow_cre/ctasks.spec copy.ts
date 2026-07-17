/**
 * CRE — CTask Creation (standalone)
 * ==================================
 *
 * Navigates to one or more existing Change Requests and creates all CTasks.
 * Run this AFTER changeRequest.spec.ts has created and submitted the CR(s).
 * CTasks are determined from TEST_CONFIGURATIONS (env/region-based steps).
 *
 * ─── HOW TO SPECIFY WHICH CRs TO PROCESS ────────────────────────────────────
 *
 *  Option A — By config name (recommended — auto-looks up CR from registry):
 *    Single:   $env:CR_CONFIG="UAT_MENA"
 *    Multiple: $env:CR_CONFIG="UAT_MENA,PROD_MENA"
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
 *    $env:RELEASE_VERSION="2026.05.00"   ← required for CTask descriptions
 *
 *  Single config (1 browser):
 *    $env:CR_CONFIG="UAT_MENA"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test CRE/ctasks.spec.ts --project=CRE --headed --workers=1
 *
 *  Multiple configs in parallel (N browsers):
 *    $env:CR_CONFIG="UAT_MENA,PROD_MENA"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test CRE/ctasks.spec.ts --project=CRE --headed --workers=2
 *
 *  All 7 envs in parallel:
 *    $env:CR_CONFIG="SAT,UAT_EMEA,UAT_AMER,UAT_MENA,PROD_EMEA,PROD_AMER,PROD_MENA"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test CRE/ctasks.spec.ts --project=CRE --headed --workers=7
 *
 *  By explicit CR numbers:
 *    $env:CR_NUMBERS="CHG0233029"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test CRE/ctasks.spec.ts --project=CRE --headed --workers=1
 *
 *  Target a specific config with --grep:
 *    $env:CR_CONFIG="UAT_MENA,PROD_MENA"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test CRE/ctasks.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_MENA\]"
 *
 *  Dry run (list tests, no browser):
 *    $env:CR_CONFIG="UAT_MENA"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test CRE/ctasks.spec.ts --project=CRE --list
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
  CTASK_CONFIGURATIONS,
  getCtaskConfig,
  getCtaskDescriptions,
  type ConfigKey,
} from './testDataConfig_CRE';
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

const ASSIGNMENT_GROUPS   = CTASK_CONFIGURATIONS.assignmentGroups;
const ASSIGNED_TO_DEFAULT = CTASK_CONFIGURATIONS.assignedTo.default;

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
  // Option B/C — explicit CR numbers → reverse-lookup config from registry
  const explicit = (process.env.CR_NUMBERS ?? process.env.CR_NUMBER ?? '').trim();
  if (explicit) {
    const crNums = explicit.split(',').map(s => s.trim()).filter(Boolean);
    return crNums.map(crNumber => {
      const registry = ChangeRequestStorage.loadAll();
      let configName: string | undefined;
      for (const crs of Object.values(registry)) {
        const entry = crs[crNumber];
        if (entry?.configName) { configName = entry.configName; break; }
      }
      if (!configName) throw new Error(
        `❌ No registry entry found for CR ${crNumber}.\n` +
        'Use $env:CR_CONFIG="<configName>" instead, or run changeRequest.spec.ts first.',
      );
      const testData = TEST_CONFIGURATIONS[configName as ConfigKey];
      if (!testData) throw new Error(
        `❌ Config "${configName}" (from registry for ${crNumber}) not found in TEST_CONFIGURATIONS.`,
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
      const testData = TEST_CONFIGURATIONS[configName as ConfigKey];
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
      'Example:  $env:RELEASE_VERSION="2026.05.00"',
    );
  }
  if (CTASK_TARGETS.length === 0) {
    throw new Error(
      '❌ No CTask targets resolved. Provide one of:\n\n' +
      '  Option A — config name (registry lookup):\n' +
      '    $env:CR_CONFIG="UAT_MENA"\n' +
      '    $env:CR_CONFIG="UAT_MENA,PROD_MENA"\n\n' +
      '  Option B — explicit CR numbers:\n' +
      '    $env:CR_NUMBERS="CHG0233029"\n' +
      '    $env:CR_NUMBERS="CHG0233029,CHG0233030"\n\n' +
      '  Option C — legacy single CR:\n' +
      '    $env:CR_NUMBER="CHG0233029"',
    );
  }
  console.log(`📋 CRE CTasks to create (${CTASK_TARGETS.length} CR(s)): ${CTASK_TARGETS.map(t => t.label).join(', ')}`);
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
    'active=true^short_description>=Content Rate Extract^ORDERBYshort_description',
  );
  const recordUri = encodeURIComponent(`change_request.do?sys_id=${sysId}&sysparm_record_list=${listFilter}`);
  await page.goto(`https://trenterprise.service-now.com/nav_to.do?uri=${recordUri}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForURL(/change_request\.do/i, { timeout: T_NAV });
  await page.waitForLoadState('domcontentloaded');
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
 * Returns the sys_id for a CR number from the registry (for fast-path navigation).
 */
function getSysIdForCr(crNumber: string): string | undefined {
  const registry = ChangeRequestStorage.loadAll();
  for (const crs of Object.values(registry)) {
    const entry = crs[crNumber];
    if (entry?.crSysId) return entry.crSysId;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// CTASK CREATION HELPER
// ─────────────────────────────────────────────────────────────────────────────

interface ApprovalGroup {
  assignment_group: string;
  assigned_to:      string;
  stepNumber:       number;
  department:       string;
}

async function createCtask(
  page: Page,
  iframe: FrameLocator,
  ag: ApprovalGroup,
  env: string,
  region: string | undefined,
  releaseVersion: string,
  buildVersion: string,
  plannedStartDate: string,
  plannedEndDate: string,
): Promise<void> {
  await iframe
    .locator('button[id*="sysverb_insert"], button[id*="sysverb_submit"]')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });

  const prefix = await detectCtaskPrefix(iframe);

  // Assigned To only for RM department
  await fillCtaskAssignment(
    iframe,
    prefix,
    ag.assignment_group,
    ag.department === 'RM' ? ag.assigned_to : undefined,
    T_SUGGEST,
  );

  await fillDateField(page, iframe, `${prefix}.planned_start_date`, plannedStartDate, 'Start Date', T_SUGGEST);
  await fillDateField(page, iframe, `${prefix}.planned_end_date`,   plannedEndDate,   'End Date',   T_SUGGEST);

  const desc = getCtaskDescriptions(env, region, releaseVersion, buildVersion)[ag.stepNumber];
  if (!desc) throw new Error(`No description for step ${ag.stepNumber} (env: ${env}, region: ${region})`);

  await iframe.locator(`input[id="${prefix}.short_description"]`).fill(desc.shortDescription);
  await iframe.locator(`textarea[id="${prefix}.description"]`).fill(desc.detailedDescription);

  await submitForm(iframe);
}

// ─────────────────────────────────────────────────────────────────────────────
// PARAMETRIZED TEST SUITE  (one test per CR — each runs in its own worker)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('CRE — CTask Creation', () => {
  for (const { crNumber, testData, label } of CTASK_TARGETS) {

    test(`[${label}] Create CTasks for ${crNumber}`, async ({ page }) => {
      test.setTimeout(15 * 60 * 1000); // 15 min per CR

      const { environment: env, region } = testData;

      // ── 1. Open Change Request ──────────────────────────────────────────────
      // Navigate directly to the CR — no separate home-page step needed.
      // If sys_id is available, go straight to the CR URL (fast, 1 page load).
      // If not, navigate to ServiceNow home first, then use list search.
      // Session check runs after domcontentloaded — before any waitForURL call —
      // to avoid "Target page, context or browser has been closed" from PingID.
      await test.step('1. Open Change Request', async () => {
        const sysId = getSysIdForCr(crNumber);

        if (sysId) {
          console.log(`  → Fast path: navigating by sys_id (${sysId})`);
          const listFilter = encodeURIComponent(
            'active=true^short_description>=Content Rate Extract^ORDERBYshort_description',
          );
          await page.goto(
            `${SERVICENOW_CR_URL}?sys_id=${sysId}&sysparm_record_list=${listFilter}`,
            { waitUntil: 'domcontentloaded', timeout: 60_000 },
          );
        } else {
          console.log(`  → Slow path: navigating to ServiceNow home (no sys_id for ${crNumber})`);
          await page.goto('https://trenterprise.service-now.com/', { waitUntil: 'domcontentloaded', timeout: 120_000 });
        }
        await page.waitForLoadState('domcontentloaded');

        // Session check — must happen before any waitForURL call.
        const landingUrl = page.url();
        if (/sso\.thomsonreuters\.com|pingone\.com|pingid\.com/i.test(landingUrl)) {
          await handleSSOExpiry(page);
          // Session recovered — proceed with list search from ServiceNow home
          if (!sysId) await navigateByListSearch(page, crNumber);
        }

        if (!sysId) {
          // No sys_id — use menu list search now that the session is confirmed valid
          await navigateByListSearch(page, crNumber);
        }

        await page.waitForURL(/change_request\.do(%3F|\?).*sys_id(%3D|=)/i, { timeout: T_NAV });
        await page.waitForLoadState('domcontentloaded');
        console.log(`✓ Opened CR ${crNumber}`);
      });

      // ── 2. Create all CTasks ───────────────────────────────────────────────
      await test.step('2. Create Change Tasks for all departments', async () => {
        const ctaskSteps = getCtaskConfig(env, region);

        const approvalGroups: ApprovalGroup[] = [
          ...ctaskSteps.rm.map(s      => ({ assignment_group: ASSIGNMENT_GROUPS.rm.name,      assigned_to: ASSIGNED_TO_DEFAULT, stepNumber: s, department: 'RM'      })),
          ...ctaskSteps.devops.map(s  => ({ assignment_group: ASSIGNMENT_GROUPS.devops.name,  assigned_to: ASSIGNED_TO_DEFAULT, stepNumber: s, department: 'DevOps'  })),
          ...ctaskSteps.techops.map(s => ({ assignment_group: ASSIGNMENT_GROUPS.techops.name, assigned_to: ASSIGNED_TO_DEFAULT, stepNumber: s, department: 'TechOps' })),
          ...ctaskSteps.qa.map(s      => ({ assignment_group: ASSIGNMENT_GROUPS.qa.name,      assigned_to: ASSIGNED_TO_DEFAULT, stepNumber: s, department: 'QA'      })),
        ];

        if (approvalGroups.length === 0) {
          console.log('ℹ No CTasks configured for this environment — skipping');
          return;
        }
        console.log(`Creating ${approvalGroups.length} CTask(s) for ${env}${region ? `/${region}` : ''}…`);

        for (let i = 0; i < approvalGroups.length; i++) {
          const ag = approvalGroups[i];
          console.log(`\n[CTask ${i + 1}/${approvalGroups.length}] ${ag.department} Step ${ag.stepNumber}`);

          let iframe = await getIframe(page);
          await clickElement(page, iframe.locator('span[role="tab"]:has-text("Change Tasks")'), 'Change Tasks tab');
          await page.waitForTimeout(2000);

          iframe = await getIframe(page);
          await clickElement(page, iframe.locator('button').filter({ hasText: /^New$/ }).first(), 'New CTask button');
          await page.waitForTimeout(2000);

          await verifyUrl(page, /change_task\.do%3F.*sys_id%3D-1/);

          iframe = await getIframe(page);
          await createCtask(
            page, iframe, ag,
            env, region,
            testData.releaseVersion, testData.buildVersion,
            testData.plannedStartDate, testData.plannedEndDate,
          );

          await page.waitForLoadState('domcontentloaded');
          await verifyUrl(page, /change_request\.do(%3F|\?).*sys_id(%3D|=)/i);
          await page.waitForTimeout(1000);
          console.log(`✓ CTask ${ag.department} Step ${ag.stepNumber} created`);
        }

        console.log(`\n✓ All ${approvalGroups.length} CTasks created for ${crNumber}`);
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
 *   $env:CR_CONFIG="UAT_MENA"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_cre/ctasks.spec.ts --project=CRE --headed --workers=1
 *
 * ── Multiple configs in parallel (N browsers) ────────────────────────────────
 *   $env:CR_CONFIG="UAT_MENA,PROD_MENA"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_cre/ctasks.spec.ts --project=CRE --headed --workers=2
 *
 * ── All 7 CRE envs in parallel ───────────────────────────────────────────────
 *   $env:CR_CONFIG="SAT,UAT_EMEA,UAT_AMER,UAT_MENA,PROD_EMEA,PROD_AMER,PROD_MENA"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_cre/ctasks.spec.ts --project=CRE --headed --workers=7
 *
 * ── By explicit CR number ────────────────────────────────────────────────────
 *   $env:CR_NUMBERS="CHG0283176"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_cre/ctasks.spec.ts --project=CRE --headed --workers=1
 *
 * ── Target a specific config with --grep ─────────────────────────────────────
 *   $env:CR_CONFIG="UAT_MENA,PROD_MENA"; $env:RELEASE_VERSION="2026.06.00"; npx playwright test servicenow_cre/ctasks.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_MENA\]"
 *
 * ── Dry run (list tests, no browser) ─────────────────────────────────────────
 *   $env:CR_CONFIG="UAT_MENA"; $env:RELEASE_VERSION="2026.05.00"; npx playwright test servicenow_cre/ctasks.spec.ts --project=CRE --list
 *
 * ── HTML report ───────────────────────────────────────────────────────────────
 *   npx playwright show-report
 * ─────────────────────────────────────────────────────────────────────────────
 */
