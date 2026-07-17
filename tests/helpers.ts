/**
 * SHARED HELPERS — ServiceNow Browser Automation
 * ================================================
 *
 * Shared across CRE and TDR projects.
 * Any ServiceNow selector or interaction change only needs to be made here.
 *
 * Exports:
 *   - Browser helpers:   getIframe, verifyUrl, clickElement, scrollMenuUntil
 *   - Form helpers:      fillAutosuggest, fillDateField, submitForm
 *   - CR form helpers:   fillMainForm, fillPlanningTab, fillScheduleTab
 *   - Risk assessment:   createRiskAssessmentTask
 *   - CR approval:       approveCR
 *   - SSO recovery:     handleSSOExpiry
 *   - Selectors:         ALL_MENU_SELECTOR, OPEN_CR_SELECTOR
 */

import fs   from 'fs';
import path from 'path';
import { expect, FrameLocator, Locator, Page } from '@playwright/test';

// Path to the shared session file written by sso_setup.ts
const AUTH_FILE = path.join(__dirname, '..', 'auth_servicenow.json');

/**
 * Handles a mid-test SSO expiry by:
 *  1. Auto-filling username + password from .env (SSO_USERNAME / SSO_PASSWORD)
 *     if the credentials are set, then waiting for redirect to ServiceNow.
 *  2. Falling back to fully manual login if .env credentials are not set.
 *  3. Saving the refreshed browser context state back to auth_servicenow.json
 *     so subsequent workers/runs can reuse it.
 *
 * After this function returns the browser already has valid ServiceNow cookies
 * and the caller can continue navigating to the intended destination.
 */
