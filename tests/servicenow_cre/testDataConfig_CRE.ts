/**
 * TEST DATA CONFIGURATION — CENTRALIZED HUB
 * ==========================================
 *
 * Reads ALL data from cre_release_schedule.yaml — the single source of truth for both
 * the Playwright CR-creation suite and the Teams meeting automation (teams_meeting.py).
 *
 * Zod validates the YAML at startup — bad formats throw before any browser opens.
 *
 * To update a release: edit cre_release_schedule.yaml only. No TypeScript changes needed.
 *
 * RELEASE_VERSION must be passed as an environment variable:
 *   $env:RELEASE_VERSION="2026.05.00"; npx playwright test ...
 */

import fs   from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvironmentTestData {
  configName:                string;
  environment:               string;
  region?:                   string;
  releaseVersion:            string;
  buildVersion:              string;
  plannedStartDate:          string;
  plannedEndDate:            string;
  shortDescriptionText:      string;
  detailedDescriptionText:   string;
  justificationText:         string;
  implementationPlanText:    string;
  riskAndImpactAnalysisText: string;
  backoutPlanText:           string;
  testPlanText:              string;
  serviceText:               string;
  configItemText:            string;
  additionalApprovalGroups:  string[];
  changeRequestNumber?:      string;
  createdAt?:                string;
  sysId?:                    string;
}

export interface CtaskRecord {
  step:        number;
  department:  string;
  ctaskNumber: string;
}

export interface RiskAssessmentRecord {
  instanceSysId:     string;
  questionsTotal:    number;
  questionsAnswered: number;
  aclFallbackUsed:   boolean;
  riskValue?:        string;
  submitted:         boolean;
}

export type CrFinalState = 'New' | 'Assess' | 'Authorize' | 'Failed';

interface CrEntry {
  crNumber:        string;
  crUrl:           string;
  crSysId?:        string;
  timestamp:       string;
  configName:      string;
  releaseVersion:  string;
  shortDescription: string;  // CR short description — used by teams_meeting.py for the Teams description line
  // ── Step 2/3/4 workflow detail — populated incrementally as createCR_api.ts
  // progresses the CR through Assess → Risk Assessment → Authorize ──────────
  assessState?:     string;
  authorizeState?:  string;
  finalState?:      CrFinalState;
  ctasks?:          CtaskRecord[];
  riskAssessment?:  RiskAssessmentRecord;
}

type Registry = Record<string, Record<string, CrEntry>>;

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE SCHEDULE LOADER
// ─────────────────────────────────────────────────────────────────────────────

const DateString = z
  .string()
  .regex(/^\d{2}-\d{2}-\d{4}$/, 'Date must be DD-MM-YYYY (e.g. "07-05-2026")');

const TimeString = z
  .string()
  .regex(/^\d{2}:\d{2}:\d{2}$/, 'Time must be HH:MM:SS (e.g. "16:20:00")');

// Validates the deployment_dates block inside each release entry
const DeploymentDatesSchema = z.object({
  SAT:       DateString,
  UAT_EMEA:  DateString,
  UAT_AMER:  DateString,
  UAT_MENA:  DateString,
  PROD_EMEA: DateString,
  PROD_AMER: DateString,
  PROD_MENA: DateString,
});

// Validates one release block in the merged config_cre.yaml
const ReleaseEntrySchema = z.object({
  buildVersion:      z.string().min(1, 'buildVersion is required (e.g. "Build#0")'),
  deployment_dates:  DeploymentDatesSchema,
  meeting_dates:     z.record(z.string(), z.string()).optional(), // used by teams_meeting.py only
});

// Validates only the sections Playwright cares about (other sections are ignored)
const MasterConfigSchema = z.object({
  deployment_times: z.object({ start: TimeString, end: TimeString }),
  releases: z.object({
    schedule: z.record(
      z.string().regex(/^\d{4}\.\d{2}\.\d{2}$/, 'Release version must be YYYY.MM.NN (e.g. "2026.06.00" or "2026.06.01")'),
      ReleaseEntrySchema,
    ),
  }),
});

// ConfigKey — only the 7 deployment environment keys
type DeploymentDates = z.infer<typeof DeploymentDatesSchema>;
export type ConfigKey = keyof DeploymentDates;

interface DeploymentWindow { plannedStartDate: string; plannedEndDate: string; }
interface ReleaseData      { buildVersion: string; windows: Record<ConfigKey, DeploymentWindow>; }
type ParsedSchedule = Record<string, ReleaseData>;

function loadReleaseSchedule(): ParsedSchedule {
  const filePath = path.join(__dirname, 'cre_release_schedule.yaml');

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `❌ cre_release_schedule.yaml not found at: ${filePath}\n` +
      'Verify the file exists in the CRE test folder.',
    );
  }

  const result = MasterConfigSchema.safeParse(yaml.load(fs.readFileSync(filePath, 'utf-8')));

  if (!result.success) {
    const issues = result.error.issues.map(i => `  • [${i.path.join('.')}] ${i.message}`).join('\n');
    throw new Error(`❌ cre_release_schedule.yaml failed validation:\n${issues}\n\nFix the values and re-run.`);
  }

  const { deployment_times: { start, end }, releases: { schedule } } = result.data;
  const parsed: ParsedSchedule = {};

  for (const [version, entry] of Object.entries(schedule)) {
    const { buildVersion, deployment_dates } = entry;
    parsed[version] = { buildVersion, windows: {} as Record<ConfigKey, DeploymentWindow> };
    for (const [env, date] of Object.entries(deployment_dates) as [ConfigKey, string][]) {
      parsed[version].windows[env] = {
        plannedStartDate: `${date} ${start}`,
        plannedEndDate:   `${date} ${end}`,
      };
    }
  }

  return parsed;
}

// Loaded once at module init — YAML errors surface before any test begins
const RELEASE_SCHEDULE = loadReleaseSchedule();

// ─────────────────────────────────────────────────────────────────────────────
// COMMON CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

export const COMMON_CONSTANTS = {
  // ServiceNow field values
  categoryValue:         'Enterprise_business_application',
  categoryText:          'Enterprise business application',
  serviceText:           'ONESOURCE Indirect Tax Determination Cloud Rate Extract-Preprod',
  configItemText:        'ONESOURCE Indirect Tax Determination Cloud Rate Extract-Preprod',
  assignmentGroupRmText: 'IDT-RELEASE-MGMT-TR',
  assignedToRmText:      'Radha Krishna Murthy Pachipulusu',

  // Timeouts (ms)
  timeoutElementVisible: 60_000,
  timeoutAutosuggest:    60_000,
  timeoutPageNav:        60_000,
  timeoutWaitProcessing: 60_000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE DETAILS
// ─────────────────────────────────────────────────────────────────────────────

const SHAREPOINT_BASE =
  'https://trten.sharepoint.com/sites/IndirectTaxReleaseManagement/SitePages/';

const RELEASE_DETAILS = {
  // Sourced from terminal: $env:RELEASE_VERSION="2026.05.00"
  version: process.env.RELEASE_VERSION!,

  get buildVersion(): string {
    return this._getEntry().buildVersion;
  },

  get backoutVersion(): string {
    const [year, rel, patch] = this.version.split('.').map(Number);
    if (patch > 0) return `${year}.${String(rel).padStart(2, '0')}.00`;
    return rel > 1
      ? `${year}.${String(rel - 1).padStart(2, '0')}.00`
      : `${year - 1}.10.00`;
  },

  releaseBranchUrl: (v: string) =>
    `${SHAREPOINT_BASE}Content%20Rate%20Extract%20Cloud%20Release%20Branch%20Summary%20-%20CRE%20${v}.aspx`,

  releaseNotesUrl: (v: string) =>
    `${SHAREPOINT_BASE}Content%20Rate%20Extract%20Cloud%20Internal%20Release%20Notes%20-%20CRE%20${v}.aspx`,

  deploymentWindow(configName: ConfigKey): DeploymentWindow {
    return this._getEntry().windows[configName];
  },

  descriptionFooter(releaseVersion: string, environment: string, buildVersion: string): string {
    return (
      `For Git Hashes and Artifacts, please refer to this link ` +
      `[In the table 'CRE Cloud ${releaseVersion}', Under the section '${environment} Deployment : ${buildVersion}']\n\n` +
      this.releaseBranchUrl(releaseVersion)
    );
  },

  // Internal helper — single guard for missing schedule entry
  _getEntry(): ReleaseData {
    const entry = RELEASE_SCHEDULE[this.version];
    if (!entry) {
      throw new Error(
        `❌ No schedule entry for release "${this.version}" in cre_release_schedule.yaml.\n` +
        `Available releases: ${Object.keys(RELEASE_SCHEDULE).join(', ')}`,
      );
    }
    return entry;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// PLANNING TEXTS
// ─────────────────────────────────────────────────────────────────────────────

const getPlanningTexts = (releaseVersion: string, environment: string) => ({
  justification: `New Release\n${RELEASE_DETAILS.releaseNotesUrl(releaseVersion)}`,

  riskAndImpactAnalysis: [
    `Could there be additional Services/CIs/BUs impacted? - None, it doesn't impact the ONESOURCE platform.`,
    `* How could they be impacted? - only the ONESOURCE Indirect Tax application will be deployed to ${environment} and there is no downtime during this deployment activity.`,
    `* Could the expected outage or degrade in service be extended? - No impact, there is no downtime during the deployment activity.`,
    `* Could this Change cause a potential impact on any of the listed Blackouts/Change Restrictions on the Global Events Calendar? - No, the ONESOURCE Indirect Tax global blackout calendar starts on Nov 20, 2026, and it does not impact the ONESOURCE platform or any Corp. applications.`,
    `* Why the release could not be scheduled on the weekend - There is no deployment downtime.`,
  ].join('\n'),

  backoutPlan:
    `Backout to prior release details on (Refer previous release version):\n` +
    RELEASE_DETAILS.releaseBranchUrl(RELEASE_DETAILS.backoutVersion),

  testPlan: [
    `1. Post Validation Plan - Attached is the post-CHG # validation plan: https://trten.sharepoint.com/sites/intr-idt-product-engineering/Shared%20Documents/Forms/AllItems.aspx`,
    `2. Technical Validation  - IDT QA team will validate post-completion of this CHG:  Ananya.Ummadi@thomsonreuters.com`,
    `3. Business Validation - BU is - Indirect Tax  and Technical validation is done with BU QA team,  Ananya.Ummadi@thomsonreuters.com`,
  ].join('\n'),
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST CONFIGURATION FACTORY
// ─────────────────────────────────────────────────────────────────────────────

interface ConfigDef {
  configName:               ConfigKey;
  environment:              string;
  region?:                  string;
  cloudPrefix:              string;
  additionalApprovalGroups: string[];
}

const CONFIG_DEFS: ConfigDef[] = [
  { configName: 'SAT',       environment: 'SAT',  cloudPrefix: 'AWS',     additionalApprovalGroups: ['APP-DEVOPS-IDT']  },
  { configName: 'UAT_EMEA',  environment: 'UAT',  region: 'EMEA', cloudPrefix: 'AWS',     additionalApprovalGroups: ['APP-SUPPORT-IDT'] },
  { configName: 'UAT_AMER',  environment: 'UAT',  region: 'AMER', cloudPrefix: 'AWS/OCI', additionalApprovalGroups: ['APP-SUPPORT-IDT'] },
  { configName: 'UAT_MENA',  environment: 'UAT',  region: 'MENA', cloudPrefix: 'OCI',     additionalApprovalGroups: ['APP-SUPPORT-IDT'] },
  { configName: 'PROD_EMEA', environment: 'PROD', region: 'EMEA', cloudPrefix: 'AWS',     additionalApprovalGroups: ['APP-SUPPORT-IDT'] },
  { configName: 'PROD_AMER', environment: 'PROD', region: 'AMER', cloudPrefix: 'AWS/OCI', additionalApprovalGroups: ['APP-SUPPORT-IDT'] },
  { configName: 'PROD_MENA', environment: 'PROD', region: 'MENA', cloudPrefix: 'OCI',     additionalApprovalGroups: ['APP-SUPPORT-IDT'] },
];

function buildConfig(def: ConfigDef): EnvironmentTestData {
  const regionEnv = def.region ? `${def.region} ${def.environment}` : def.environment;

  const shortDesc = (v: string, build: string) =>
    def.configName === 'SAT'
      ? `Content Rate Extract | ${v} | APP | ${def.cloudPrefix} ${def.environment} & OCI QA (${build})`
      : `Content Rate Extract | ${v} | APP | ${def.cloudPrefix} ${regionEnv} (${build})`;

  return {
    configName:  def.configName,
    environment: def.environment,
    region:      def.region,

    get releaseVersion()  { return RELEASE_DETAILS.version; },
    get buildVersion()    { return RELEASE_DETAILS.buildVersion; },
    get plannedStartDate(){ return RELEASE_DETAILS.deploymentWindow(def.configName).plannedStartDate; },
    get plannedEndDate()  { return RELEASE_DETAILS.deploymentWindow(def.configName).plannedEndDate; },

    get shortDescriptionText()     { return shortDesc(this.releaseVersion, this.buildVersion); },
    get detailedDescriptionText()  {
      return `${shortDesc(this.releaseVersion, this.buildVersion)}\n\n` +
        RELEASE_DETAILS.descriptionFooter(this.releaseVersion, this.environment, this.buildVersion);
    },
    get justificationText()         { return getPlanningTexts(this.releaseVersion, this.environment).justification; },
    get implementationPlanText()    { return this.detailedDescriptionText; },
    get riskAndImpactAnalysisText() { return getPlanningTexts(this.releaseVersion, this.environment).riskAndImpactAnalysis; },
    get backoutPlanText()           { return getPlanningTexts(this.releaseVersion, this.environment).backoutPlan; },
    get testPlanText()              { return getPlanningTexts(this.releaseVersion, this.environment).testPlan; },

    serviceText:    def.environment === 'PROD'
      ? 'ONESOURCE Indirect Tax Determination Cloud Rate Extract'
      : 'ONESOURCE Indirect Tax Determination Cloud Rate Extract-Preprod',
    configItemText: def.environment === 'PROD'
      ? 'ONESOURCE Indirect Tax Determination Cloud Rate Extract'
      : 'ONESOURCE Indirect Tax Determination Cloud Rate Extract-Preprod',
    additionalApprovalGroups: def.additionalApprovalGroups,
  } as EnvironmentTestData;
}

export const TEST_CONFIGURATIONS: Record<ConfigKey, EnvironmentTestData> =
  Object.fromEntries(CONFIG_DEFS.map(d => [d.configName, buildConfig(d)])) as Record<ConfigKey, EnvironmentTestData>;

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE REQUEST STORAGE
// ─────────────────────────────────────────────────────────────────────────────

// Single source of truth for the ServiceNow instance host — used both for
// building UI record links here AND for the Table API base URL in
// createCR_api.ts (which imports SN_BASE_URL from this module). Previously
// these were two separate hardcoded strings that drifted apart: the API
// created CRs against the `dev` instance while this file linked to the
// bare `trenterprise` (prod) host, so every generated link 404'd with
// "record not found" even though the CR was real.
//
// Toggled by SN_INSTANCE — same env var, same convention as
// testDataConfig_TDR.ts and playwright.config.ts, read from .env:
//   SN_INSTANCE=prod   → https://trenterprise.service-now.com    (PingID/MFA required)
//   (unset / anything else) → https://trenterprisedev.service-now.com (no PingID)
export const SN_BASE_URL = process.env.SN_INSTANCE === 'prod'
  ? 'https://trenterprise.service-now.com'
  : 'https://trenterprisedev.service-now.com';

/**
 * Builds a nav_to.do URL for browser navigation to a CR by sys_id.
 *
 * nav_to.do loads the full ServiceNow portal shell (required so the form
 * renders inside #gsft_main for iframe-based interaction) — different from
 * generateCrUrl() above, which builds a stored/shareable deep-link and does
 * NOT go through nav_to.do. Keep these two separate; they serve different
 * purposes and are not interchangeable.
 *
 * Was previously duplicated ~6 times across changeRequest_spec.ts,
 * ctasks_spec.ts, and riskmanagement_spec.ts, each with its own hardcoded
 * host — which is exactly how the host/format drift bug happened in the
 * first place. One helper, one host (SN_BASE_URL), used everywhere.
 */
export function buildNavToCrUri(sysId: string): string {
  const listFilter = encodeURIComponent(
    'active=true^short_description>=Content Rate Extract^ORDERBYshort_description',
  );
  const recordUri = encodeURIComponent(`change_request.do?sys_id=${sysId}&sysparm_record_list=${listFilter}`);
  return `${SN_BASE_URL}/nav_to.do?uri=${recordUri}`;
}

// ─── Teams description helper ─────────────────────────────────────────────────
// Generates the linked CR line for Teams meeting descriptions, e.g.:
//   [CHG0216230](https://...?sys_id=...) Content Rate Extract | 2026.05.00 | APP | AWS SAT & OCI QA (Build#0)
//
// Markdown hyperlink syntax is supported in Teams meeting descriptions
// when rendered via Power Automate. The crUrl comes from ChangeRequestStorage.
export function buildTeamsDescriptionLine(
  crNumber:  string,
  crUrl:     string,
  shortDesc: string,
): string {
  return `[${crNumber}](${crUrl}) ${shortDesc}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY FILE LOCK  (parallel-safe write guard)
// ─────────────────────────────────────────────────────────────────────────────
// When --grep runs two (or more) tests in parallel each worker calls
// ChangeRequestStorage.save() independently.  Without a lock, both workers
// could simultaneously read the YAML, each overwrite the other's entry, and
// corrupt the registry.  The lock serialises writes: one worker holds the lock,
// finishes its read-modify-write, then releases; the next worker proceeds.
//
// Timing constants (kept conservatively large — the critical section is fast):
//   LOCK_STALE_MS  – a lock older than this is assumed left by a crashed process
//   LOCK_WAIT_MS   – how long to wait before giving up on acquiring the lock
//   LOCK_POLL_MS   – polling interval while waiting

const REGISTRY_LOCK_FILE  = path.join(__dirname, 'change_request_registry.lock');
const REGISTRY_LOCK_STALE = 30_000;  // 30 s
const REGISTRY_LOCK_WAIT  = 20_000;  // 20 s
const REGISTRY_LOCK_POLL  =    200;  // 200 ms

// Mirror copies written after every save — consumed by all teams_meeting_* scripts
const REGISTRY_MIRROR_PATHS = [
  path.join(__dirname, '..', 'teams_meeting_single_http', 'config', 'change_request_registry.yaml'),
  path.join(__dirname, '..', 'teams_meeting_http',        'config', 'change_request_registry.yaml'),
  path.join(__dirname, '..', 'teams_meeting_pw',          'config', 'change_request_registry.yaml'),
];

/** Busy-wait until we can acquire the registry lock.  Returns a release function. */
async function acquireRegistryLock(): Promise<() => void> {
  const deadline = Date.now() + REGISTRY_LOCK_WAIT;

  while (true) {
    // Remove a stale lock left by a crashed process
    if (fs.existsSync(REGISTRY_LOCK_FILE)) {
      const age = Date.now() - fs.statSync(REGISTRY_LOCK_FILE).mtimeMs;
      if (age > REGISTRY_LOCK_STALE) {
        try { fs.unlinkSync(REGISTRY_LOCK_FILE); } catch { /* race — another worker beat us */ }
      }
    }

    // Atomic exclusive create: succeeds only in the process that writes first
    try {
      fs.writeFileSync(REGISTRY_LOCK_FILE, String(process.pid), { flag: 'wx' });
      // We own the lock — return a release callback
      return () => { try { fs.unlinkSync(REGISTRY_LOCK_FILE); } catch { /* already gone */ } };
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e; // unexpected error — re-throw
    }

    if (Date.now() >= deadline) {
      console.warn('⚠ Could not acquire registry lock within timeout — writing anyway');
      return () => { /* no lock to release */ };
    }

    await new Promise(r => setTimeout(r, REGISTRY_LOCK_POLL));
  }
}

export const ChangeRequestStorage = {
  // Registry lives alongside testDataConfig_CRE.ts in the CRE/ directory
  getStoragePath: () => path.join(__dirname, 'change_request_registry.yaml'),

  /**
   * Builds a direct-record URL for a change request.
   *
   * BUGFIX HISTORY:
   *   v1 (broken): `${prod_host}/change_request.do?sysparm_query=number=CHGxxxx`
   *     - `sysparm_query` only works on *list* views (change_request_list.do);
   *       the single-record form view needs `sys_id`.
   *     - Host was the prod-named instance while CRs are actually created
   *       against the dev instance — link pointed at a record that doesn't
   *       exist there → "record not found".
   *   v2 (still broken): bare `${SN_BASE_URL}/change_request.do?sys_id=<id>`
   *     - Right host, right sys_id, but this instance's Now UI (Polaris/Next
   *       Experience shell) doesn't reliably resolve the un-wrapped classic
   *       form URL.
   *   v3 (this version): the actual URL ServiceNow's own UI generates when
   *     you open a CR — the classic form wrapped in the Now UI shell
   *     (`/now/nav/ui/classic/params/target/<double-encoded classic url>`),
   *     including sys_id AND a sysparm_record_list filtered to this CR
   *     number. Verified byte-for-byte against a URL copied out of the live
   *     UI — this is the format to keep.
   *
   * Falls back to a number-filtered link (still v3-wrapped) if sysId wasn't
   * captured — better than nothing, though it opens a filtered list rather
   * than the record directly.
   */
  generateCrUrl(crNumber: string, releaseVersion: string, sysId?: string): string {
    const recordListQuery = `active=true^number=${crNumber}^ORDERBYnumber`;

    const classicPath = sysId
      ? `change_request.do?sys_id=${sysId}` +
        `&sysparm_record_target=change_request` +
        `&sysparm_record_row=1` +
        `&sysparm_record_rows=1` +
        `&sysparm_record_list=${encodeURIComponent(recordListQuery)}`
      // Fallback when sys_id wasn't captured: number-filtered list view.
      : `change_request_list.do?sysparm_query=${encodeURIComponent(`number=${crNumber}`)}`;

    return `${SN_BASE_URL}/now/nav/ui/classic/params/target/${encodeURIComponent(classicPath)}`;
  },

  loadAll(): Registry {
    try {
      const filePath = this.getStoragePath();
      if (fs.existsSync(filePath)) {
        const raw = yaml.load(fs.readFileSync(filePath, 'utf-8')) as any;
        // Support both wrapped { change_request_registry: ... } and legacy flat format
        return ((raw?.change_request_registry ?? raw) as Registry) ?? {};
      }
    } catch {
      console.log('Note: Could not load change request registry, starting fresh');
    }
    return {};
  },

  /**
   * Parallel-safe save: acquires a file lock before reading+writing the YAML
   * registry so concurrent workers (e.g. UAT_MENA + PROD_MENA) don't overwrite
   * each other's entries.
   *
   * Merges with any existing entry for this CR rather than replacing it, so
   * callers can save incrementally as the CR progresses through its workflow
   * (e.g. once right after creation, again after CTasks are created, again
   * after each state transition) without needing to re-pass every field each
   * time. `sysId` only needs to be passed once — later calls that omit it
   * keep the previously-saved sys_id (and therefore the correct crUrl).
   */
  async save(
    configName:       string,
    crNumber:         string,
    releaseVersion:   string,
    shortDescription: string,
    sysId?:           string,
    extra?:           Partial<Pick<CrEntry, 'assessState' | 'authorizeState' | 'finalState' | 'ctasks' | 'riskAssessment'>>,
  ): Promise<void> {
    const release = await acquireRegistryLock();
    try {
      const registry = this.loadAll();
      registry[releaseVersion] ??= {};
      const existing = registry[releaseVersion][crNumber];

      // Keep whichever sys_id we have — a new one passed now, or one saved earlier.
      const effectiveSysId = sysId ?? existing?.crSysId;

      const entry: CrEntry = {
        ...existing,
        crNumber,
        crUrl:            this.generateCrUrl(crNumber, releaseVersion, effectiveSysId),
        timestamp:        new Date().toISOString(),
        configName,
        releaseVersion,
        shortDescription,
        ...(effectiveSysId && { crSysId: effectiveSysId }),
        ...extra,
      };

      registry[releaseVersion][crNumber] = entry;

      fs.writeFileSync(this.getStoragePath(), yaml.dump({ change_request_registry: registry }, { lineWidth: 200 }), 'utf-8');
      console.log(`✓ CR ${crNumber} (${releaseVersion} / ${configName}) saved to registry`);
      if (effectiveSysId) console.log(`  Sys ID: ${effectiveSysId}`);

      // Mirror to all teams_meeting_*/config/change_request_registry.yaml (same format)
      for (const mirrorPath of REGISTRY_MIRROR_PATHS) {
        try {
          let mirror: Record<string, any> = {};
          if (fs.existsSync(mirrorPath)) {
            const raw = yaml.load(fs.readFileSync(mirrorPath, 'utf-8')) as any;
            mirror = raw?.change_request_registry ?? {};
          }
          mirror[releaseVersion] ??= {};
          mirror[releaseVersion][crNumber] = entry;
          fs.writeFileSync(mirrorPath, yaml.dump({ change_request_registry: mirror }, { lineWidth: 200 }), 'utf-8');
          console.log(`✓ CR ${crNumber} mirrored to ${path.relative(path.join(__dirname, '..'), mirrorPath)}`);
        } catch (mirrorError) {
          console.warn(`⚠ Could not mirror to ${mirrorPath}:`, mirrorError);
        }
      }
    } catch (error) {
      console.error('Error saving change request:', error);
    } finally {
      release();
    }
  },

  getByConfig(configName: string): string | null {
    const registry = this.loadAll();
    const matches: [string, CrEntry][] = [];
    for (const crs of Object.values(registry)) {
      for (const [num, data] of Object.entries(crs)) {
        if (data.configName === configName) matches.push([num, data]);
      }
    }
    if (!matches.length) return null;
    matches.sort((a, b) => new Date(b[1].timestamp).getTime() - new Date(a[1].timestamp).getTime());
    return matches[0][0];
  },

  clear(): void {
    try {
      const filePath = this.getStoragePath();
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log('✓ Change Request registry cleared');
      }
    } catch (error) {
      console.error('Error clearing registry:', error);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CTASK CONFIGURATIONS
// ─────────────────────────────────────────────────────────────────────────────

export interface StepDescription { shortDescription: string; detailedDescription: string; }
interface CtaskSteps             { rm: number[]; devops: number[]; techops: number[]; qa: number[]; }
interface CtaskEnvConfig         { ctasks: CtaskSteps; stepDescriptions: Record<number, StepDescription>; }
interface RegionConfig           { EMEA: CtaskEnvConfig; AMER: CtaskEnvConfig; MENA: CtaskEnvConfig; }

// Shared footer appended to every CTask detailed description
const CTASK_FOOTER =
  "\nFor Git Hashes and Artifacts, please refer to this link " +
  "[In the table 'CRE Cloud {RELEASEVERSION}', Under the section '{ENVIRONMENT} Deployment : {BUILDVERSION}']\n";

const appendUrl = (desc: string): string =>
  `${desc}${CTASK_FOOTER}${RELEASE_DETAILS.releaseBranchUrl('{RELEASEVERSION}')}`;

const step = (shortDesc: string): StepDescription => ({
  shortDescription:    shortDesc,
  detailedDescription: appendUrl(shortDesc),
});

// ── Step templates per region ────────────────────────────────────────────────

// Shared STEP 0 — identical across all UAT & PROD regions
const STEP_0: StepDescription = {
  shortDescription:    'STEP 0: Bring Down Services Before Deployment',
  detailedDescription: 'STEP 0: Bring Down Services Before Deployment\nStop the following SDM, STAGING and CE services before starting the deployment:\n\na200206-idt-cre-sdm-us-east-1-prod-ecs-service\na200206-idt-cre-staging-us-east-1-prod-ecs-service\na200206-idt-cre-ce-us-east-1-prod-ecs-service',
};

const EMEA_STEPS: Record<number, StepDescription> = {
  1: step('STEP1: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} AWS EMEA {ENVIRONMENT}'),
  2: step('STEP2: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} AWS EMEA {ENVIRONMENT}'),
  3: step('STEP3: QA Validation: CRE {RELEASEVERSION} | APP | AWS EMEA {ENVIRONMENT}'),
};

const AMER_STEPS: Record<number, StepDescription> = {
  0: STEP_0,
  1: step('STEP1: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} AWS AMER {ENVIRONMENT}'),
  2: step('STEP2: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} OCI AMER {ENVIRONMENT}'),
  3: step('STEP3: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} AWS AMER {ENVIRONMENT}'),
  4: step('STEP4: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} OCI AMER {ENVIRONMENT}'),
  5: step('STEP5: QA Validation: CRE {RELEASEVERSION} | APP | AWS/OCI AMER {ENVIRONMENT}'),
};

const MENA_STEPS: Record<number, StepDescription> = {
  1: step('STEP1: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} OCI MENA {ENVIRONMENT}'),
  2: step('STEP2: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} OCI MENA {ENVIRONMENT}'),
  3: step('STEP3: QA Validation: CRE {RELEASEVERSION} | APP | OCI MENA {ENVIRONMENT}'),
};

// UAT and PROD share the same region structure
const SHARED_REGION_CONFIG: RegionConfig = {
  EMEA: { ctasks: { rm: [],  devops: [],         techops: [1, 2],          qa: [3] }, stepDescriptions: EMEA_STEPS },
  AMER: { ctasks: { rm: [],  devops: [],         techops: [0, 1, 2, 3, 4], qa: [5] }, stepDescriptions: AMER_STEPS },
  MENA: { ctasks: { rm: [],  devops: [],         techops: [1, 2],          qa: [3] }, stepDescriptions: MENA_STEPS },
};

export const CTASK_CONFIGURATIONS = {
  environments: {
    SAT: {
      ctasks: { rm: [], devops: [1, 2], techops: [], qa: [] },
      stepDescriptions: {
        1: step('STEP1: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} AWS {ENVIRONMENT} & OCI QA'),
        2: step('STEP2: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} AWS {ENVIRONMENT} & OCI QA'),
      },
    } as CtaskEnvConfig,
    UAT:  SHARED_REGION_CONFIG,
    PROD: SHARED_REGION_CONFIG,
  } as { SAT: CtaskEnvConfig; UAT: RegionConfig; PROD: RegionConfig },

  assignmentGroups: {
    rm:      { name: 'IDT-RELEASE-MGMT-TR', displayName: 'RM'      },
    devops:  { name: 'APP-DEVOPS-IDT',      displayName: 'DevOps'  },
    techops: { name: 'APP-SUPPORT-IDT',     displayName: 'TechOps' },
    qa:      { name: 'APP-IDT-QA',          displayName: 'QA'      },
  },

  assignedTo: { default: 'Radha Krishna Murthy Pachipulusu' },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// CTASK HELPERS  (exported for use in changeRequest_spec.ts)
// ─────────────────────────────────────────────────────────────────────────────

export function getCtaskConfig(env: string, region?: string): CtaskSteps {
  const envs = CTASK_CONFIGURATIONS.environments;
  if (env === 'SAT') return envs.SAT.ctasks;
  const regionMap = envs[env as 'UAT' | 'PROD'];
  if (regionMap && region && regionMap[region as 'EMEA' | 'AMER' | 'MENA']) {
    const base = regionMap[region as 'EMEA' | 'AMER' | 'MENA'].ctasks;
    // Step 0 (Bring Down Services) is only needed for AMER when there are Liquibase
    // schema changes in the release. Pass LIQUIBASE=true to include it; otherwise
    // step 0 is excluded and the deploy starts directly from STEP1.
    if (region === 'AMER' && process.env.LIQUIBASE !== 'true') {
      return { ...base, techops: [...base.techops].filter(s => s !== 0) } as CtaskSteps;
    }
    return base as CtaskSteps;
  }
  console.warn(`CTask config not found for ${env}/${region}, falling back to UAT/EMEA`);
  return envs.UAT.EMEA.ctasks as CtaskSteps;
}

export function getCtaskDescriptions(
  env: string,
  region: string | undefined,
  releaseVersion: string,
  buildVersion: string,
): Record<number, StepDescription> {
  const envs = CTASK_CONFIGURATIONS.environments;
  let raw: Record<number, StepDescription>;

  if (env === 'SAT') {
    raw = envs.SAT.stepDescriptions;
  } else {
    const regionMap = envs[env as 'UAT' | 'PROD'];
    raw = (regionMap && region && regionMap[region as 'EMEA' | 'AMER' | 'MENA'])
      ? regionMap[region as 'EMEA' | 'AMER' | 'MENA'].stepDescriptions
      : envs.UAT.EMEA.stepDescriptions;
  }

  const interpolate = (s: string) =>
    s.replace(/\{RELEASEVERSION\}/g, releaseVersion)
     .replace(/\{BUILDVERSION\}/g,   buildVersion)
     .replace(/\{ENVIRONMENT\}/g,    env)
     .replace(/\{REGION\}/g,         region ?? '');

  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [
      Number(k),
      {
        shortDescription:    interpolate(v.shortDescription),
        detailedDescription: interpolate(v.detailedDescription),
      },
    ]),
  );
}