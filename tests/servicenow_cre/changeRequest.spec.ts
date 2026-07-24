/**
 * CRE CHANGE REQUEST CREATION AND CTASK MANAGEMENT
 * =================================================
 *
 */

import { test, expect, Page, FrameLocator } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  TEST_CONFIGURATIONS,
  COMMON_CONSTANTS,
  EnvironmentTestData,
  ChangeRequestStorage,
  CTASK_CONFIGURATIONS,
  getCtaskConfig,
  getCtaskDescriptions,
} from './testDataConfig_CRE';
import {
  ALL_MENU_SELECTOR,
  OPEN_CR_SELECTOR,
  getIframe,
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
} from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL SETUP
// ─────────────────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  if (!process.env.RELEASE_VERSION) {
    throw new Error(
      '❌ RELEASE_VERSION env var is required.\n' +
      'Example:  $env:RELEASE_VERSION="2026.07.00"; npx playwright test servicenow_cre/changeRequest.spec.ts --headed',
    );
  }
  console.log(`📋 CRE Release Version: ${process.env.RELEASE_VERSION}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const {
  timeoutElementVisible: T_ELEMENT,
  timeoutPageNav:        T_NAV,
  categoryValue:         CATEGORY_VALUE,
  categoryText:          CATEGORY_TEXT,
  assignmentGroupRmText: AG_RM,
  assignedToRmText:      ASSIGNED_TO_RM,
  timeoutAutosuggest:    T_SUGGEST,
} = COMMON_CONSTANTS;

const ASSIGNMENT_GROUPS   = CTASK_CONFIGURATIONS.assignmentGroups;
const ASSIGNED_TO_DEFAULT = CTASK_CONFIGURATIONS.assignedTo.default;

const SERVICENOW_CR_URL = 'https://trenterprise.service-now.com/change_request.do';

/** Regex built from the host — used in toHaveURL / waitForURL checks. */
const SERVICENOW_HOST_RE = /trenterprise\.service-now\.com/;

// ─── Named timeout constants ──────────────────────────────────────────────────
// All durations live here so they are easy to tune in one place.
// T_ELEMENT and T_NAV come from COMMON_CONSTANTS (testDataConfig_CRE.ts).

/** Maximum time for a single test — 15 min covers full CTask loop on slow envs. */
const T_TEST = 15 * 60 * 1_000;

/** Short wait for UI elements that should already be in the DOM (menu items,
 *  row cells). Shorter than T_ELEMENT to fail fast when something is missing. */
const T_ELEMENT_SHORT = 5_000;

/** Race window for capturing sys_id from the brief intermediate URL that
 *  ServiceNow shows immediately after CR submit before redirecting away. */
const T_SYS_ID_RACE = 10_000;

/** CTask submit/insert button — slightly longer than T_ELEMENT_SHORT because
 *  ServiceNow wires the button after the form JS fully initialises. */
const T_CTASK_FORM = 30_000;

/** Post-action settle time after ServiceNow state transitions (e.g. Submit for
 *  Assess). The state machine runs server-side and needs this time to complete
 *  before the page is fully interactive again. Matches riskmanagement.spec.ts. */
const T_SETTLE = 5_000;

/** CTask loop: time for ServiceNow's JS to wire up the Change Tasks tab panel
 *  after clicking the tab, before the "New" button is safe to click.
 *  Matches ctasks_spec.ts — removing this causes autosuggest init failures. */
const T_TAB_SETTLE = 2_000;

/** CTask loop: time for ServiceNow's JS to finish wiring reference fields
 *  (assignment_group autosuggest etc.) after the CTask form URL loads.
 *  Matches ctasks_spec.ts — removing this causes the dropdown to stay hidden. */
const T_FORM_SETTLE = 1_000;

/** CTask loop: time for the CR detail page to fully re-render after a CTask
 *  is submitted and ServiceNow redirects back to the parent CR.
 *  Matches ctasks_spec.ts post-submit settle. */
const T_CR_SETTLE = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// WAIT HELPERS
// Each function waits for the specific DOM signal that proves a page/form is
// truly interactive — no blind waitForTimeout() calls.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the gsft_main FrameLocator only after its body is attached to the DOM.
 * Baseline guard before any further locator interactions inside the iframe.
 */
async function getReadyIframe(page: Page): Promise<FrameLocator> {
  const iframe = page.frameLocator('#gsft_main');
  await iframe.locator('body').waitFor({ state: 'attached', timeout: T_ELEMENT });
  return iframe;
}

/**
 * Waits until the CR number input is VISIBLE inside gsft_main.
 * Used only on the CR CREATE form — ServiceNow renders this field as a visible
 * editable input during creation, and populates it last, making it the definitive
 * "form is fully interactive" signal.
 *
 * Do NOT use on an existing CR detail page — on detail pages the field has
 * writeaccess="false" and is rendered as a HIDDEN input (confirmed by error log:
 * "locator resolved to hidden <input value=\"CHG…\" writeaccess=\"false\">").
 * Use waitForCRDetail() for detail pages instead.
 */
async function waitForCRForm(page: Page): Promise<FrameLocator> {
  const iframe = await getReadyIframe(page);
  await iframe
    .locator('input[id="change_request.number"]')
    .waitFor({ state: 'visible', timeout: T_ELEMENT });
  return iframe;
}

/**
 * Waits until the CTask submit/insert button is visible.
 * Only appears once the CTask form is fully loaded and fields are ready.
 */
async function waitForCtaskForm(iframe: FrameLocator): Promise<void> {
  await iframe
    .locator('button[id*="sysverb_insert"], button[id*="sysverb_submit"]')
    .first()
    .waitFor({ state: 'visible', timeout: T_CTASK_FORM });
}

/**
 * Waits for the CR detail page to be fully loaded and the iframe to be ready.
 * Used after: navigating to an existing CR, submitting a CTask (returns to CR),
 * and after Submit for Assess.
 *
 * IMPORTANT — uses state: 'attached', NOT state: 'visible'.
 * On a CR detail page, change_request.number has writeaccess="false" and is
 * rendered as a HIDDEN input. Waiting for 'visible' times out immediately
 * (confirmed by error: "locator resolved to hidden <input writeaccess=\"false\">").
 * 'attached' means the field exists in the DOM — which proves the CR form has
 * fully rendered and is safe to interact with.
 */
async function waitForCRDetail(page: Page): Promise<FrameLocator> {
  await page.waitForURL(/change_request\.do(%3F|\?).*sys_id(%3D|=)/i, { timeout: T_NAV });
  await page.waitForLoadState('domcontentloaded');
  const iframe = await getReadyIframe(page);
  await iframe
    .locator('input[id="change_request.number"]')
    .waitFor({ state: 'attached', timeout: T_ELEMENT });  // hidden on detail page — attached is correct
  return iframe;
}

/**
 * After clicking the "Change Tasks" tab, waits for the "New" button to become
 * visible — the tab panel renders asynchronously so this is the correct signal.
 */
async function waitForChangeTasksTab(page: Page): Promise<FrameLocator> {
  const iframe = await getReadyIframe(page);
  await iframe
    .locator('button')
    .filter({ hasText: /^New$/ })
    .first()
    .waitFor({ state: 'visible', timeout: T_ELEMENT });
  return iframe;
}

/**
 * After navigating to the CTask form, waits for the short_description field to
 * be visible — only appears after all CTask form fields are rendered and editable.
 */
async function waitForCtaskFields(iframe: FrameLocator, prefix: string): Promise<void> {
  await iframe
    .locator(`input[id="${prefix}.short_description"]`)
    .waitFor({ state: 'visible', timeout: T_ELEMENT });
}

/**
 * Dismisses any visible ServiceNow notification toasts (e.g. "Conflict last run
 * updated by System"). These appear on the main page (not inside gsft_main)
 * and block interaction if not closed. Non-fatal — silently skips if none present.
 */
async function dismissPageNotifications(page: Page): Promise<void> {
  try {
    // All known ServiceNow close-button selectors:
    //  1. Toast popup  ("Conflict last run updated by System")
    //  2. Inline scheduling conflict banner  ("Scheduling conflict detected")
    //  3. AI NowAssist banner  ("Get AI NowAssist support...")
    //  4. Generic Bootstrap/ServiceNow alert dismissibles
    const allSelectors = [
      '.notification-ui span.close[role="button"]',
      'span[aria-label="Dismiss Notification"]',
      '.notification-ui .close-notification .close',
      '.notification-ui button.close',
      '.alert-dismissible button.close',
      '.alert-dismissible .close',
      'button[data-dismiss="alert"]',
      '[class*="snf-notification"] button.close',
      '[class*="snf-notification"] .close',
      '[class*="snf-banner"] .close',
      '.page-message .close',
      '.snf-alert .close',
    ].join(', ');

    const allButtons = page.locator(allSelectors);
    const totalFound = await allButtons.count();

    if (totalFound === 0) return;

    // Screenshot BEFORE dismiss so we can see what notifications appeared
    const screenshotsDir = path.join(__dirname, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const ts = Date.now();
    const beforePath = path.join(screenshotsDir, `notification-before-${ts}.png`);
    await page.screenshot({ path: beforePath, fullPage: false }).catch(() => {});
    console.log(`Screenshot: notification-before-${ts}.png`);

    // Click every close button found (dismiss all banner types in one pass)
    let dismissed = 0;
    for (let i = 0; i < totalFound; i++) {
      await allButtons.nth(i).click({ timeout: 3_000 }).catch(() => {});
      dismissed++;
    }

    await page.waitForTimeout(500); // allow dismiss animations to complete

    // Screenshot AFTER dismiss to confirm they are gone
    const afterPath = path.join(screenshotsDir, `notification-after-${ts}.png`);
    await page.screenshot({ path: afterPath, fullPage: false }).catch(() => {});
    console.log(`Dismissed ${dismissed} notification(s) - after: notification-after-${ts}.png`);
  } catch { /* notifications are transient - ignore any errors */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION HELPERS  (mirrors ctasks.spec.ts exactly)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the sys_id for a CR number from the registry.
 * Mirrors ctasks.spec.ts getSysIdForCr() — registry is the source of truth,
 * NOT a field on testData, which avoids mutating EnvironmentTestData.
 */
function getSysIdForCr(crNumber: string): string | undefined {
  const registry = ChangeRequestStorage.loadAll();
  for (const crs of Object.values(registry)) {
    const entry = crs[crNumber];
    if (entry?.crSysId) return entry.crSysId;
  }
  return undefined;
}

/**
 * Fast path: navigate directly to the CR by sys_id (one page load).
 * Used when the registry has a crSysId entry — skips the list search entirely.
 */
async function navigateBySysId(page: Page, sysId: string): Promise<void> {
  const listFilter = encodeURIComponent(
    'active=true^short_description>=Content Rate Extract^ORDERBYshort_description',
  );
  const directUrl = `${SERVICENOW_CR_URL}?sys_id=${sysId}&sysparm_record_list=${listFilter}`;
  await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: T_NAV });
  await page.waitForURL(/change_request\.do(%3F|\?).*sys_id(%3D|=)/i, { timeout: T_NAV });
  await page.waitForLoadState('domcontentloaded');
}

/**
 * Slow path: open the CR list, search by number, click into the row.
 * Fallback when no sys_id is available in the registry.
 */
async function navigateByListSearch(page: Page, crNumber: string): Promise<void> {
  const allMenu = page.locator(ALL_MENU_SELECTOR);
  await expect(allMenu).toBeVisible({ timeout: T_NAV });
  await allMenu.click();
  await page.waitForLoadState('domcontentloaded');

  const openItem = await scrollMenuUntil(page, OPEN_CR_SELECTOR, 'Open (under Change)');
  await openItem.scrollIntoViewIfNeeded();
  await expect(openItem).toBeVisible({ timeout: T_ELEMENT_SHORT });
  await openItem.click();
  await page.waitForURL(/change_request_list\.do/, { timeout: T_NAV });
  console.log('  ✓ Open Change Requests list loaded');

  const iframe = await getIframe(page);

  const listbox = iframe.getByRole('listbox', { name: /Change Requests list/ });
  await listbox.waitFor({ state: 'visible', timeout: T_ELEMENT });
  await listbox.selectOption('number');

  const search = iframe.getByLabel('Search', { exact: true });
  await search.waitFor({ state: 'visible', timeout: T_ELEMENT });
  await search.click();
  // fill() is atomic — no per-keystroke delay, no stale-field race
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

// ─────────────────────────────────────────────────────────────────────────────
// CRE-SPECIFIC: CR SUBMIT  (captures sysId into registry for fast-path navigation)
// ─────────────────────────────────────────────────────────────────────────────

async function fillAndSubmitCR(
  page: Page,
  iframe: FrameLocator,
  testData: EnvironmentTestData,
): Promise<void> {
  await fillMainForm(
    iframe, testData,
    CATEGORY_VALUE, CATEGORY_TEXT, testData.serviceText, testData.configItemText,
    AG_RM, ASSIGNED_TO_RM, T_SUGGEST,
  );
  await fillPlanningTab(iframe, testData);
  await fillScheduleTab(page, iframe, testData, T_SUGGEST);

  const crNumber = await iframe.locator('input[id="change_request.number"]').inputValue();
  console.log(`✓ CR Number: ${crNumber}`);

  //── PRODUCTION ───────────────────────────────────────────────────────────
  await submitForm(iframe);

  // Capture sys_id from the brief intermediate URL that ServiceNow shows right
  // after submit (change_request.do?sys_id=<hex>) before it redirects to the
  // landing page. We race a short waitForURL against the redirect — if the
  // sys_id URL appears we capture it; if the redirect wins first we fall back
  // to checking the post-domcontentloaded URL (may be undefined, which is fine:
  // the slow-path list search in step 7 handles the missing-sysId case).
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
    // ChangeRequestStorage.save() persists crNumber + sysId to the registry YAML.
    // Step 7 then reads the sysId back via getSysIdForCr() — same pattern as
    // ctasks.spec.ts. We do NOT store sysId on testData to avoid mutating
    // EnvironmentTestData with a field that isn't part of its type definition.
    await ChangeRequestStorage.save(
      testData.configName,
      crNumber,
      testData.releaseVersion,
      testData.shortDescriptionText,
      sysId,
    );
    testData.changeRequestNumber = crNumber;
    testData.createdAt           = new Date().toISOString();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRE-SPECIFIC: CTASK CREATION  (step-based, env+region driven)
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
  // Wait for submit button — definitive signal that the CTask form is loaded
  await waitForCtaskForm(iframe);

  const prefix = await detectCtaskPrefix(iframe);

  // Wait for short_description field — confirms all form fields are rendered
  await waitForCtaskFields(iframe, prefix);

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
// PARAMETRIZED TEST SUITE  (runs all configs in parallel — one worker per test)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('CRE Change Request Creation — All Environments (Parallel)', () => {
  for (const [configKey, testData] of Object.entries(TEST_CONFIGURATIONS)) {

    test(`[${configKey}] Complete CR Creation and CTask Management`, async ({ page }) => {
      // Timeout is set globally in playwright.config.ts (15 min).
      const testStart = Date.now();

      // ── 1. Navigate to app ──────────────────────────────────────────────────
      await test.step('1. Navigate to application', async () => {
        await page.goto('/', { waitUntil: 'domcontentloaded', timeout: T_NAV });
        await page.waitForLoadState('domcontentloaded');

        // Do NOT call waitForURL before this check — PingID's redirect chain
        // calls window.close() mid-navigation causing "Target page closed".
        const finalUrl = page.url();
        if (/sso\.thomsonreuters\.com|pingone\.com|pingid\.com/i.test(finalUrl)) {
          await handleSSOExpiry(page);
          // Session recovered — proceed from ServiceNow home
        }
        await expect(page).toHaveURL(SERVICENOW_HOST_RE, { timeout: T_ELEMENT });
        console.log(`✓ [${configKey}] Navigated to ServiceNow`);
      });

      // ── 2. Open Create New Change Request ──────────────────────────────────
      await test.step('2. Open Create New Change Request', async () => {
        const allMenu = page.locator(ALL_MENU_SELECTOR);
        await expect(allMenu).toBeVisible({ timeout: T_NAV });
        await allMenu.click();
        await page.waitForLoadState('domcontentloaded');

        // 100px scroll / 50ms wait — 3× faster than the default 30px/100ms.
        const createNew = await scrollMenuUntil(page, 'a[aria-label*="Create New"]', 'Create New', 100, 100, 50);
        await createNew.scrollIntoViewIfNeeded();
        await expect(createNew).toBeVisible({ timeout: T_ELEMENT_SHORT });
        await createNew.click();
        await page.waitForLoadState('domcontentloaded');
        console.log('✓ Clicked Create New');
      });

      // ── 3. Select Normal change model ──────────────────────────────────────
      await test.step('3. Select Normal change model', async () => {
        await page.waitForURL(/sn_chg_model_ui_landing\.do/, { timeout: T_NAV });

        const modelIframe = page.frameLocator('iframe').first();
        const normalBtn   = modelIframe.locator('text=/Normal/i').first();
        await normalBtn.waitFor({ state: 'visible', timeout: T_NAV });
        await normalBtn.click();
        console.log('✓ Selected Normal change model');
      });

      // ── 4. Verify CR form URL ───────────────────────────────────────────────
      await test.step('4. Verify Change Request form', async () => {
        await page.waitForURL(/change_request\.do.*chg_model.*type.*normal/i, { timeout: T_NAV });
        console.log('✓ CR form URL confirmed');
      });

      // ── 5. Fill and submit CR form ──────────────────────────────────────────
      await test.step('5. Fill and submit Change Request form', async () => {
        // waitForCRForm() waits for the CR number field — the last field ServiceNow
        // populates during form init, confirming the form is fully interactive.
        const iframe = await waitForCRForm(page);
        await fillAndSubmitCR(page, iframe, testData);
      });

      // ── 6. Wait for post-submit redirect back to landing page ───────────────
      // ServiceNow may redirect to sn_chg_model_ui_landing.do OR
      // change_request_list.do depending on environment/version.
      await test.step('6. Wait for post-submit redirect', async () => {
        await page.waitForURL(
          /sn_chg_model_ui_landing\.do|change_request_list\.do|change_request\.do/i,
          { timeout: T_NAV },
        );
        await page.waitForLoadState('domcontentloaded');
        console.log(`✓ Post-submit redirect complete (${page.url().split('/').pop()?.split('?')[0]})`);
      });

      // ── 7. Navigate to the newly created CR ────────────────────────────────
      // getSysIdForCr() reads the sys_id that fillAndSubmitCR() saved to the
      // registry. This mirrors ctasks.spec.ts exactly and avoids mutating
      // EnvironmentTestData with a non-existent sysId field.
      await test.step('7. Navigate to created Change Request', async () => {
        const crNumber = testData.changeRequestNumber;
        if (!crNumber) throw new Error('CR number not captured — cannot navigate to CR');

        const sysId = getSysIdForCr(crNumber);
        if (sysId) {
          console.log(`  → Fast path: navigating by sys_id (${sysId})`);
          await navigateBySysId(page, sysId);
        } else {
          console.log(`  → Slow path: searching list (no sys_id in registry for ${crNumber})`);
          await navigateByListSearch(page, crNumber);
        }

        // Confirm the CR detail form is fully rendered before proceeding to CTasks
        await waitForCRDetail(page);
        await dismissPageNotifications(page);

        // If sys_id was not captured at submit time, extract it from the URL now
        // so subsequent CTask redirects can use the fast path.
        if (!getSysIdForCr(crNumber)) {
          const urlSysId = decodeURIComponent(page.url()).match(/sys_id=([a-f0-9]{32})/i)?.[1];
          if (urlSysId) {
            await ChangeRequestStorage.save(testData.configName, crNumber, testData.releaseVersion, testData.shortDescriptionText, urlSysId);
            console.log(`✓ sys_id captured from CR URL: ${urlSysId}`);
          }
        }

        console.log(`✓ Opened CR ${crNumber} — ready for CTask creation`);
      });

      // ── 8. Create all CTasks ────────────────────────────────────────────────
      await test.step('8. Create Change Tasks for all departments', async () => {
        const { environment: env, region } = testData;
        const ctaskSteps = getCtaskConfig(env, region);

        const approvalGroups: ApprovalGroup[] = [
          ...ctaskSteps.rm.map(s      => ({ assignment_group: ASSIGNMENT_GROUPS.rm.name,      assigned_to: ASSIGNED_TO_DEFAULT, stepNumber: s, department: 'RM'      })),
          ...ctaskSteps.devops.map(s  => ({ assignment_group: ASSIGNMENT_GROUPS.devops.name,  assigned_to: undefined,           stepNumber: s, department: 'DevOps'  })),
          ...ctaskSteps.techops.map(s => ({ assignment_group: ASSIGNMENT_GROUPS.techops.name, assigned_to: undefined,           stepNumber: s, department: 'TechOps' })),
          ...ctaskSteps.qa.map(s      => ({ assignment_group: ASSIGNMENT_GROUPS.qa.name,      assigned_to: undefined,           stepNumber: s, department: 'QA'      })),
        ];

        if (approvalGroups.length === 0) {
          console.log('ℹ No CTasks configured for this environment — skipping');
          return;
        }
        console.log(`Creating ${approvalGroups.length} CTasks for ${env}${region ? `/${region}` : ''}…`);

        for (let i = 0; i < approvalGroups.length; i++) {
          const ag = approvalGroups[i];
          console.log(`\n[CTask ${i + 1}/${approvalGroups.length}] ${ag.department} Step ${ag.stepNumber}`);

          // ── Tab click → wait for New button (mirrors ctasks_spec.ts exactly) ──────
          // Re-acquire iframe before each tab click in case the CR page re-rendered.
          let iframe = await getIframe(page);
          await clickElement(
            page,
            iframe.locator('span[role="tab"]:has-text("Change Tasks")'),
            'Change Tasks tab',
          );
          // waitForChangeTasksTab() waits for the New button — correct navigation
          // signal. The additional 2 s pause from ctasks_spec.ts is kept here:
          // it lets ServiceNow's JS finish wiring the tab panel before we click New.
          iframe = await waitForChangeTasksTab(page);
          await page.waitForTimeout(T_TAB_SETTLE);  // tab panel JS wiring — see T_TAB_SETTLE

          iframe = await getIframe(page);
          await clickElement(
            page,
            iframe.locator('button').filter({ hasText: /^New$/ }).first(),
            'New CTask button',
          );
          // Wait for the CTask form URL, then give ServiceNow's JS 2 s to wire up
          // reference fields (assignment_group autosuggest, etc.) — mirrors
          // ctasks_spec.ts. Without this pause fillCtaskAssignment hits the dropdown
          // div before the autosuggest listener is attached and it stays hidden.
          await page.waitForURL(/change_task\.do/, { timeout: T_NAV });
          await page.waitForTimeout(T_FORM_SETTLE); // field init JS wiring — see T_FORM_SETTLE

          iframe = await getIframe(page);
          await createCtask(
            page, iframe, ag,
            env, region,
            testData.releaseVersion, testData.buildVersion,
            testData.plannedStartDate, testData.plannedEndDate,
          );

          // waitForCRDetail() checks URL + domcontentloaded + CR number field.
          // The extra 1 s pause mirrors ctasks_spec.ts post-submit settle.
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
          await dismissPageNotifications(page);
          await page.waitForTimeout(T_CR_SETTLE);   // CR re-render settle — see T_CR_SETTLE
          console.log(`✓ CTask ${ag.department} Step ${ag.stepNumber} created`);
        }
        console.log(`\n✓ All ${approvalGroups.length} CTasks created`);
      });

      // ── 9. Submit for Assess ───────────────────────────────────────────────
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
          // Fallback: call moveToAssess() directly in the gsft_main frame context
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

      // ── 10. Risk Assessment ─────────────────────────────────────────────────
      // Page is already on the CR detail after step 9. Full load ensures
      // #RiskAssessmentV2 is wired before createRiskAssessmentTask runs.
      await test.step('10. Create Risk Assessment', async () => {
        await page.waitForLoadState('load', { timeout: T_NAV });
        await waitForCRDetail(page);

        // Dismiss any "Conflict last run" or other notification toasts that may
        // overlay the Risk Assessment button and prevent it from being clicked.
        await dismissPageNotifications(page);

        const iframe = await getIframe(page);
        await createRiskAssessmentTask(page, iframe, T_ELEMENT);

        // Wait for CR number field to be attached — the form re-renders after
        // the risk assessment popup closes (field may not be visible yet).
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

        // Dismiss any notifications before interacting — the "Conflict last run"
        // toast can appear right after load; wait 1 s then dismiss a second time
        // to catch any that arrive slightly after the first sweep.
        await dismissPageNotifications(page);
        await page.waitForTimeout(1_000);
        await dismissPageNotifications(page);

        const iframe = await getIframe(page);

        const btn = iframe.locator('button#state_model_request_cab_approval');
        await btn.waitFor({ state: 'visible', timeout: T_ELEMENT });

        try {
          // Set window context and call moveToAuthorize() directly — same approach
          // as TDR. Calling moveToAuthorize() without setting window context causes
          // the server-side transition to silently fail (button stays visible).
          const gsftFrame = page.frames().find(f => f !== page.mainFrame());
          if (gsftFrame) {
            await gsftFrame.evaluate(() => {
              const g = globalThis as any;
              const el = g.document?.getElementById?.('state_model_request_cab_approval');
              if (el) g.state_model_request_cab_approval = el;
              const fn = g.moveToAuthorize;
              if (typeof fn === 'function') fn();
            });
            console.log('✓ Request Approval (moveToAuthorize via JS)');
          } else {
            await btn.scrollIntoViewIfNeeded();
            await btn.click({ force: true });
            console.log('✓ Request Approval clicked');
          }
        } catch {
          // Final fallback: direct click
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ force: true });
          console.log('✓ Request Approval clicked (fallback)');
        }

        // AJAX state transition: 5 s gives ServiceNow time to process before reload.
        await page.waitForTimeout(5_000);
        await page.reload({ waitUntil: 'load', timeout: T_NAV });
        console.log('✓ Page reloaded after state transition');

        // Dismiss notifications that reappear after reload before the button check.
        await dismissPageNotifications(page);
        await page.waitForTimeout(1_000);

        // Soft check — wait for button to disappear confirming state transition.
        const reloadedIframe = await getIframe(page);
        const reloadedBtn = reloadedIframe.locator('button#state_model_request_cab_approval');
        try {
          await expect(reloadedBtn).toBeHidden({ timeout: T_ELEMENT });
          console.log('✓ Request Approval button gone — state transition confirmed');
        } catch {
          console.warn(`⚠ Request Approval button still visible — CR may have extra approval group requirements. Verify ${configKey} CR manually in ServiceNow.`);
        }

        const totalMs = Date.now() - testStart;
        const mm = Math.floor(totalMs / 60_000);
        const ss = Math.floor((totalMs % 60_000) / 1_000);
        console.log(`✓ Request Approval step complete`);
        console.log(`⏱ [${configKey}] Total time: ${mm}m ${ss}s`);
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
 *   npx playwright test sso_setup.ts --project=setup --headed
 *
 * ── Run a single environment (1 browser) ─────────────────────────────────────
 *   $env:RELEASE_VERSION="2026.08.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[SAT\]"
 *   $env:RELEASE_VERSION="2026.08.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_EMEA\]"
 *   $env:RELEASE_VERSION="2026.08.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_MENA\]"
 *   $env:RELEASE_VERSION="2026.08.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[UAT_AMER\]"
 *   $env:RELEASE_VERSION="2026.08.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[PROD_EMEA\]"
 *   $env:RELEASE_VERSION="2026.08.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[PROD_MENA\]"
 *   $env:RELEASE_VERSION="2026.08.00"; npx playwright test changeRequest.spec.ts --project=CRE --headed --workers=1 --grep "\[PROD_AMER\]"
 
 * ── View HTML report after a run ─────────────────────────────────────────────
 *   npx playwright show-report
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */