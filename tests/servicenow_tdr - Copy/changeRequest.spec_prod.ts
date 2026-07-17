/**
 * TDR CHANGE REQUEST CREATION AND CTASK MANAGEMENT
 * =================================================
 *
 * Creates Change Requests for Tax Data Repository data refresh operations.
 * Configurations run in mandatory order: GENERATE_DUMP_PROD → UAT → QA
 * Shared browser helpers imported from ../shared/helpers.ts.
 *
 * Prerequisites:
 *   1. Run SSO setup once: click "Run SSO Setup" in the launcher (http://localhost:3131/tdr)
 *      or run manually:  npx playwright test tests/sso_setup.ts --project=setup --headed
 *   2. Set release version: $env:RELEASE_VERSION="2026.07.00"
 *   3. Run all configs:     npx playwright test servicenow_tdr/changeRequest.spec.ts --headed
 *
 * See README.md for full usage guide.
 */

import { test, expect, Page, FrameLocator } from '@playwright/test';
import {
  TEST_CONFIGURATIONS_ORDERED,
  COMMON_CONSTANTS,
  EnvironmentTestData,
  ChangeRequestStorage,
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
  fillMainForm,
  fillPlanningTab,
  fillScheduleTab,
  createRiskAssessmentTask,
  detectCtaskPrefix,
  fillCtaskAssignment,
  handleSSOExpiry,
} from '../helpers';

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL SETUP
// ─────────────────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  if (!process.env.RELEASE_VERSION) {
    throw new Error(
      '❌ RELEASE_VERSION env var is required.\n' +
      'Example:  $env:RELEASE_VERSION="2026.07.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --headed',
    );
  }
  console.log(`📋 TDR Release Version: ${process.env.RELEASE_VERSION}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const {
  timeoutElementVisible: T_ELEMENT,
  timeoutPageNav:        T_NAV,
  categoryValue:         CATEGORY_VALUE,
  categoryText:          CATEGORY_TEXT,
  serviceText:           SERVICE_TEXT,
  assignmentGroupRmText: AG_RM,
  assignedToRmText:      ASSIGNED_TO_RM,
  timeoutAutosuggest:    T_SUGGEST,
} = COMMON_CONSTANTS;

const SERVICENOW_CR_URL = 'https://trenterprise.service-now.com/change_request.do';

/** Race window for capturing sys_id from the brief post-submit URL. */
const T_SYS_ID_RACE = 10_000;

/** CTask loop: settle time after clicking the Change Tasks tab. */
const T_TAB_SETTLE  = 3_000;

/** CTask loop: settle time after CTask form URL loads (field init JS). */
const T_FORM_SETTLE = 3_000;

/** CTask loop: settle time after CTask submit, before next iteration. */
const T_CR_SETTLE   = 2_000;

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION HELPERS  (mirrors CRE changeRequest.spec.ts)
// ─────────────────────────────────────────────────────────────────────────────

function getSysIdForCr(crNumber: string): string | undefined {
  const registry = ChangeRequestStorage.loadAll();
  return (registry[crNumber] as any)?.crSysId;
}

async function navigateBySysId(page: Page, sysId: string): Promise<void> {
  const listFilter = encodeURIComponent(
    'active=true^short_description>=Tax Data Repository^ORDERBYshort_description',
  );
  const recordUri = encodeURIComponent(`change_request.do?sys_id=${sysId}&sysparm_record_list=${listFilter}`);
  await page.goto(
    `https://trenterprise.service-now.com/nav_to.do?uri=${recordUri}`,
    { waitUntil: 'domcontentloaded', timeout: T_NAV },
  );
 
  await page.waitForURL(/change_request\.do/i, { timeout: T_NAV });
  await page.waitForLoadState('domcontentloaded');
}

async function navigateByListSearch(page: Page, crNumber: string): Promise<void> {
  const allMenu = page.locator(ALL_MENU_SELECTOR);
  await expect(allMenu).toBeVisible({ timeout: T_NAV });
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
  await search.fill(crNumber);
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

async function waitForCRDetail(page: Page): Promise<void> {
  await page.waitForURL(/change_request\.do(%3F|\?).*sys_id(%3D|=)/i, { timeout: T_NAV });
  await page.waitForLoadState('domcontentloaded');
  const iframe = page.frameLocator('#gsft_main');
  await iframe.locator('body').waitFor({ state: 'attached', timeout: T_ELEMENT });
  await iframe
    .locator('input[id="change_request.number"]')
    .waitFor({ state: 'attached', timeout: T_ELEMENT });
}

// ─────────────────────────────────────────────────────────────────────────────
// TDR-SPECIFIC: CR SUBMIT  (config item is env-specific, captures sysId)
// ─────────────────────────────────────────────────────────────────────────────

async function fillAndSubmitCR(page: Page, iframe: FrameLocator, testData: EnvironmentTestData): Promise<void> {
  await fillMainForm(iframe, testData, CATEGORY_VALUE, CATEGORY_TEXT, SERVICE_TEXT, testData.configItemText, AG_RM, ASSIGNED_TO_RM, T_SUGGEST);
  await fillPlanningTab(iframe, testData);
  await fillScheduleTab(page, iframe, testData, T_SUGGEST);

  const crNumber = await iframe.locator('input[id="change_request.number"]').inputValue();
  console.log(`✓ CR Number: ${crNumber}`);

  await submitForm(iframe);

  // Race: capture sys_id from the brief intermediate URL before redirect
  let sysId: string | undefined;
  try {
    await page.waitForURL(/change_request\.do(%3F|\?).*sys_id(%3D|=)([a-f0-9]{32})/i, { timeout: T_SYS_ID_RACE });
    sysId = decodeURIComponent(page.url()).match(/sys_id=([a-f0-9]{32})/i)?.[1];
  } catch {
    sysId = decodeURIComponent(page.url()).match(/sys_id=([a-f0-9]{32})/i)?.[1];
  }
  await page.waitForLoadState('domcontentloaded');
  if (sysId) console.log(`✓ sys_id: ${sysId}`);
  else console.log('⚠ sys_id not captured — step 7 will use list-search fallback');

  if (crNumber?.trim()) {
    await ChangeRequestStorage.save(testData.configName, crNumber, testData.releaseVersion, sysId);
    testData.changeRequestNumber = crNumber;
    testData.createdAt = new Date().toISOString();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TDR-SPECIFIC: CTASK CREATION  (array-driven, per-task dates)
// ─────────────────────────────────────────────────────────────────────────────

async function createCtask(
  page: Page,
  iframe: FrameLocator,
  ctask: NonNullable<EnvironmentTestData['ctaskConfigs']>[number],
  crStartDate: string,
  crEndDate: string,
): Promise<void> {
  await iframe.locator('button[id*="sysverb_insert"], button[id*="sysverb_submit"]')
    .first().waitFor({ state: 'visible', timeout: 30_000 });

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
// PARAMETRIZED TEST SUITE  (all 3 configs run in parallel — one worker each)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('TDR Change Request Creation — All Configs (Parallel)', () => {
  for (const [configKey, testData] of TEST_CONFIGURATIONS_ORDERED) {

    test(`[${configKey}] CR Creation and CTask Management`, async ({ page }) => {
      test.setTimeout(15 * 60 * 1000); // 15 min — TDR CTasks have longer descriptions

      // ── 1. Navigate to app ──
      await test.step('1. Navigate to application', async () => {
        await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('domcontentloaded');

        // Do NOT call waitForURL before this check — PingID's redirect chain
        // calls window.close() mid-navigation causing "Target page closed".
        const finalUrl = page.url();
        if (/sso\.thomsonreuters\.com|pingone\.com|pingid\.com/i.test(finalUrl)) {
          await handleSSOExpiry(page);
          // Session recovered — proceed from ServiceNow home
        }
        await expect(page).toHaveURL(/trenterprise\.service-now\.com/, { timeout: T_ELEMENT });
        await page.waitForLoadState('domcontentloaded');
        console.log(`✓ [${configKey}] Navigated to ServiceNow`);
      });

      // ── 2. Open Create New Change Request ──
      await test.step('2. Open Create New Change Request', async () => {
        const allMenu = page.locator(ALL_MENU_SELECTOR);
        await expect(allMenu).toBeVisible();
        await allMenu.click();
        await page.waitForLoadState('domcontentloaded');

        const createNew = await scrollMenuUntil(page, 'a[aria-label*="Create New"]', 'Create New');
        await createNew.scrollIntoViewIfNeeded();
        await expect(createNew).toBeVisible({ timeout: 5000 });
        await createNew.click();
        await page.waitForLoadState('domcontentloaded');
        console.log('✓ Clicked Create New');
      });

      // ── 3. Select Normal change model ──
      await test.step('3. Select Normal change model', async () => {
        await page.waitForURL(/sn_chg_model_ui_landing\.do/, { timeout: T_NAV });

        const modelIframe = page.frameLocator('iframe').first();
        const normalBtn   = modelIframe.locator('text=/Normal/i').first();
        await normalBtn.waitFor({ state: 'visible', timeout: T_NAV });
        await normalBtn.click();
        console.log('✓ Selected Normal change model');
      });

      // ── 4. Verify CR form loaded ──
      await test.step('4. Verify Change Request form', async () => {
        await page.waitForURL(/change_request\.do.*chg_model.*type.*normal/i, { timeout: 60_000 });
        console.log('✓ CR form loaded');
      });

      // ── 5. Fill and submit CR form ──
      await test.step('5. Fill and submit Change Request form', async () => {
        // Wait for CR number field to be visible — the last field ServiceNow
        // populates during form init, confirming the form is fully interactive.
        await page.waitForURL(/change_request\.do.*chg_model.*type.*normal/i, { timeout: T_NAV });
        const iframe = page.frameLocator('#gsft_main');
        await iframe.locator('input[id="change_request.number"]').waitFor({ state: 'visible', timeout: T_ELEMENT });
        await fillAndSubmitCR(page, iframe, testData);
      });

      // ── 6. Wait for redirect back to landing page ──
      await test.step('6. Wait for post-submit redirect', async () => {
        // ServiceNow may redirect to sn_chg_model_ui_landing.do OR
        // change_request_list.do depending on environment/version.
        await page.waitForURL(
          /sn_chg_model_ui_landing\.do|change_request_list\.do|change_request\.do/i,
          { timeout: T_NAV },
        );
        await page.waitForLoadState('domcontentloaded');
        console.log(`✓ Post-submit redirect complete (${page.url().split('/').pop()?.split('?')[0]})`);
      });

      // ── 7. Navigate to the newly created CR ──
      await test.step('7. Navigate to created Change Request', async () => {
        const crNumber = testData.changeRequestNumber;
        if (!crNumber) throw new Error('CR number not captured — cannot navigate to CR');

        const sysId = getSysIdForCr(crNumber);
        if (sysId) {
          console.log(`  → Fast path: navigating by sys_id (${sysId})`);
          await navigateBySysId(page, sysId);
        } else {
          console.log(`  → Slow path: searching list (no sys_id for ${crNumber})`);
          await navigateByListSearch(page, crNumber);
        }

        await waitForCRDetail(page);

        // If sys_id was not captured at submit time, extract it from the URL now
        // so subsequent CTask redirects can use the fast path.
        if (!getSysIdForCr(crNumber)) {
          const urlSysId = decodeURIComponent(page.url()).match(/sys_id=([a-f0-9]{32})/i)?.[1];
          if (urlSysId) {
            await ChangeRequestStorage.save(testData.configName, crNumber, testData.releaseVersion, urlSysId);
            console.log(`✓ sys_id captured from CR URL: ${urlSysId}`);
          }
        }

        console.log(`✓ Opened CR ${crNumber} — ready for CTask creation`);
      });

      // ── 9. Create CTasks ── (step number unchanged, was 9 before steps 7+8 merge)
      await test.step('8. Create Change Tasks', async () => {
        const ctaskConfigs = testData.ctaskConfigs ?? [];
        if (ctaskConfigs.length === 0) {
          console.log('ℹ No CTasks configured for this environment — skipping');
          return;
        }
        console.log(`Creating ${ctaskConfigs.length} CTasks…`);

        for (let i = 0; i < ctaskConfigs.length; i++) {
          const ctask = ctaskConfigs[i];
          console.log(`\n[CTask ${i + 1}/${ctaskConfigs.length}] ${ctask.assignmentGroup}`);

          let iframe = await getIframe(page);
          await clickElement(page, iframe.locator('span[role="tab"]:has-text("Change Tasks")'), 'Change Tasks tab');

          // Wait for New button — correct signal that tab panel finished rendering.
          iframe = await getIframe(page);
          await iframe.locator('button').filter({ hasText: /^New$/ }).first().waitFor({ state: 'visible', timeout: T_ELEMENT });
          await page.waitForTimeout(T_TAB_SETTLE);  // tab panel JS wiring

          iframe = await getIframe(page);
          await clickElement(page, iframe.locator('button').filter({ hasText: /^New$/ }).first(), 'New CTask button');

          // Wait for the CTask form URL, then give ServiceNow JS time to wire fields.
          await page.waitForURL(/change_task\.do/, { timeout: T_NAV });
          await page.waitForTimeout(T_FORM_SETTLE);  // field init JS wiring

          iframe = await getIframe(page);
          await createCtask(page, iframe, ctask, testData.plannedStartDate, testData.plannedEndDate);

          await page.waitForLoadState('domcontentloaded');
          // After CTask submit ServiceNow may redirect to the CR list.
          // Navigate back to the CR explicitly so the next iteration starts
          // from a known-good URL.
          if (!/change_request\.do/i.test(page.url())) {
            const crNum = testData.changeRequestNumber!;
            const crSysId = getSysIdForCr(crNum);
            if (crSysId) {
              console.log(`  → CTask redirect went to list — fast path back via sys_id`);
              await navigateBySysId(page, crSysId);
            } else {
              console.log(`  → CTask redirect went to list — slow path back via list search`);
              await navigateByListSearch(page, crNum);
            }
          }
          await waitForCRDetail(page);
          await page.waitForTimeout(T_CR_SETTLE);
          console.log(`✓ CTask ${i + 1} (${ctask.assignmentGroup}) created`);
        }
        console.log(`\n✓ All ${ctaskConfigs.length} CTasks created`);
      });

      // ── 9. Submit for Assess ──────────────────────────────────────────────
      // Clicks Submit for Assess and waits for a FULL page load ('load') so
      // step 10's #RiskAssessmentV2 button is ready immediately.
      await test.step('9. Submit for Assess', async () => {
        await page.waitForLoadState('load', { timeout: T_NAV });
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
        await page.waitForLoadState('load', { timeout: T_NAV });
        console.log('✓ Submit for Assess complete — page fully loaded');
      });

      // ── 10. Risk Assessment ───────────────────────────────────────────────
      // Page is already on the CR detail after step 9. Full load ensures
      // #RiskAssessmentV2 is wired before createRiskAssessmentTask runs.
      await test.step('10. Create Risk Assessment', async () => {
        await page.waitForLoadState('load', { timeout: T_NAV });
        await waitForCRDetail(page);

        const iframe = await getIframe(page);
        await createRiskAssessmentTask(page, iframe, T_ELEMENT);

         await page.waitForLoadState('load', { timeout: T_NAV });
        const refreshedIframe = page.frameLocator('#gsft_main');
        await refreshedIframe
          .locator('input[id="change_request.number"]')
          .waitFor({ state: 'attached', timeout: T_ELEMENT });
        console.log('✓ CR form fully loaded after risk assessment');
      });

      
      // ── 11. Request Approval ─────────────────────────────────────────────────
        await test.step('11. Request Approval', async () => {
        await page.waitForLoadState('load', { timeout: T_NAV });

        // Use getIframe() to ensure the iframe body is attached and its JS
        // (including onclick handlers) is fully wired before interacting.
        const iframe = await getIframe(page);

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
            const g = globalThis as any;
            const el = g.document?.getElementById?.('state_model_request_cab_approval');
            if (el) g.state_model_request_cab_approval = el;
            const fn = g.moveToAuthorize;
            if (typeof fn !== 'function') throw new Error('moveToAuthorize not found on globalThis');
            fn();
          });
          console.log('✓ moveToAuthorize() called in frame context');
        }

        await page.reload({ waitUntil: 'load', timeout: T_NAV });
        console.log('✓ Page reloaded after state transition');

        // Both buttons gone — confirms the CR moved to Authorize state.
        const reloadedIframe = await getIframe(page);
        await expect(reloadedIframe.locator('button#state_model_request_cab_approval'))
          .toBeHidden({ timeout: T_ELEMENT });
        await expect(reloadedIframe.locator('#RiskAssessmentV2'))
          .toBeHidden({ timeout: T_ELEMENT });
        console.log('✓ Request Approval and Risk Assessment buttons gone — state transition confirmed');
        console.log(`✓ Request Approval complete`);
      });
    });
  }
});

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO RUN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * STEP 1 — SSO setup (run once; re-run when session expires)
 *   Option A: click "Run SSO Setup" in the launcher (http://localhost:3131/tdr)
 *   Option B: npx playwright test tests/sso_setup.ts --project=setup --headed
 *
 * ── Run all 3 configs in parallel (3 browsers open simultaneously) ────────────
 *   $env:RELEASE_VERSION="2026.07.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --headed --workers=3
 *
 * ── Run a single config (1 browser) ──────────────────────────────────────────
 *   $env:RELEASE_VERSION="2026.07.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --headed --workers=1 --grep "\[GENERATE_DUMP_PROD\]"
 *   $env:RELEASE_VERSION="2026.07.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --headed --workers=1 --grep "\[UAT\]"
 *   $env:RELEASE_VERSION="2026.07.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --headed --workers=1 --grep "\[QA\]"
 *
 * ── Run any two configs in parallel (2 browsers) ─────────────────────────────
 *   $env:RELEASE_VERSION="2026.07.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --headed --workers=2 --grep "\[UAT\]|\[QA\]"
 *   $env:RELEASE_VERSION="2026.07.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --headed --workers=2 --grep "\[GENERATE_DUMP_PROD\]|\[UAT\]"
 *
 * ── Dry run (verify config, list tests — no browser opened) ──────────────────
 *   $env:RELEASE_VERSION="2026.07.00"; npx playwright test servicenow_tdr/changeRequest.spec.ts --project=TDR --list
 *
 * ── View HTML report after a run ─────────────────────────────────────────────
 *   npx playwright show-report
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */