#!/usr/bin/env node
/**
 * SERVICENOW API — CHANGE REQUEST + CTASK CREATION
 * =================================================
 *
 * Creates Change Requests and all CTasks via the ServiceNow Table REST API,
 * replacing browser automation for the CR creation step.
 *
 * Advantages over Playwright:
 *   • No browser required — runs headless, much faster (~3 s vs ~3 min per CR)
 *   • Parallelises all environments simultaneously with Promise.allSettled
 *   • No SSO session management / auth expiry concerns
 *   • Cleaner error messages from the API response body
 *
 * Prerequisites:
 *   A ServiceNow account that supports Basic Authentication on the REST API.
 *   Corporate SSO credentials typically do NOT work here — use a dedicated
 *   service account (local ServiceNow account), or ask your SNOW admin to
 *   enable OAuth / service-account basic auth for your instance.
 *
 * Arguments:
 *   RELEASE_VERSION  — first positional CLI argument, e.g. "2026.05.00"
 *
 * Authentication env vars (.env file or environment):
 *   SN_USERNAME   — ServiceNow username (basic-auth service account)
 *   SN_PASSWORD   — ServiceNow password
 *
 * Optional env var filter (runs all 7 environments if omitted):
 *   CR_CONFIG  — comma-separated config keys, e.g. "UAT_MENA,PROD_MENA"
 *
 * Run commands:
 *   All 7 environments:    npx ts-node tests/servicenow_cre/createCR_api.ts 2026.05.00
 *   Single env:            $env:CR_CONFIG="UAT_MENA"; npx ts-node tests/servicenow_cre/createCR_api.ts 2026.05.00
 *   Dry-run:               $env:DRY_RUN="true"; npx ts-node tests/servicenow_cre/createCR_api.ts 2026.05.00
 */

import path   from 'path';
import dotenv from 'dotenv';

// Load .env BEFORE importing testDataConfig_CRE — RELEASE_VERSION must be in process.env
// at module-load time (the config reads it synchronously during require()).
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

// ── Accept RELEASE_VERSION as CLI arg or env var ──────────────────────────────
// Priority: command-line argument  >  RELEASE_VERSION env var
// Usage:  npx ts-node tests/servicenow_cre/createCR_api.ts 2026.05.00
const cliReleaseVersion = process.argv[2];
if (cliReleaseVersion) {
  process.env.RELEASE_VERSION = cliReleaseVersion;
}

// ── Validate required env vars up-front ───────────────────────────────────────
if (!process.env.RELEASE_VERSION) {
  console.error(
    '❌ RELEASE_VERSION is required.\n' +
    'Pass it as a CLI argument: npx ts-node tests/servicenow_cre/createCR_api.ts 2026.05.00',
  );
  process.exit(1);
}

const SN_USERNAME    = process.env.SN_USERNAME    ?? '';
const SN_PASSWORD    = process.env.SN_PASSWORD    ?? '';
const SN_CLIENT_ID   = process.env.SN_CLIENT_ID   ?? '';
const SN_CLIENT_SECRET = process.env.SN_CLIENT_SECRET ?? '';
const DRY_RUN        = process.env.DRY_RUN === 'true';

if (!DRY_RUN && (!SN_USERNAME || !SN_PASSWORD)) {
  console.error(
    '❌ SN_USERNAME and SN_PASSWORD are required for API access.\n' +
    'Set them in your .env file or as environment variables.\n\n' +
    'To validate without calling the API, set DRY_RUN=true.',
  );
  process.exit(1);
}

// ── Import after env vars are set ─────────────────────────────────────────────
import {
  TEST_CONFIGURATIONS,
  ChangeRequestStorage,
  CTASK_CONFIGURATIONS,
  getCtaskConfig,
  getCtaskDescriptions,
  SN_BASE_URL,
  type ConfigKey,
  type CtaskRecord,
  type RiskAssessmentRecord,
} from './testDataConfig_CRE';

// ─────────────────────────────────────────────────────────────────────────────
// SERVICENOW API CLIENT — OAuth 2.0 (Resource Owner Password flow)
// Uses OAuth Bearer token when client_id/secret are provided; falls back to Basic Auth.
// OAuth typically grants broader API permissions than Basic Auth alone.
//
// SN_BASE_URL is imported from testDataConfig_CRE.ts rather than hardcoded
// here a second time. Two separate copies of this hostname are exactly what
// caused the original crUrl bug (this file called the `dev` instance while
// the UI-link generator pointed at a different, `prod`-named host) — one
// constant, in one place, imported everywhere it's needed.
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch an OAuth access token using Resource Owner Password Credentials grant. */
async function getOAuthToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type:    'password',
    client_id:     SN_CLIENT_ID,
    client_secret: SN_CLIENT_SECRET,
    username:      SN_USERNAME,
    password:      SN_PASSWORD,
  });
  const response = await fetch(`${SN_BASE_URL}/oauth_token.do`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OAuth token request failed (${response.status}): ${detail}`);
  }
  const json = await response.json() as { access_token?: string; error?: string };
  if (!json.access_token) throw new Error(`OAuth error: ${json.error ?? 'no access_token in response'}`);
  return json.access_token;
}

// Cached token — fetched once at startup and reused for all API calls.
let _accessToken: string | null = null;

async function getAuthHeader(): Promise<string> {
  if (SN_CLIENT_ID && SN_CLIENT_SECRET) {
    if (!_accessToken) {
      _accessToken = await getOAuthToken();
      console.log('  ✓ OAuth token acquired');
    }
    return `Bearer ${_accessToken}`;
  }
  // Fallback to Basic Auth if no OAuth credentials provided
  return `Basic ${Buffer.from(`${SN_USERNAME}:${SN_PASSWORD}`).toString('base64')}`;
}

/** Build request headers with the current auth token. */
async function buildHeaders(): Promise<Record<string, string>> {
  return {
    Authorization:  await getAuthHeader(),
    'Content-Type': 'application/json',
    Accept:         'application/json',
  };
}

/**
 * POST to a ServiceNow Table API endpoint.
 *
 * sysparm_input_display_value=true  — lets us pass human-readable display values
 *   for reference fields (assignment_group, assigned_to, cmdb_ci, etc.)
 *   instead of having to look up sys_ids first.
 *
 * Returns the `result` object from the API response.
 */
async function snowPost(table: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const url = `${SN_BASE_URL}/api/now/table/${table}?sysparm_input_display_value=true`;

  const response = await fetch(url, {
    method:  'POST',
    headers: await buildHeaders(),
    body:    JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch { /* ignore */ }
    throw new Error(`ServiceNow API ${response.status} on ${table}: ${detail}`);
  }

  const json = await response.json() as { result: Record<string, any> };
  return json.result;
}

/** PATCH a single record in a ServiceNow table by sys_id. */
async function snowPatch(table: string, sysId: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  // sysparm_input_display_value=true allows setting reference/choice fields by display name
  const url = `${SN_BASE_URL}/api/now/table/${table}/${sysId}?sysparm_input_display_value=true`;
  const response = await fetch(url, {
    method:  'PATCH',
    headers: await buildHeaders(),
    body:    JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch { /* ignore */ }
    throw new Error(`ServiceNow API PATCH ${response.status} on ${table}/${sysId}: ${detail}`);
  }
  const json = await response.json() as { result: Record<string, any> };
  return json.result;
}

/** GET records from a ServiceNow table with a sysparm_query filter. */
async function snowGet(table: string, query: string, fields?: string): Promise<Record<string, any>[]> {
  const params = new URLSearchParams({ sysparm_query: query, sysparm_limit: '50' });
  if (fields) params.set('sysparm_fields', fields);
  const url = `${SN_BASE_URL}/api/now/table/${table}?${params}`;
  const response = await fetch(url, { headers: await buildHeaders() });
  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch { /* ignore */ }
    throw new Error(`ServiceNow API GET ${response.status} on ${table}: ${detail}`);
  }
  const json = await response.json() as { result: Record<string, any>[] };
  return json.result;
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// RISK ASSESSMENT ANSWERS
// Same answers as the Playwright browser automation uses.
// Keys are partial question label matches (case-insensitive).
// ─────────────────────────────────────────────────────────────────────────────

const RISK_ANSWERS: Array<{ label: string; answer: string }> = [
  { label: 'expected impact',               answer: 'No expected impact' },
  { label: 'isolated change',               answer: 'Yes' },
  { label: 'tested in a lower environment', answer: 'Yes' },
  { label: 'post implementation checks',    answer: 'Yes' },
  { label: 'documented recovery plan',      answer: 'Yes' },
  { label: 'documented backout',            answer: 'Yes' },
  { label: 'backout method',                answer: 'Yes' },
  { label: 'how long will it take',         answer: '<30 min to recover' },
  { label: 'familiar',                      answer: 'Familiar and often executed (1-3 times/mo)' },
  { label: 'impact to redundancy',          answer: 'No impact to redundant systems' },
  { label: 'implemented using automation',  answer: 'No' },
];

// ─────────────────────────────────────────────────────────────────────────────
// DATE CONVERSION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts "DD-MM-YYYY HH:MM:SS" (YAML / Playwright format)
 *       to "YYYY-MM-DD HH:MM:SS" (ServiceNow REST API format).
 */
function toSnowDate(dateStr: string): string {
  const [datePart, timePart = '00:00:00'] = dateStr.split(' ');
  const [dd, mm, yyyy] = datePart.split('-');
  return `${yyyy}-${mm}-${dd} ${timePart}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — SUBMIT FOR ASSESS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Looks up the internal state value for a given display label on change_request.
 * e.g. 'Assess' → '-4' (or '2' depending on instance configuration).
 */
async function getStateValue(label: string): Promise<string> {
  const rows = await snowGet(
    'sys_choice',
    `name=change_request^element=state^labelLIKE${label}^language=en`,
    'value,label',
  );
  if (!rows.length) throw new Error(`State value for "${label}" not found in sys_choice`);
  return rows[0].value as string;
}

/**
 * Pulls the sys_audit trail for a change_request around a failed transition.
 * sys_audit records every field change ServiceNow's audit engine sees,
 * including reverts performed by Business Rules — so if state actually
 * flipped to the target value and then got reverted, there will be TWO
 * audit rows for `state` close together in time. If there's only one (or
 * none), the PATCH never took effect in the first place.
 *
 * Also pulls sys_created_by so we can see whether the write that "stuck"
 * came from the interactive UI session vs. the OAuth/API service account —
 * useful for telling apart a data-validation issue from a rule that
 * specifically distinguishes UI vs. API-originated updates.
 */
async function dumpStateAuditTrail(crSysId: string, crNumber: string): Promise<void> {
  console.log(`  🔍 Pulling sys_audit trail for ${crNumber} (state field)…`);
  try {
    const rows = await snowGet(
      'sys_audit',
      `tablename=change_request^documentkey=${crSysId}^fieldname=state^ORDERBYDESCsys_created_on`,
      'sys_created_on,sys_created_by,oldvalue,newvalue,reason',
    );
    if (!rows.length) {
      console.log('  🔍 No sys_audit rows found for the state field at all — the PATCH never registered as a change.');
      return;
    }
    console.log(`  🔍 Found ${rows.length} sys_audit row(s) for state, most recent first:`);
    for (const r of rows) {
      console.log(
        `     ${r.sys_created_on}  by ${r.sys_created_by}  ${r.oldvalue} → ${r.newvalue}` +
        (r.reason ? `  (reason: ${r.reason})` : ''),
      );
    }
  } catch (err: any) {
    console.warn(`  ⚠ Could not read sys_audit (may lack read ACL on sys_audit): ${err.message}`);
  }
}

/**
 * Re-reads change_request.state directly after a PATCH and confirms it
 * actually stuck.
 *
 * WHY THIS EXISTS: a ServiceNow "before update" Business Rule can silently
 * abort a state transition (setAbortAction(true)) — e.g. enforcing that Risk
 * Assessment must be completed before Assess → Authorize. When that happens,
 * the Table API still returns HTTP 200, just with the field unchanged or
 * reverted. snowPatch() only checks response.ok, so a silently-aborted
 * transition looks identical to a real success. This is exactly what
 * produced a CR that logged "✓ CR is now in Authorize" but was actually
 * still sitting in New in the UI.
 *
 * Always call this after a state-changing PATCH; treat a mismatch as fatal.
 * On mismatch, automatically pulls the sys_audit trail before throwing so
 * the failure comes with evidence, not just a state-number mismatch.
 */
async function verifyState(crSysId: string, crNumber: string, expectedState: string, stepLabel: string): Promise<void> {
  const rows = await snowGet('change_request', `sys_id=${crSysId}`, 'state');
  const actualState = rows[0]?.state as string | undefined;
  if (actualState !== expectedState) {
    await dumpStateAuditTrail(crSysId, crNumber);
    throw new Error(
      `❌ State transition "${stepLabel}" did not stick.\n` +
      `   Expected state=${expectedState}, but change_request is actually at state=${actualState}.\n` +
      `   The PATCH returned HTTP 200, but a Business Rule likely reverted the change on save. ` +
      `See the sys_audit dump above for the actual before/after values and who/what made them. ` +
      `Check business rules on change_request for conditions guarding this transition ` +
      `(including any that distinguish interactive UI sessions from API/OAuth sessions).`,
    );
  }
}

async function submitForAssess(crSysId: string, crNumber: string): Promise<string | undefined> {
  console.log('  [Step 2] Submitting for Assess (New → Assess)…');
  if (DRY_RUN) { console.log('  [DRY-RUN] Skipping state transition'); return undefined; }
  const assessState = await getStateValue('Assess');
  console.log(`  State value for Assess: ${assessState}`);
  await snowPatch('change_request', crSysId, { state: assessState });
  await verifyState(crSysId, crNumber, assessState, 'New → Assess');
  console.log('  ✓ CR is now in Assess state (verified)');
  return assessState;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — FILL RISK ASSESSMENT
// ─────────────────────────────────────────────────────────────────────────────

async function fillAndSubmitRiskAssessment(crSysId: string): Promise<RiskAssessmentRecord | undefined> {
  console.log('  [Step 3] Filling Risk Assessment…');
  if (DRY_RUN) { console.log('  [DRY-RUN] Skipping risk assessment'); return undefined; }

  // Poll for the assessment instance (auto-created when CR enters Assess state)
  let instanceSysId: string | undefined;
  for (let attempt = 1; attempt <= 10; attempt++) {
    // Try querying asmt_assessment_instance directly by source_id (the CR sys_id)
    const rows = await snowGet(
      'asmt_assessment_instance',
      `source_id=${crSysId}`,
      'sys_id,state',
    );
    if (rows.length > 0) {
      instanceSysId = rows[0].sys_id as string;
      break;
    }
    console.log(`  ⏳ Waiting for assessment instance… (attempt ${attempt}/10)`);
    await delay(2_000);
  }

  if (!instanceSysId) {
    throw new Error(
      '❌ Risk assessment instance not found after 20s.\n' +
      'The CR may not have a risk assessment template configured, or the state transition did not complete.',
    );
  }
  console.log(`  ✓ Assessment instance: ${instanceSysId}`);

  // Get all questions for this assessment instance
  const questions = await snowGet(
    'asmt_assessment_instance_question',
    `instance=${instanceSysId}`,
    'sys_id,metric,metric.name,metric.description',
  );
  console.log(`  Answering ${questions.length} question(s)…`);

  let questionsAnswered = 0;
  let aclFallbackUsed   = false;
  let riskValue: string | undefined;

  for (const q of questions) {
    const qSysId    = q.sys_id as string;
    const metricSysId = (q.metric as any)?.value ?? q.metric as string;
    const metricName  = ((q['metric.name'] as any) ?? (q['metric.description'] as any) ?? '').toString().toLowerCase();

    // Match question to configured answer
    const match = RISK_ANSWERS.find(r => metricName.includes(r.label.toLowerCase()));
    if (!match) {
      console.warn(`  ⚠ No answer configured for question: "${metricName}" — skipping`);
      continue;
    }

    // Set the answer using string_value (sysparm_input_display_value=true on the PATCH
    // allows ServiceNow to resolve choice/reference fields by display name automatically).
    try {
      await snowPatch('asmt_assessment_instance_question', qSysId, { string_value: match.answer });
      console.log(`    ✅ "${metricName}" → "${match.answer}"`);
      questionsAnswered++;
    } catch (err: any) {
      if (err.message?.includes('403')) {
        console.warn(`    ⚠ 403 ACL: cannot update question via API — service account may lack write permission on asmt_assessment_instance_question`);
        console.warn(`    ℹ Falling back: setting risk score directly on the CR`);
        // Fall back to setting risk directly on the change_request (Low = 3)
        await snowPatch('change_request', crSysId, { risk: '3' });
        console.log('  ✓ Risk set to Low directly on the CR (ACL fallback)');
        aclFallbackUsed = true;
        riskValue = '3';
        break;
      }
      throw err;
    }
  }

  // Mark assessment as complete (state 2 = complete in ServiceNow assessment framework)
  let submitted = false;
  try {
    await snowPatch('asmt_assessment_instance', instanceSysId, { state: '2' });
    console.log('  ✓ Risk Assessment submitted');
    submitted = true;
  } catch (err: any) {
    if (err.message?.includes('403')) {
      console.warn('  ⚠ 403 ACL: cannot mark assessment complete via API — risk score set directly on CR instead');
    } else {
      throw err;
    }
  }

  return {
    instanceSysId,
    questionsTotal: questions.length,
    questionsAnswered,
    aclFallbackUsed,
    riskValue,
    submitted,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — REQUEST APPROVAL
// ─────────────────────────────────────────────────────────────────────────────

async function requestApproval(crSysId: string, crNumber: string): Promise<string | undefined> {
  console.log('  [Step 4] Requesting CAB Approval (Assess → Authorize)…');
  if (DRY_RUN) { console.log('  [DRY-RUN] Skipping approval request'); return undefined; }
  const authorizeState = await getStateValue('Authorize');
  console.log(`  State value for Authorize: ${authorizeState}`);
  await snowPatch('change_request', crSysId, { state: authorizeState });
  await verifyState(crSysId, crNumber, authorizeState, 'Assess → Authorize');
  console.log('  ✓ CR is now in Authorize (verified, awaiting approvals)');
  return authorizeState;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE REQUEST CREATION
// ─────────────────────────────────────────────────────────────────────────────

async function createChangeRequest(configKey: ConfigKey): Promise<void> {
  const testData = TEST_CONFIGURATIONS[configKey];

  console.log(`\n📋 [${configKey}] Building Change Request payload…`);

  const crPayload: Record<string, unknown> = {
    // ── Classification ────────────────────────────────────────────────────────
    category:          'Enterprise_business_application',

    // ── CI + Service (display values resolved by sysparm_input_display_value) ─
    business_service:  testData.serviceText,
    cmdb_ci:           testData.configItemText,

    // ── Ownership ─────────────────────────────────────────────────────────────
    // group_list = additional approval groups (comma-separated display values)
    group_list:        testData.additionalApprovalGroups.join(','),
    assignment_group:  'IDT-RELEASE-MGMT-TR',
    assigned_to:       'Radha Krishna Murthy Pachipulusu',

    // ── Descriptions ─────────────────────────────────────────────────────────
    short_description: testData.shortDescriptionText,
    description:       testData.detailedDescriptionText,

    // ── Planning tab ─────────────────────────────────────────────────────────
    justification:        testData.justificationText,
    implementation_plan:  testData.implementationPlanText,
    risk_impact_analysis: testData.riskAndImpactAnalysisText,
    backout_plan:         testData.backoutPlanText,
    test_plan:            testData.testPlanText,

    // ── Schedule tab ─────────────────────────────────────────────────────────
    start_date: toSnowDate(testData.plannedStartDate),
    end_date:   toSnowDate(testData.plannedEndDate),
  };

  if (DRY_RUN) {
    console.log(`  [DRY-RUN] CR payload:\n${JSON.stringify(crPayload, null, 2)}`);
    console.log(`  [DRY-RUN] Skipping API call — no CR created.\n`);
    return;
  }

  console.log(`  Calling POST /api/now/table/change_request…`);
  const cr = await snowPost('change_request', crPayload);

  // The response fields are plain strings (not objects) when input_display_value is used
  const crNumber = (cr.number as any)?.display_value ?? cr.number as string;
  const sysId    = (cr.sys_id  as any)?.value         ?? cr.sys_id  as string;

  console.log(`  ✓ CR Created : ${crNumber}`);
  console.log(`  ✓ sys_id     : ${sysId}`);

  // Save immediately so a CR always shows up in the registry (with the
  // correct crUrl and sys_id) even if a later step throws. sysId only needs
  // to be passed this once — later save() calls below omit it and the
  // previously-saved value is preserved automatically.
  await ChangeRequestStorage.save(
    testData.configName,
    crNumber,
    testData.releaseVersion,
    testData.shortDescriptionText,
    sysId,
    { finalState: 'New' },
  );

  // Now create the CTasks under this CR
  const ctasks = await createCtasksForCR(configKey, sysId);
  await ChangeRequestStorage.save(
    testData.configName, crNumber, testData.releaseVersion, testData.shortDescriptionText, undefined, { ctasks },
  );

  // ── Step 2: Submit for Assess ──────────────────────────────────────────────
  try {
    const assessState = await submitForAssess(sysId, crNumber);
    await ChangeRequestStorage.save(
      testData.configName, crNumber, testData.releaseVersion, testData.shortDescriptionText, undefined,
      { assessState, finalState: 'Assess' },
    );

    // ── Step 3: Fill and submit Risk Assessment ────────────────────────────────
    const riskAssessment = await fillAndSubmitRiskAssessment(sysId);
    await ChangeRequestStorage.save(
      testData.configName, crNumber, testData.releaseVersion, testData.shortDescriptionText, undefined, { riskAssessment },
    );

    // ── Step 4: Request CAB Approval ──────────────────────────────────────────
    const authorizeState = await requestApproval(sysId, crNumber);
    await ChangeRequestStorage.save(
      testData.configName, crNumber, testData.releaseVersion, testData.shortDescriptionText, undefined,
      { authorizeState, finalState: 'Authorize' },
    );
  } catch (err) {
    // Record how far the workflow actually got, instead of leaving the
    // registry silently stuck at "New" with no clue what happened.
    await ChangeRequestStorage.save(
      testData.configName, crNumber, testData.releaseVersion, testData.shortDescriptionText, undefined,
      { finalState: 'Failed' },
    );
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CTASK CREATION
// ─────────────────────────────────────────────────────────────────────────────

interface CtaskStep {
  stepNumber:       number;
  assignment_group: string;
  assigned_to?:     string;
  department:       string;
}

async function createCtasksForCR(configKey: ConfigKey, crSysId: string): Promise<CtaskRecord[]> {
  const testData    = TEST_CONFIGURATIONS[configKey];
  const ctaskConfig = getCtaskConfig(testData.environment, testData.region);
  const descriptions = getCtaskDescriptions(
    testData.environment,
    testData.region,
    testData.releaseVersion,
    testData.buildVersion,
  );

  const { assignmentGroups, assignedTo } = CTASK_CONFIGURATIONS;

  // Build a flat list of steps in step-number order
  const steps: CtaskStep[] = [
    ...ctaskConfig.rm     .map(n => ({ stepNumber: n, assignment_group: assignmentGroups.rm.name,      assigned_to: assignedTo.default, department: 'RM'      })),
    ...ctaskConfig.devops .map(n => ({ stepNumber: n, assignment_group: assignmentGroups.devops.name,  department: 'DevOps'  })),
    ...ctaskConfig.techops.map(n => ({ stepNumber: n, assignment_group: assignmentGroups.techops.name, department: 'TechOps' })),
    ...ctaskConfig.qa     .map(n => ({ stepNumber: n, assignment_group: assignmentGroups.qa.name,      department: 'QA'      })),
  ].sort((a, b) => a.stepNumber - b.stepNumber);

  const created: CtaskRecord[] = [];

  if (steps.length === 0) {
    console.log(`  ℹ  No CTasks defined for ${configKey}.`);
    return created;
  }

  console.log(`  Creating ${steps.length} CTask(s) for ${configKey}…`);

  for (const step of steps) {
    const desc = descriptions[step.stepNumber];
    if (!desc) throw new Error(`[${configKey}] No CTask description for step ${step.stepNumber}`);

    const ctaskPayload: Record<string, unknown> = {
      change_request:     crSysId,
      short_description:  desc.shortDescription,
      description:        desc.detailedDescription,
      assignment_group:   step.assignment_group,
      planned_start_date: toSnowDate(testData.plannedStartDate),
      planned_end_date:   toSnowDate(testData.plannedEndDate),
    };

    // assigned_to is only set for RM department tasks (matches Playwright behaviour)
    if (step.assigned_to) ctaskPayload.assigned_to = step.assigned_to;

    if (DRY_RUN) {
      console.log(`    [DRY-RUN] Step ${step.stepNumber} (${step.department}) payload:\n    ${JSON.stringify(ctaskPayload)}`);
      continue;
    }

    const ctask = await snowPost('change_task', ctaskPayload);
    const ctaskNumber = (ctask.number as any)?.display_value ?? ctask.number as string;
    console.log(`    ✓ Step ${step.stepNumber} [${step.department}] → ${ctaskNumber}`);
    created.push({ step: step.stepNumber, department: step.department, ctaskNumber });
  }

  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const releaseVersion = process.env.RELEASE_VERSION!;

  // Resolve which configs to run
  const configFilter = process.env.CR_CONFIG
    ?.split(',')
    .map(s => s.trim() as ConfigKey)
    .filter(k => k in TEST_CONFIGURATIONS);

  const configKeys: ConfigKey[] = configFilter?.length
    ? configFilter
    : (Object.keys(TEST_CONFIGURATIONS) as ConfigKey[]);

  console.log('═'.repeat(60));
  console.log(`  ServiceNow API — CR Creation`);
  console.log(`  Release : ${releaseVersion}`);
  console.log(`  Configs : ${configKeys.join(', ')}`);
  if (DRY_RUN) console.log('  Mode    : DRY-RUN (no API calls)');
  console.log('═'.repeat(60));

  // Run all selected configs in parallel (mirrors Playwright --workers=N behaviour)
  const results = await Promise.allSettled(
    configKeys.map(key => createChangeRequest(key)),
  );

  console.log('\n' + '─'.repeat(60));
  console.log('  Summary');
  console.log('─'.repeat(60));

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      console.log(`  ✅ ${configKeys[i]}`);
      passed++;
    } else {
      console.error(`  ❌ ${configKeys[i]}: ${(r.reason as Error).message}`);
      failed++;
    }
  }

  console.log('─'.repeat(60));
  console.log(`  ${passed} succeeded, ${failed} failed`);
  console.log('═'.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// RUN COMMANDS
// ─────────────────────────────────────────────────────────────────────────────
//
// RELEASE_VERSION is passed as a CLI argument (first positional argument).
// SN_USERNAME and SN_PASSWORD come from .env or environment variables.
//
// Prerequisites — set in .env or as env vars:
//   $env:SN_USERNAME="your_service_account"
//   $env:SN_PASSWORD="your_password"
//
// ── Dry-run (validate payloads, no API calls) ──────────────────────────────
//   $env:DRY_RUN="true";
//   npx ts-node tests/servicenow_cre/createCR_api.ts 2026.05.00
//
// ── Single environment ─────────────────────────────────────────────────────
//   $env:CR_CONFIG="UAT_MENA";
//   npx ts-node tests/servicenow_cre/createCR_api.ts 2026.05.00
//
// ── Multiple environments ──────────────────────────────────────────────────
//   $env:CR_CONFIG="UAT_MENA,PROD_MENA";
//   npx ts-node tests/servicenow_cre/createCR_api.ts 2026.05.00
//
// ── All 7 environments (parallel) ─────────────────────────────────────────
//   npx ts-node tests/servicenow_cre/createCR_api.ts 2026.05.00
//
// ── npm scripts (from repo root) ──────────────────────────────────────────
//   npm run cr:api 2026.05.00
//   npm run cr:api:dry-run 2026.05.00

//Clear dry run and re-run
//Remove-Item Env:DRY_RUN; $env:CR_CONFIG="SAT"; npx ts-node tests/servicenow_cre/createCR_api.ts 2026.08.00