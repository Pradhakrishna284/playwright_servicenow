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
  handleSSOExpiry,
  // approveCR, // uncomment when approveCR is added to helpers.ts
} from '../helpers';

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
 *   - Fast path: direct sys_id URL (1 page load, ~3s)
 *   - Slow path: home → menu → list search (fallback when no sys_id available)
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

test.describe('CRE — Risk Assessment and Request for Approval', () => {
  for (const crNumber of CR_NUMBERS) {

    test(`[${crNumber}] Risk Assessment and Request for Approval`, async ({ page }) => {
      test.setTimeout(10 * 60 * 1000); // 10 minutes per CR

      // ── 1. Open Change Request ──────────────────────────────────────────────
      // Two-tier navigation: nav_to.do sys_id (fast) → list search (fallback).
      // nav_to.do loads the ServiceNow portal shell so the form renders inside
      // #gsft_main — direct change_request.do navigation bypasses the shell.
      await test.step('1. Open Change Request', async () => {
        const sysId = getSysIdForCr(crNumber);

        if (sysId) {
          console.log(`  → Fast path: navigating by sys_id (${sysId})`);
          const listFilter = encodeURIComponent(
            'active=true^short_description>=Content Rate Extract^ORDERBYshort_description',
          );
          const recordUri = encodeURIComponent(`change_request.do?sys_id=${sysId}&sysparm_record_list=${listFilter}`);
          await page.goto(
            `https://trenterprise.service-now.com/nav_to.do?uri=${recordUri}`,
            { waitUntil: 'load', timeout: T_NAV },
          );
        } else {
          console.log(`  → Slow path: navigating to ServiceNow home (no sys_id for ${crNumber})`);
          await page.goto('https://trenterprise.service-now.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
        }
        await page.waitForLoadState('domcontentloaded');

        // Session check — catches both immediate and deferred SSO redirects.
        const landingUrl = page.url();
        if (/sso\.thomsonreuters\.com|pingone\.com|pingid\.com/i.test(landingUrl)) {
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

      // ── 2. Create Risk Assessment ──────────────────────────────────────────
      await test.step('2. Create Risk Assessment', async () => {
        // ServiceNow can trigger a deferred background auth check AFTER the
        // 'load' event in step 1. Re-check the URL here before calling
        // getIframe() — which has no timeout and hangs indefinitely if the
        // page has navigated away to SSO.
        await page.waitForLoadState('load', { timeout: T_NAV });
        const preUrl = page.url();
        if (/sso\.thomsonreuters\.com|pingone\.com|pingid\.com/i.test(preUrl)) {
          await handleSSOExpiry(page);
          // Re-navigate to the CR after session recovery
          const sysId = getSysIdForCr(crNumber);
          if (sysId) {
            const listFilter = encodeURIComponent(
              'active=true^short_description>=Content Rate Extract^ORDERBYshort_description',
            );
            const recordUri = encodeURIComponent(`change_request.do?sys_id=${sysId}&sysparm_record_list=${listFilter}`);
            await page.goto(
              `https://trenterprise.service-now.com/nav_to.do?uri=${recordUri}`,
              { waitUntil: 'load', timeout: T_NAV },
            );
          } else {
            await navigateByListSearch(page, crNumber);
          }
          await page.waitForLoadState('load', { timeout: T_NAV });
        }

        const iframe = await getIframe(page);
        await createRiskAssessmentTask(page, iframe, T_ELEMENT);
        // After the risk assessment popup closes, ServiceNow reloads the CR form.
        // Wait for the full 'load' event so all form JS is fully wired before
        // attempting to click "Request Approval" in the next step.
        await page.waitForTimeout(3_000); // 3s buffer for AJAX + DOM wiring
        // ServiceNow sometimes triggers a deferred background auth check AFTER the
        // 'load' event. Re-check the URL here before proceeding — getIframe() has
        // no timeout and hangs indefinitely if the page has navigated away to SSO.
        const postUrl = page.url();
        if (/sso\.thomsonreuters\.com|pingone\.com|pingid\.com/i.test(postUrl)) {
          await handleSSOExpiry(page);
          // Re-navigate to the CR after session recovery
          const sysId = getSysIdForCr(crNumber);
          if (sysId) {
            const listFilter = encodeURIComponent(
              'active=true^short_description>=Content Rate Extract^ORDERBYshort_description',
            );
            const recordUri = encodeURIComponent(`change_request.do?sys_id=${sysId}&sysparm_record_list=${listFilter}`);
            await page.goto(
              `https://trenterprise.service-now.com/nav_to.do?uri=${recordUri}`,
              { waitUntil: 'load', timeout: T_NAV },
            );
          } else {
            await navigateByListSearch(page, crNumber);
          }
          await page.waitForLoadState('load', { timeout: T_NAV });
        }
        const refreshedIframe = page.frameLocator('#gsft_main');
        await refreshedIframe
          .locator('input[id="change_request.number"]')
          .waitFor({ state: 'attached', timeout: T_ELEMENT });
        console.log('✓ CR form fully loaded after risk assessment');
      });

      // ── 3. Request Approval ─────────────────────────────────────────────────
      await test.step('3. Request Approval', async () => {
        await page.waitForLoadState('load', { timeout: T_NAV });
        const iframe = page.frameLocator('#gsft_main');

        // Wait for button — confirms CR is in the correct pre-transition state.
        const btn = iframe.locator('button#state_model_request_cab_approval');
        await btn.waitFor({ state: 'visible', timeout: T_ELEMENT });

        // Click the button directly — this fires the full onclick which sets
        // window.state_model_request_cab_approval before calling moveToAuthorize().
        // Calling moveToAuthorize() without that context causes the server-side
        // transition to silently fail (button remains visible after reload).
        try {
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ force: true });
          console.log('✓ Request Approval clicked');
        } catch {
          // Fallback: set window context manually, then call moveToAuthorize()
          const gsftFrame = page.frames().find(f => f !== page.mainFrame());
          if (!gsftFrame) throw new Error('gsft_main frame not found');
          await gsftFrame.evaluate(() => {
            const el = document.getElementById('state_model_request_cab_approval');
            if (el) (window as any).state_model_request_cab_approval = el;
            const fn = (globalThis as any).moveToAuthorize;
            if (typeof fn !== 'function') throw new Error('moveToAuthorize not found on globalThis');
            fn();
          });
          console.log('✓ moveToAuthorize() called in frame context');
        }

        // Wait 3s for the AJAX state transition to complete server-side before
        // reloading. Attempting to intercept the exact AJAX response is unreliable
        // because moveToAuthorize() calls a ServiceNow-internal endpoint (not
        // change_request.do), and broader filters match background polling first.
        await page.waitForTimeout(3_000);
        await page.reload({ waitUntil: 'load', timeout: T_NAV });
        console.log('✓ Page reloaded after state transition');

        // Both buttons gone — confirms the CR moved to Authorize state.
        const reloadedIframe = page.frameLocator('#gsft_main');
        await expect(reloadedIframe.locator('button#state_model_request_cab_approval'))
          .toBeHidden({ timeout: T_ELEMENT });
        await expect(reloadedIframe.locator('#RiskAssessmentV2'))
          .toBeHidden({ timeout: T_ELEMENT });
        console.log('✓ Request Approval and Risk Assessment buttons gone — state transition confirmed');
        console.log(`✓ [${crNumber}] Request Approval complete`);
      });

      // ── 4. Approve CR from RM team (uncomment when needed) ─────────────────
      // await test.step('4. Approve CR from RM team', async () => {
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
 *   $env:CR_NUMBERS="CHG0282683"; npx playwright test servicenow_cre/riskmanagement.spec.ts --project=CRE --headed --workers=1
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