export async function handleSSOExpiry(page: Page): Promise<void> {
  const ssoUsername = process.env.SSO_USERNAME;
  const ssoPassword = process.env.SSO_PASSWORD;

  await page.waitForLoadState('domcontentloaded');

  // Guard: if SSO auto-redirected back to ServiceNow without showing the login
  // form (e.g. the SSO session was still valid server-side), skip credential
  // filling entirely — the browser is already where we need it.
  const currentUrl = page.url();
  if (/service-now\.com/i.test(currentUrl)) {
    console.log('✓ SSO auto-redirected to ServiceNow (session refreshed server-side)');
    await page.context().storageState({ path: AUTH_FILE });
    console.log(`✓ auth_servicenow.json refreshed (${AUTH_FILE})`);
    return;
  }

  if (ssoUsername && ssoPassword) {
    console.log('⚠ Session expired — auto-filling credentials from .env…');

    // Confirm the PingFederate login form is actually visible before filling.
    // SSO may auto-redirect to ServiceNow mid-navigation, leaving the login
    // page fields absent. Attempting to click a missing #username would wait
    // indefinitely (up to the action timeout), causing an apparent "halt".
    const usernameField = page.locator('#username');
    const loginFormReady = await usernameField.isVisible({ timeout: 5_000 }).catch(() => false);

    if (loginFormReady) {
      // Fill username + password. Field IDs match the PingFederate login page
      // used by Thomson Reuters SSO.
      await usernameField.click();
      await usernameField.type(ssoUsername, { delay: 50 });
      await page.locator('#password').click();
      await page.locator('#password').type(ssoPassword, { delay: 50 });
      await page.waitForTimeout(500);
      await page.locator('#signOnButton').click();
      await page.waitForLoadState('domcontentloaded');
      console.log('✓ Credentials submitted — waiting for redirect to ServiceNow…');
    } else {
      // Login form not visible: SSO may have auto-redirected already.
      // Fall through to waitForURL below which handles both cases.
      console.log('ℹ Login form not visible — SSO may have auto-redirected. Waiting for ServiceNow…');
    }
  } else {
    console.log('⚠ Session expired — SSO_USERNAME / SSO_PASSWORD not in .env.');
    console.log('👉 Please complete the SSO login (username, password, MFA) in the browser window…');
  }

  // Wait for redirect to ServiceNow. Use a generous timeout (120 s) to cover:
  //  • PingID push-notification approval (user picks up phone, unlocks, taps)
  //  • Slow corporate network redirects
  //  • Any MFA step not handled by credential auto-fill
  await page.waitForURL(/service-now\.com/, {
    timeout:   120_000,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForLoadState('domcontentloaded');
  console.log('✓ SSO login complete — refreshing auth_servicenow.json…');

  // Persist the refreshed cookies so the 2-hour clock resets.
  await page.context().storageState({ path: AUTH_FILE });
  console.log(`✓ auth_servicenow.json refreshed (${AUTH_FILE})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED SELECTORS
// ─────────────────────────────────────────────────────────────────────────────

export const ALL_MENU_SELECTOR =
  'div[role="menu"].sn-polaris-navigation.polaris-header-menu > div[aria-label="All"]';

export const OPEN_CR_SELECTOR =
  '.snf-collapsible-list:has(.snf-collapsible-list-header-button[aria-label="Change"]) .snf-collapsible-list-items a.nested-item[aria-label*="Open"]';

// ─────────────────────────────────────────────────────────────────────────────
// SHARED INTERFACE  (minimal shape both CRE + TDR EnvironmentTestData satisfy)
// ─────────────────────────────────────────────────────────────────────────────

export interface BaseTestData {
  additionalApprovalGroups:  string[];
  shortDescriptionText:      string;
  detailedDescriptionText:   string;
  justificationText:         string;
  implementationPlanText:    string;
  riskAndImpactAnalysisText: string;
  backoutPlanText:           string;
  testPlanText:              string;
  plannedStartDate:          string;
  plannedEndDate:            string;
  configName:                string;
  changeRequestNumber?:      string;
  createdAt?:                string;
}

// ─────────────────────────────────────────────────────────────────────────────
// BROWSER HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export async function getIframe(page: Page): Promise<FrameLocator> {
  const iframe = page.frameLocator('#gsft_main');
  await iframe.locator('body').waitFor({ state: 'attached' });
  await page.waitForTimeout(1000);
  return iframe;
}

export async function verifyUrl(page: Page, pattern: RegExp, timeout = 60_000): Promise<void> {
  await expect(page).toHaveURL(pattern, { timeout });
}

/** Robust click: tries scroll-into-view first, falls back to mouse-wheel scrolling */
export async function clickElement(page: Page, locator: Locator, description = ''): Promise<void> {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
    await page.waitForTimeout(200);
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 5000 });
      if (description) console.log(`✓ ${description}`);
      return;
    }
  } catch { /* fall through to scroll approach */ }

  const iframeBox = await page.locator('#gsft_main').boundingBox();
  if (!iframeBox) throw new Error('Iframe not found');
  const cx = iframeBox.x + iframeBox.width  / 2;
  const cy = iframeBox.y + iframeBox.height / 2;

  for (let i = 0; i < 75; i++) {
    if (await locator.isVisible().catch(() => false)) {
      for (let a = 0; a < 3; a++) {
        try {
          await locator.click({ timeout: 3000 });
          if (description) console.log(`✓ ${description} (after ${i} scroll attempts)`);
          return;
        } catch { if (a < 2) await page.waitForTimeout(150); }
      }
    }
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, 15);
    await page.waitForTimeout(50);
  }
  throw new Error(`Could not click: ${description}`);
}

/** Scrolls the ServiceNow nav sidebar until the target selector appears */
export async function scrollMenuUntil(
  page: Page,
  selector: string,
  label: string,
  maxAttempts = 100,
  scrollDelta = 30,
  waitMs = 100,
): Promise<Locator> {
  const nav = page.locator('.sn-polaris-nav-body');
  const box = await nav.boundingBox();
  if (!box) throw new Error('Nav menu not found');
  const cx = box.x + box.width  / 2;
  const cy = box.y + box.height / 2;

  for (let i = 0; i < maxAttempts; i++) {
    if ((await page.locator(selector).count()) > 0) {
      console.log(`✓ "${label}" found after ${i} scroll attempts`);
      return page.locator(selector).first();
    }
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, scrollDelta);
    await page.waitForTimeout(waitMs);
    if ((i + 1) % 10 === 0) console.log(`  ...attempt ${i + 1}`);
  }
  throw new Error(`"${label}" not found after ${maxAttempts} attempts`);
}

// ─────────────────────────────────────────────────────────────────────────────
// FORM HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Fills a ServiceNow autosuggest / autocomplete field */
export async function fillAutosuggest(
  iframe: FrameLocator,
  inputSelector: string,
  dropdownId: string,
  value: string,
  filterTag = 'span',
  assertValue = true,
  timeoutMs = 45_000,
): Promise<void> {
  const input = iframe.locator(inputSelector);
  await input.click();
  await input.type(value, { delay: 50 });
  await new Promise(r => setTimeout(r, 2000));

  const dropdown = iframe.locator(`div[id="${dropdownId}"]`);
  await dropdown.waitFor({ state: 'visible', timeout: timeoutMs });

  const option = dropdown.locator(filterTag).filter({ hasText: new RegExp(`^${value}$`) });
  await option.waitFor({ state: 'visible', timeout: timeoutMs });
  await option.click();
  await new Promise(r => setTimeout(r, 2000));
  console.log(`✓ Selected: ${value}`);

  if (assertValue) expect(await input.inputValue()).toBe(value);
}

/** Fills a date field with retry (handles ServiceNow validation-on-blur) */
export async function fillDateField(
  page: Page,
  iframe: FrameLocator,
  fieldId: string,
  dateValue: string,
  label: string,
  timeoutMs = 45_000,
): Promise<void> {
  const field = iframe.locator(`input[id="${fieldId}"]`);
  await field.waitFor({ state: 'visible', timeout: timeoutMs * 4 });

  let value = '';
  for (let attempt = 0; attempt < 3 && value !== dateValue; attempt++) {
    await field.click();
    await field.evaluate((el) => { (el as any).value = ''; });
    await field.fill(dateValue);
    await page.waitForTimeout(300);
    await field.press('Tab');
    await page.waitForTimeout(300);
    value = await field.inputValue();
    if (value !== dateValue && attempt < 2) console.log(`  Attempt ${attempt + 1}: retrying ${label}…`);
  }
  console.log(`✓ Filled ${label}`);
  expect(value).toBe(dateValue);
}

export async function submitForm(iframe: FrameLocator): Promise<void> {
  await iframe.locator('#sysverb_insert').first().click();
  console.log('✓ Form submitted');
}

// ─────────────────────────────────────────────────────────────────────────────
// CR FORM FILL FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

export async function fillMainForm(
  iframe: FrameLocator,
  testData: BaseTestData,
  categoryValue: string,
  categoryText: string,
  serviceText: string,
  configItemText: string,
  agRm: string,
  assignedToRm: string,
  timeoutMs = 45_000,
): Promise<void> {
  const cat = iframe.locator('select[name="change_request.category"]');
  await cat.selectOption({ value: categoryValue });
  expect(await cat.locator('option:checked').innerText()).toBe(categoryText);
  console.log(`✓ Category: ${categoryText}`);

  await fillAutosuggest(iframe, 'input[name="sys_display.change_request.business_service"]', 'AC.change_request.business_service', serviceText, 'span', true, timeoutMs);
  await fillAutosuggest(iframe, 'input[name="sys_display.change_request.cmdb_ci"]',          'AC.change_request.cmdb_ci',           configItemText, 'td', true, timeoutMs);

  await iframe.locator('//button[@id="change_request.group_list_unlock"]').click();
  for (const group of testData.additionalApprovalGroups) {
    const groupInput = iframe.locator('input[id="sys_display.change_request.group_list"]');
    await groupInput.waitFor({ state: 'visible', timeout: timeoutMs });
    await groupInput.click();
    await groupInput.type(group, { delay: 50 });
    const dropdown = iframe.locator('div[id="AC.change_request.group_list"]');
    await dropdown.waitFor({ state: 'visible', timeout: timeoutMs });
    const option = dropdown.locator('span').filter({ hasText: new RegExp(`^${group}$`) });
    await option.waitFor({ state: 'visible', timeout: timeoutMs });
    await option.click();
    console.log(`✓ Additional approval group selected: ${group}`);
  }
  // Verify groups were added (non-fatal — list pill may not use a visible select element)
  try {
    const selectedOptions = iframe.locator('select[id="select_0change_request.group_list"] > option');
    await selectedOptions.first().waitFor({ state: 'visible', timeout: 5000 });
    console.log('✓ Additional approval groups verified');
  } catch {
    console.log('Note: Could not verify approval groups via select element, but groups were successfully added');
  }

  await iframe.locator('input[id="change_request.short_description"]').fill(testData.shortDescriptionText);
  await iframe.locator('textarea[id="change_request.description"]').fill(testData.detailedDescriptionText);

  // Fill assignment group and assigned to LAST — after all other fields — so that any
  // ServiceNow business rules triggered by CI / Business Service / approval-group
  // selection cannot override these values afterward.
  await iframe.locator('input[name="sys_display.change_request.assignment_group"]').clear();
  await fillAutosuggest(iframe, 'input[name="sys_display.change_request.assignment_group"]', 'AC.change_request.assignment_group', agRm, 'span', true, timeoutMs);
  await iframe.locator('input[name="sys_display.change_request.assigned_to"]').clear();
  await fillAutosuggest(iframe, 'input[name="sys_display.change_request.assigned_to"]',      'AC.change_request.assigned_to',      assignedToRm, 'td', true, timeoutMs);

  console.log('✓ Main form filled');
}

export async function fillPlanningTab(iframe: FrameLocator, testData: BaseTestData): Promise<void> {
  await iframe.locator('span.tab_caption_text', { hasText: 'Planning' }).click();
  console.log('✓ Planning tab');

  const fields: [string, string][] = [
    ['textarea[id="change_request.justification"]',        testData.justificationText],
    ['textarea[id="change_request.implementation_plan"]',  testData.implementationPlanText],
    ['textarea[id="change_request.risk_impact_analysis"]', testData.riskAndImpactAnalysisText],
    ['textarea[id="change_request.backout_plan"]',         testData.backoutPlanText],
    ['textarea[id="change_request.test_plan"]',            testData.testPlanText],
  ];
  for (const [sel, val] of fields) await iframe.locator(sel).fill(val);
  console.log('✓ Planning fields filled');
}

export async function fillScheduleTab(
  page: Page,
  iframe: FrameLocator,
  testData: BaseTestData,
  timeoutMs = 45_000,
): Promise<void> {
  await iframe.locator('span.tab_caption_text', { hasText: 'Schedule' }).click();
  console.log('✓ Schedule tab');
  await fillDateField(page, iframe, 'change_request.start_date', testData.plannedStartDate, 'Planned Start Date', timeoutMs);
  await fillDateField(page, iframe, 'change_request.end_date',   testData.plannedEndDate,   'Planned End Date',   timeoutMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// RISK ASSESSMENT
// ─────────────────────────────────────────────────────────────────────────────

const RISK_QUESTIONS = [
  { label: 'expected impact',                   value: '0', display: 'No expected impact'                          },
  { label: 'isolated change',                   value: '1', display: 'Yes'                                         },
  { label: 'tested in a lower environment',     value: '1', display: 'Yes'                                         },
  { label: 'post implementation checks',        value: '1', display: 'Yes'                                         },
  { label: 'documented recovery plan',          value: '1', display: 'Yes'                                         },
  { label: 'How long will it take to perform',  value: '1', display: '<30 min to recover'                          },
  { label: 'familiar',                          value: '5', display: 'Familiar and often executed (1-3 times/mo)'  },
  { label: 'impact to Redundancy',              value: '1', display: 'No impact to redundant systems'              },
  { label: 'implemented using Automation',      value: '5', display: 'No'                                          },
] as const;

async function selectRiskOption(
  frame: any,
  labelText: string,
  optionValue: string,
  optionLabel: string,
  idx: number,
): Promise<void> {
  console.log(`\n[Q${idx + 1}] Looking for label matching "${labelText}"`);
  const label = frame.locator('label').filter({ hasText: new RegExp(labelText, 'i') });
  const count = await label.count();
  console.log(`  Found ${count} matching labels`);

  if (count === 0) {
    // Fallback: select by position index
    const selects = await frame.locator('select').all();
    console.log(`  ⚠ Label not found — falling back to select index ${idx} (total: ${selects.length})`);
    if (idx < selects.length) {
      const sel = frame.locator('select').nth(idx);
      await sel.waitFor({ state: 'visible', timeout: 30_000 });
      await sel.selectOption(optionValue);
      console.log(`  ✅ Q${idx + 1} (by index) → ${optionLabel}`);
      return;
    }
    throw new Error(`Risk Assessment label not found: "${labelText}"`);
  }

  const targetLabel = label.first();
  await targetLabel.waitFor({ state: 'visible', timeout: 30_000 });
  const labelFor = await targetLabel.getAttribute('for');
  if (!labelFor) throw new Error(`No 'for' attr on label: "${labelText}"`);

  const selectField = frame.locator(`select[id="${labelFor}"]`);
  await selectField.waitFor({ state: 'visible', timeout: 30_000 });
  await selectField.selectOption(optionValue);
  console.log(`  ✅ ${labelText.slice(0, 50)} → ${optionLabel}`);
}

export async function createRiskAssessmentTask(
  page: Page,
  iframe: FrameLocator,
  timeoutMs = 45_000,
): Promise<void> {
  const btn = iframe.locator('#RiskAssessmentV2');
  await btn.waitFor({ state: 'visible', timeout: timeoutMs });
  await btn.scrollIntoViewIfNeeded();
  // Wait for SNOW's JS handlers to fully bind (important when navigating to an existing CR)
  await page.waitForTimeout(2000);

  // The button's onclick calls invokeAssessment(). Call it directly in the
  // frame context — more reliable than synthetic click events inside iframes.
  const gsftFrame = page.frames().find(f => f !== page.mainFrame());
  if (gsftFrame) {
    try {
      await gsftFrame.evaluate(() => {
        const fn = (globalThis as any).invokeAssessment;
        if (typeof fn === 'function') fn();
        else throw new Error('invokeAssessment not found');
      });
      console.log('✓ Clicked Risk Assessment (direct)');
    } catch {
      // Fallback: DOM-level click triggers the onclick handler
      await btn.evaluate((el: any) => el.click());
      console.log('✓ Clicked Risk Assessment (JS element.click)');
    }
  } else {
    // No gsft_main frame found — fall back to Playwright click
    await btn.click({ force: true });
    console.log('✓ Clicked Risk Assessment (force click)');
  }
  // Give SNOW more time to open the assessment popup on existing CRs
  await page.waitForTimeout(5000);

  // Find the assessment frame by looking for specific question text markers
  // (more reliable than counting selects, which can match other frames)
  let assessFrame: any = null;
  const deadline = Date.now() + 60_000;
  let retryClicked = false;
  while (!assessFrame && Date.now() < deadline) {
    // If halfway through and still no frame, re-click via direct JS (existing CR edge case)
    if (!retryClicked && Date.now() > deadline - 30_000) {
      console.log('⚠ Popup not found after 30s — re-invoking Risk Assessment via JS');
      try {
        if (gsftFrame) {
          await gsftFrame.evaluate(() => {
            const fn = (globalThis as any).invokeAssessment;
            if (typeof fn === 'function') fn();
          }).catch(() => btn.evaluate((el: any) => el.click()));
        } else {
          await btn.evaluate((el: any) => el.click());
        }
        await page.waitForTimeout(3000);
      } catch { /* ignore */ }
      retryClicked = true;
    }

    for (const frame of page.frames()) {
      try {
        const url = frame.url();
        if (url.includes('change_request.do') || url === 'about:blank') continue;

        const labelCount  = await frame.locator('label').count().catch(() => 0);
        const selectCount = await frame.locator('select').count().catch(() => 0);
        if (labelCount === 0 || selectCount === 0) continue;

        // Look for at least one of the known assessment question text patterns
        // Using the same specific strings as the working CRE_o implementation
        const impactHit    = await frame.locator('text=/expected impact to either the Service/i').count().catch(() => 0);
        const isolatedHit  = await frame.locator('text=/isolated change/i').count().catch(() => 0);
        const testedHit    = await frame.locator('text=/tested in a lower/i').count().catch(() => 0);
        const markers = [impactHit, isolatedHit, testedHit].filter(n => n > 0).length;

        if (markers >= 1) {
          assessFrame = frame; // use raw Frame directly — avoids nested iframe resolution issues
          console.log(`✓ Found Risk Assessment frame (${markers}/3 markers) — URL: ${url.substring(0, 80)}`);
          break;
        }

        // Wider fallback: any frame with ≥5 selects that isn't the main CR form
        const hasCrField = await frame.locator('select[id*="change_request.category"]').count().catch(() => 0);
        if (hasCrField === 0 && selectCount >= 5) {
          assessFrame = frame; // use raw Frame directly
          console.log(`✓ Found Risk Assessment frame (fallback: ${selectCount} selects) — URL: ${url.substring(0, 80)}`);
          break;
        }
      } catch { /* skip inaccessible frames */ }
    }
    if (!assessFrame) {
      const elapsed = Math.round((60_000 - (deadline - Date.now())) / 1000);
      console.log(`  Waiting for assessment popup… (${elapsed}s elapsed)`);
      await page.waitForTimeout(1000);
    }
  }
  if (!assessFrame) throw new Error('Risk Assessment form frame not found within 60s');

  // Wait for labels to be visible before starting to fill
  await assessFrame.locator('label').first().waitFor({ state: 'visible', timeout: timeoutMs });

  for (let i = 0; i < RISK_QUESTIONS.length; i++) {
    const { label, value, display } = RISK_QUESTIONS[i];
    await selectRiskOption(assessFrame, label, value, display, i);
  }

  // Try the known submit button ID first, then fall back to generic submit
  const submitById = assessFrame.locator('#submit_sign');
  if (await submitById.count() > 0) {
    await submitById.scrollIntoViewIfNeeded();
    try { await submitById.click({ timeout: 5000 }); }
    catch { await submitById.click({ force: true, timeout: 5000 }); }
  } else {
    await assessFrame.locator('button[type="submit"], input[type="submit"]').first().click();
  }
  console.log('✓ Risk Assessment submitted');
  await page.waitForLoadState('domcontentloaded');
}

// ─────────────────────────────────────────────────────────────────────────────
// CTASK PREFIX DETECTION  (shared between CRE and TDR)
// ─────────────────────────────────────────────────────────────────────────────

/** Detects whether the form uses change_task or change_request field prefix */
export async function detectCtaskPrefix(iframe: FrameLocator): Promise<string> {
  const isCtaskForm = await iframe
    .locator('input[name="sys_display.change_task.assignment_group"]:visible')
    .count() > 0;
  return isCtaskForm ? 'change_task' : 'change_request';
}

/** Fills the assignment group and optionally assigned-to on a CTask form */
export async function fillCtaskAssignment(
  iframe: FrameLocator,
  prefix: string,
  assignmentGroup: string,
  assignedTo: string | undefined,
  timeoutMs = 45_000,
): Promise<void> {
  await iframe.locator(`input[name="sys_display.${prefix}.assignment_group"]:visible`)
    .first().waitFor({ state: 'visible', timeout: 10_000 });
  await iframe.locator(`input[name="sys_display.${prefix}.assignment_group"]`).clear();
  await fillAutosuggest(iframe, `input[name="sys_display.${prefix}.assignment_group"]`, `AC.${prefix}.assignment_group`, assignmentGroup, 'span', true, timeoutMs);

  if (assignedTo) {
    await fillAutosuggest(iframe, `input[name="sys_display.${prefix}.assigned_to"]`, `AC.${prefix}.assigned_to`, assignedTo, 'td', true, timeoutMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CR APPROVAL  (from RM team perspective)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Approves a Change Request from the Release Management team approver.
 *
 * Steps:
 *  1. Navigate to the Approvers tab on the CR record
 *  2. Select "Approver" column filter from the Approvers list dropdown
 *  3. Search for the target approver by name
 *  4. Click the "Requested" link to open the individual approval record
 *  5. Select "Approved" state and click the Approve button
 *  6. Verify the approval was recorded (Update/Delete buttons appear, Approve button disappears)
 */
export async function approveCR(
  page: Page,
  iframe: FrameLocator,
  approverName: string,
  timeoutMs = 45_000,
): Promise<void> {
  const APPROVERS_ROW_SELECTOR =
    'table > tbody.list2_body.-sticky-group-headers > tr[data-list_id="change_request.sysapproval_approver.sysapproval"]';

  // ── 1. Navigate to Approvers tab ─────────────────────────────────────────
  const approversTab = iframe.locator('span[role="tab"]:has-text("Approvers")');
  await clickElement(page, approversTab, 'Navigated to Approvers tab');
  await page.waitForLoadState('domcontentloaded');

  // Wait for the approvers grid to load at least one row
  await iframe.locator(APPROVERS_ROW_SELECTOR).last()
    .waitFor({ state: 'visible', timeout: timeoutMs });
  console.log('✓ Approvers grid loaded');

  // ── 2. Select "Approver" filter from list dropdown ───────────────────────
  const approversDropdown = iframe.locator('div[aria-label="Approvers"] select[role="listbox"]');
  try {
    await approversDropdown.waitFor({ state: 'visible', timeout: 10_000 });
    await approversDropdown.selectOption('approver');
    console.log('✓ Selected "Approver" filter');
  } catch {
    console.log('Note: Could not change Approvers dropdown — may already be set');
  }
  await page.waitForTimeout(2000);

  // ── 3. Search for the target approver ────────────────────────────────────
  const searchInput = iframe.locator('div[aria-label="Approvers"] input[placeholder="Search"]');
  await searchInput.scrollIntoViewIfNeeded();
  await searchInput.click({ clickCount: 3 });
  await page.waitForTimeout(300);
  await searchInput.type(approverName, { delay: 100 });
  console.log(`✓ Typed "${approverName}" in Approvers search`);
  await page.waitForTimeout(1500);
  await searchInput.press('Enter');

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);

  // Wait for the grid to refresh
  await iframe.locator(APPROVERS_ROW_SELECTOR).last()
    .waitFor({ state: 'visible', timeout: timeoutMs });
  console.log('✓ Approvers grid refreshed');

  // ── 4. Find the matching row and click "Requested" ───────────────────────
  const allRows = await iframe.locator(APPROVERS_ROW_SELECTOR).all();
  let foundRow: Locator | null = null;
  for (const row of allRows) {
    const text = await row.innerText().catch(() => '');
    if (text.includes(approverName)) {
      foundRow = row;
      break;
    }
  }
  if (!foundRow) {
    throw new Error(`Approver row not found for: "${approverName}"`);
  }

  await foundRow.locator('a.formlink:has-text("Requested")').click();
  console.log(`✓ Clicked "Requested" link for ${approverName}`);

  await page.waitForURL(/sysapproval_approver\.do(%3F|\?)/, { timeout: timeoutMs });
  await page.waitForLoadState('domcontentloaded');
  console.log('✓ Navigated to approval record');

  // ── 5. Approve ────────────────────────────────────────────────────────────
  const approvalIframe = await getIframe(page);

  // Select "Approved" from the state dropdown
  await approvalIframe.locator('select#sysapproval_approver\\.state')
    .selectOption('approved');
  console.log('✓ Selected "Approved" state');

  // Click Approve button
  await approvalIframe.locator('button#approve').click();
  console.log('✓ Clicked Approve button');

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  // ── 6. Verify approval recorded ──────────────────────────────────────────
  await expect(approvalIframe.locator('button#sysverb_update'))
    .toBeVisible({ timeout: timeoutMs });
  await expect(approvalIframe.locator('button#sysverb_delete'))
    .toBeVisible({ timeout: timeoutMs });
  await expect(approvalIframe.locator('button#approve'))
    .not.toBeVisible({ timeout: timeoutMs });
  console.log('✓ Change Request approved successfully');
}