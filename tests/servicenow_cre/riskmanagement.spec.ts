/**
 * CRE — Risk Assessment & Submit for Assess
 * ==========================================
 *
 * Navigates to one or more Change Requests, submits the Risk Assessment form,
 * then clicks "Submit for Assess" for each.
 *
 * Multiple CRs run in PARALLEL — each gets its own browser worker.
 * The SSO session is already loaded via storageState — no login step required.
 *
 * ─── HOW TO SPECIFY WHICH CRs TO PROCESS ────────────────────────────────────
 *
 *  Option A — Explicit CR numbers (recommended):
 *    Single:   $env:CR_NUMBERS="CHG0233029"
 *    Multiple: $env:CR_NUMBERS="CHG0233029,CHG0233030,CHG0233031"
 *
 *  Option B — Registry lookup by config name (no copy-paste needed):
 *    Single:   $env:CR_CONFIG="PROD_MENA"
 *    Multiple: $env:CR_CONFIG="UAT_MENA,PROD_MENA"
 *    Looks up the most recent CR for each config from change_request_registry.yaml.
 *
 *  Option C — Legacy single CR (backward-compatible):
 *    $env:CR_NUMBER="CHG0233029"
 *
 * ─── RUN COMMANDS ────────────────────────────────────────────────────────────
 *
 *  Prerequisites:
 *    npx playwright test sso_setup.ts --project=setup --headed
 *
 *  Single CR (1 browser):
 *    $env:CR_NUMBERS="CHG0233029"; npx playwright test CRE/riskmanagement.spec.ts --project=CRE --headed --workers=1
 *
 *  Multiple CRs in parallel (N browsers):
 *    $env:CR_NUMBERS="CHG0233029,CHG0233030"; npx playwright test CRE/riskmanagement.spec.ts --project=CRE --headed --workers=2
 *
 *  By config name — single:
 *    $env:CR_CONFIG="PROD_MENA"; npx playwright test CRE/riskmanagement.spec.ts --project=CRE --headed --workers=1
 *
 *  By config name — multiple in parallel:
 *    $env:CR_CONFIG="UAT_MENA,PROD_MENA"; npx playwright test CRE/riskmanagement.spec.ts --project=CRE --headed --workers=2
 *
 *  All 7 envs from registry in parallel:
 *    $env:CR_CONFIG="SAT,UAT_EMEA,UAT_AMER,UAT_MENA,PROD_EMEA,PROD_AMER,PROD_MENA"; npx playwright test CRE/riskmanagement.spec.ts --project=CRE --headed --workers=7
 *
 *  Target a specific CR with --grep:
 *    $env:CR_NUMBERS="CHG0233029,CHG0233030"; npx playwright test CRE/riskmanagement.spec.ts --project=CRE --headed --workers=1 --grep "CHG0233029"
 *
 *  Dry run (list tests, no browser):
 *    $env:CR_NUMBERS="CHG0233029,CHG0233030"; npx playwright test CRE/riskmanagement.spec.ts --project=CRE --list
 *
 *  HTML report:
 *    npx playwright show-report
 */

import { test, expect, Page, FrameLocator } from '@playwright/test';
import { COMMON_CONSTANTS, ChangeRequestStorage } from './testDataConfig_CRE';
import {
  ALL_MENU_SELECTOR,
  OPEN_CR_SELECTOR,
  getIframe,
  scrollMenuUntil,
  createRiskAssessmentTask,
  // approveCR, // uncomment when approveCR is added to helpers.ts
} from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const {
  timeoutElementVisible: T_ELEMENT,
  timeoutPageNav:        T_NAV,
} = COMMON_CONSTANTS;

const SERVICENOW_CR_URL = 'https://trenterprise.service-now.com/change_request.do';

// ─────────────────────────────────────────────────────────────────────────────
// CR NUMBER RESOLUTION
// Precedence: CR_NUMBERS  →  CR_NUMBER (legacy)  →  CR_CONFIG registry lookup
// ─────────────────────────────────────────────────────────────────────────────

function resolveCrNumbers(): string[] {
  // Option A / C — explicit number(s)
  const explicit = (process.env.CR_NUMBERS ?? process.env.CR_NUMBER ?? '').trim();
  if (explicit) return explicit.split(',').map(s => s.trim()).filter(Boolean);

  // Option B — look up latest CR per config name from the registry
  const configs = (process.env.CR_CONFIG ?? '').trim();
  if (configs) {
    const names = configs.split(',').map(s => s.trim()).filter(Boolean);
    const resolved: string[] = [];
    for (const name of names) {
      const crNumber = ChangeRequestStorage.getByConfig(name);
      if (crNumber) {
        console.log(`✓ Registry lookup: ${name} → ${crNumber}`);
        resolved.push(crNumber);
      } else {
        console.warn(`⚠ No CR found in registry for config "${name}" — skipping`);
      }
    }
    return resolved;
  }

  return [];
}

const CR_NUMBERS = resolveCrNumbers();

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL SETUP — validate before any browser opens
// ─────────────────────────────────────────────────────────────────────────────

test.beforeAll(() => {
  if (CR_NUMBERS.length === 0) {
    throw new Error(
      '❌ No CR numbers to process. Provide one of:\n\n' +
      '  Option A — explicit numbers:\n' +
      '    $env:CR_NUMBERS="CHG0233029"\n' +
      '    $env:CR_NUMBERS="CHG0233029,CHG0233030"\n\n' +
      '  Option B — config name (registry lookup):\n' +
      '    $env:CR_CONFIG="PROD_MENA"\n' +
      '    $env:CR_CONFIG="UAT_MENA,PROD_MENA"\n\n' +
      '  Option C — legacy single CR:\n' +
      '    $env:CR_NUMBER="CHG0233029"',
    );
  }
  console.log(`📋 CRs to process (${CR_NUMBERS.length}): ${CR_NUMBERS.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fast path: navigate directly to the CR by sys_id (one page load).
 * Used when the registry has a crSysId entry — skips the list search entirely.
 */
async function navigateBySysId(page: Page, sysId: string): Promise<void> {
  const listFilter = encodeURIComponent(
    'active=true^short_description>=Content Rate Extract^ORDERBYshort_description',
  );
  const directUrl = `${SERVICENOW_CR_URL}?sys_id=${sysId}&sysparm_record_list=${listFilter}`;
  await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForURL(/change_request\.do(%3F|\?).*sys_id(%3D|=)/i, { timeout: T_NAV });
  await page.waitForLoadState('domcontentloaded');
}

/**
 * Slow path: open the CR list, search by number, click the row.
 * Used as a fallback when no sys_id is available (e.g. old registry entries).
 */
async function navigateByListSearch(page: Page, crNumber: string): Promise<void> {
  // Navigate to Open CRs list via the All menu
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

  // Search by CR number
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
 * Resolve navigation strategy for a CR number:
 *   - Prefer direct sys_id navigation (fast, 1 page load)
 *   - Fall back to list search (slow, 3 interactions)
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
// PARAMETERISED TEST SUITE  (one test per CR — each runs in its own worker)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('CRE — Risk Assessment and Submit for Assess', () => {
  for (const crNumber of CR_NUMBERS) {

    test(`[${crNumber}] Risk Assessment and Submit for Assess`, async ({ page }) => {
      test.setTimeout(10 * 60 * 1000); // 10 minutes per CR

      // ── 1. Navigate to application ─────────────────────────────────────────
      await test.step('1. Navigate to application', async () => {
        await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForURL(/trenterprise\.service-now\.com/);
        await page.waitForLoadState('domcontentloaded');
        console.log(`✓ [${crNumber}] Navigated to ServiceNow`);
      });

      // ── 2. Open Change Request ─────────────────────────────────────────────
      // Fast path: direct sys_id URL (1 page load, no searching).
      // Slow path: list search (used when CR was created before sys_id capture was added).
      await test.step('2. Open Change Request', async () => {
        const sysId = getSysIdForCr(crNumber);

        if (sysId) {
          console.log(`  → Fast path: navigating by sys_id (${sysId})`);
          await navigateBySysId(page, sysId);
        } else {
          console.log(`  → Slow path: searching list (no sys_id in registry for ${crNumber})`);
          await navigateByListSearch(page, crNumber);
        }

        console.log(`✓ Opened CR ${crNumber}`);
      });

      // ── 3. Create Risk Assessment ───────────────────────────────────────────
      await test.step('3. Create Risk Assessment', async () => {
        const iframe = await getIframe(page);
        await createRiskAssessmentTask(page, iframe, T_ELEMENT);

        // Wait for CR number field to be attached — the form re-renders after
        // the risk assessment popup closes (field may not be visible yet).
        await page.waitForLoadState('domcontentloaded');
        const refreshedIframe = page.frameLocator('#gsft_main');
        await refreshedIframe
          .locator('input[id="change_request.number"]')
          .waitFor({ state: 'attached', timeout: T_ELEMENT });
        console.log('✓ CR form ready after risk assessment');
      });

      // ── 4. Submit for Assess ────────────────────────────────────────────────
      // Uses the exact same pattern as changeRequest.spec.ts Step 10.
      await test.step('4. Submit for Assess', async () => {
        await page.waitForLoadState('domcontentloaded');
        const iframe = page.frameLocator('#gsft_main');

        try {
          const btn = iframe.locator('button#state_model_request_assess_approval');
          await btn.waitFor({ state: 'visible', timeout: T_ELEMENT });
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ force: true });
          console.log('✓ Submit for Assess clicked');
        } catch {
          const frame = page.frames().find(f => f !== page.mainFrame());
          if (!frame) throw new Error('gsft_main frame not found');
          await frame.evaluate(() => {
            const fn = (globalThis as any).moveToAssess;
            if (typeof fn === 'function') fn();
            else throw new Error('moveToAssess not found on globalThis');
          });
          console.log('✓ moveToAssess() executed via JS');
        }

        await page.waitForURL(/change_request\.do(%3F|\?).*sys_id(%3D|=)/, { timeout: T_NAV });
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2_000);
        console.log(`✓ [${crNumber}] Submit for Assess complete`);
      });

      // ── 5. Approve CR from RM team (uncomment when needed) ─────────────────
      // await test.step('5. Approve CR from RM team', async () => {
      //   const iframe = await getIframe(page);
      //   await approveCR(page, iframe, ASSIGNED_TO_RM, T_ELEMENT);
      // });
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
 * ── Single CR (1 browser) ─────────────────────────────────────────────────────
 *   $env:CR_NUMBERS="CHG0269659"; npx playwright test servicenow_cre/riskmanagement.spec.ts --project=CRE --headed --workers=1
 *
 * ── Multiple CRs in parallel (N browsers) ────────────────────────────────────
 *   $env:CR_NUMBERS="CHG0269507,CHG0267775"; npx playwright test servicenow_cre/riskmanagement.spec.ts --project=CRE --headed --workers=2
 *
 * ── By config name — single (looks up latest CR from registry) ───────────────
 *   $env:CR_CONFIG="PROD_MENA"; npx playwright test servicenow_cre/riskmanagement.spec.ts --project=CRE --headed --workers=1
 *
 * ── By config name — multiple in parallel ────────────────────────────────────
 *   $env:CR_CONFIG="UAT_MENA,PROD_MENA"; npx playwright test servicenow_cre/riskmanagement.spec.ts --project=CRE --headed --workers=2
 *
 * ── All 7 environments from registry in parallel ──────────────────────────────
 *   $env:CR_CONFIG="SAT,UAT_EMEA,UAT_AMER,UAT_MENA,PROD_EMEA,PROD_AMER,PROD_MENA"; npx playwright test servicenow_cre/riskmanagement.spec.ts --project=CRE --headed --workers=7
 *
 * ── Target a specific CR with --grep ─────────────────────────────────────────
 *   $env:CR_NUMBERS="CHG0233029,CHG0233030"; npx playwright test servicenow_cre/riskmanagement.spec.ts --project=CRE --headed --workers=1 --grep "CHG0233029"
 *
 * ── Dry run (list tests, no browser) ─────────────────────────────────────────
 *   $env:CR_NUMBERS="CHG0233029,CHG0233030"; npx playwright test servicenow_cre/riskmanagement.spec.ts --project=CRE --list
 *
 * ── HTML report ───────────────────────────────────────────────────────────────
 *   npx playwright show-report
 * ─────────────────────────────────────────────────────────────────────────────
 */
