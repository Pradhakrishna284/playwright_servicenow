/**
 * TEST DATA CONFIGURATION — TDR (Tax Data Repository)
 * =====================================================
 *
 * Single source of truth for all TDR test data.
 * Release dates are loaded from tdr_release_schedule.yaml at startup.
 * Zod validates the YAML — bad formats throw immediately before any browser opens.
 *
 * To update a release: edit tdr_release_schedule.yaml only. No TypeScript changes needed.
 *
 * RELEASE_VERSION must be passed as an environment variable:
 *   $env:RELEASE_VERSION="2026.06.00"; npx playwright test TDR/changeRequest.spec.ts --project=TDR --headed --workers=3
 *
 * All three configs (GENERATE_DUMP_PROD, UAT, QA) are independent Change Requests
 * and can be created in parallel. Use --workers=3 to open all three simultaneously.
 */

import fs   from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface CtaskConfig {
  assignmentGroup:      string;
  assignedTo?:          string;
  shortDescription?:    string;
  detailedDescription?: string;
  plannedStartDate?:    string;  // defaults to CR planned start if not provided
  plannedEndDate?:      string;  // defaults to CR planned end if not provided
}

export interface EnvironmentTestData {
  configName:                string;
  environment:               string;
  configItemText:            string;
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
  additionalApprovalGroups:  string[];
  ctaskConfigs?:             CtaskConfig[];
  changeRequestNumber?:      string;
  createdAt?:                string;
}

interface CrEntry {
  crNumber:       string;
  crUrl:          string;
  crSysId?:       string;
  timestamp:      string;
  configName:     string;
  releaseVersion?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE SCHEDULE LOADER
// ─────────────────────────────────────────────────────────────────────────────

const DateString = z
  .string()
  .regex(/^\d{2}-\d{2}-\d{4}$/, 'Date must be DD-MM-YYYY (e.g. "09-02-2026")');

const ReleaseRowSchema = z.object({
  buildVersion:     z.string().min(1, 'buildVersion is required (e.g. "Build#0")'),
  generateDumpProd: DateString,
  uatDataRefresh:   DateString,
  qaDataRefresh:    DateString,
});

const ScheduleFileSchema = z.object({
  deployment_times: z.object({
    qa_oracle_start:   z.string(),
    qa_oracle_days:    z.number(),
    qa_tdr_start:      z.string(),
    qa_tdr_end:        z.string(),
    uat_oracle_start:  z.string(),
    uat_oracle_days:   z.number(),
    uat_tdr_start:     z.string(),
    uat_tdr_end:       z.string(),
    dump_start:        z.string(),
    dump_end_next_day: z.string(),
  }),
  releases: z.record(
    z.string().regex(/^\d{4}\.\d{2}\.00$/, 'Release version must be YYYY.MM.00'),
    ReleaseRowSchema,
  ),
});

type ReleaseRow    = z.infer<typeof ReleaseRowSchema>;
type DeployTimes   = z.infer<typeof ScheduleFileSchema>['deployment_times'];
type ParsedSchedule = Record<string, ReleaseRow & { deployment_times: DeployTimes }>;

// ─────────────────────────────────────────────────────────────────────────────
// DATE UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

const formatDate = (d: Date): string =>
  `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const parseTime = (t: string): [number, number, number] =>
  t.split(':').map(Number) as [number, number, number];

// Apply a "HH:MM:SS" time string to a date (returns a new Date)
const applyTime = (date: Date, timeStr: string): Date => {
  const result = new Date(date);
  result.setHours(...parseTime(timeStr));
  return result;
};

function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dow = result.getDay();
    if (dow >= 1 && dow <= 5) added++;
  }
  return result;
}

function nextBusinessDay(date: Date): Date {
  const result = new Date(date);
  const dow = result.getDay();
  if (dow === 0) result.setDate(result.getDate() + 1);  // Sunday -> Monday
  if (dow === 6) result.setDate(result.getDate() + 2);  // Saturday -> Monday
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE LOADER
// ─────────────────────────────────────────────────────────────────────────────

function loadReleaseSchedule(): ParsedSchedule {
  const filePath = path.join(__dirname, 'tdr_release_schedule.yaml');
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `❌ tdr_release_schedule.yaml not found at: ${filePath}\n` +
      'Verify __dirname is pointing to the right directory.',
    );
  }
  const result = ScheduleFileSchema.safeParse(yaml.load(fs.readFileSync(filePath, 'utf-8')));
  if (!result.success) {
    const issues = result.error.issues.map(i => `  • [${i.path.join('.')}] ${i.message}`).join('\n');
    throw new Error(`❌ tdr_release_schedule.yaml failed validation:\n${issues}\n\nFix the values and re-run.`);
  }
  const { deployment_times, releases } = result.data;
  const schedule: ParsedSchedule = {};
  for (const [version, row] of Object.entries(releases)) {
    schedule[version] = { ...row, deployment_times };
  }
  return schedule;
}

// Loaded once at module init — YAML errors surface before any test begins
const RELEASE_SCHEDULE = loadReleaseSchedule();

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE DETAILS
// ─────────────────────────────────────────────────────────────────────────────

const RELEASE_DETAILS = {
  version: process.env.RELEASE_VERSION!,

  _getEntry() {
    const entry = RELEASE_SCHEDULE[this.version];
    if (!entry) {
      throw new Error(
        `❌ No schedule entry for release "${this.version}" in tdr_release_schedule.yaml.\n` +
        `Available releases: ${Object.keys(RELEASE_SCHEDULE).join(', ')}`,
      );
    }
    return entry;
  },

  get buildVersion(): string { return this._getEntry().buildVersion; },

  getQADates() {
    const { qaDataRefresh, deployment_times: dt } = this._getEntry();
    const [day, month, year] = qaDataRefresh.split('-').map(Number);
    const oracleStart = new Date(year, month - 1, day, ...parseTime(dt.qa_oracle_start));
    const oracleEnd   = new Date(oracleStart);
    oracleEnd.setDate(oracleEnd.getDate() + dt.qa_oracle_days);
    const tdrStart = applyTime(oracleEnd, dt.qa_tdr_start);
    const tdrEnd   = applyTime(tdrStart,  dt.qa_tdr_end);
    return {
      oracleStartDate: formatDate(oracleStart),
      oracleEndDate:   formatDate(oracleEnd),
      tdrStartDate:    formatDate(tdrStart),
      tdrEndDate:      formatDate(tdrEnd),
    };
  },

  getUATDates() {
    const { uatDataRefresh, deployment_times: dt } = this._getEntry();
    const [day, month, year] = uatDataRefresh.split('-').map(Number);
    const oracleStart = new Date(year, month - 1, day, ...parseTime(dt.uat_oracle_start));
    const oracleEnd   = new Date(oracleStart);
    oracleEnd.setDate(oracleEnd.getDate() + dt.uat_oracle_days);
    const tdrStart = applyTime(nextBusinessDay(oracleEnd), dt.uat_tdr_start);
    const tdrEnd   = applyTime(addBusinessDays(tdrStart, 1), dt.uat_tdr_end);
    return {
      oracleStartDate: formatDate(oracleStart),
      oracleEndDate:   formatDate(oracleEnd),
      tdrStartDate:    formatDate(tdrStart),
      tdrEndDate:      formatDate(tdrEnd),
    };
  },

  getDumpDates() {
    const { generateDumpProd, deployment_times: dt } = this._getEntry();
    const [day, month, year] = generateDumpProd.split('-').map(Number);
    const dumpStart = new Date(year, month - 1, day, ...parseTime(dt.dump_start));
    const dumpEnd   = new Date(dumpStart);
    dumpEnd.setDate(dumpEnd.getDate() + 1);
    dumpEnd.setHours(...parseTime(dt.dump_end_next_day));
    return { startDate: formatDate(dumpStart), endDate: formatDate(dumpEnd) };
  },

  getZipCutoffLabel(): string {
    const { uatDataRefresh } = this._getEntry();
    const [, month] = uatDataRefresh.split('-').map(Number);
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return `${MONTHS[month - 1]} 1st`;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// COMMON CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

export const COMMON_CONSTANTS = {
  categoryValue:               'Enterprise_business_application',
  categoryText:                'Enterprise business application',
  serviceText:                 'ONESOURCE Indirect Tax Data Repository-Preprod',
  assignmentGroupRmText:       'IDT-RELEASE-MGMT-TR',
  assignmentGroupContentText:  'APP-ADMIN-OIT-CONTENT-PROCESSING',
  assignedToRmText:            'Radha Krishna Murthy Pachipulusu',
  assignedToContentText:       'Vetcha Venkata sai',
  timeoutElementVisible: 45_000,
  timeoutAutosuggest:    45_000,
  timeoutPageNav:        60_000,
  timeoutWaitProcessing: 60_000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SHARED CONSTANTS  (people, groups, repeated text)
// ─────────────────────────────────────────────────────────────────────────────

const RM_GROUP       = 'IDT-RELEASE-MGMT-TR';
const ORACLE_GROUP   = 'ORACLE-SUPPORT-TR';
const CONTENT_GROUP  = 'APP-ADMIN-OIT-CONTENT-PROCESSING';
const RM_PERSON      = 'Radha Krishna Murthy Pachipulusu';
const CONTENT_PERSON = 'Vetcha Venkata sai';

// Standard short description pattern: "Tax Data Repository | <version> | <env> <suffix>"
const tdrShortDesc = (releaseVersion: string, env: string, suffix = 'Data Refresh') =>
  `Tax Data Repository | ${releaseVersion} | ${env} ${suffix}`;

// Shared across QA and UAT configs
const SHARED_RISK_ANALYSIS =
  `There will be no impact to customer/CI/Service during this change execution. ` +
  `The business unit (TDR team) is aware of this change and internal UAT application will be down during this change execution.`;

const SHARED_BACKOUT_PLAN =
  `oracle-support-tr will restore the system back with previous day's backup as back out ` +
  `and remove the unzipped copied backup files.`;

const SHARED_TEST_PLAN = [
  `Primary resource: Vetcha.Venkatasai@thomsonreuters.com`,
  `Secondary resource: Dharmalingam.Chinnappan@thomsonreuters.com`,
  `Vetcha.Venkatasai@thomsonreuters.com will confirm once dump files are generated in the said path.`,
].join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// SHARED PLANNING TEXTS  (used by GENERATE_DUMP_PROD)
// ─────────────────────────────────────────────────────────────────────────────

const getPlanningTexts = (environment: string, releaseVersion: string) => ({
  justification: `Tax Data Repository Data Refresh - ${environment} Environment`,

  riskAndImpactAnalysis: [
    `Database refresh operation for ${environment} environment.`,
    `This is a scheduled data refresh task with no impact on production systems.`,
    `The refresh will restore PROD data to ${environment} database.`,
    `Expected downtime: The duration of the dump import process (typically 4-5 hours).`,
    `Risk Level: Medium - Database schemas will be temporarily unavailable during import.`,
    `Mitigation: Refresh is performed during non-business hours to minimize impact.`,
  ].join('\n'),

  backoutPlan: [
    `Backout is not applicable for this change. If the import fails:`,
    `1. Restore from previous database backup`,
    `2. Re-run the import process with corrected parameters`,
    `3. Validate all schemas and data integrity post-import`,
  ].join('\n'),

  testPlan: [
    `Post-implementation validation:`,
    `1. Verify all schemas have been imported successfully`,
    `2. Validate tablespace allocation and disk usage`,
    `3. Verify schema statistics are collected`,
    `4. Test database connectivity and basic queries`,
    `5. Confirm no orphaned connections from previous sessions`,
  ].join('\n'),
});

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY FILE LOCK  (parallel-safe write guard)
// ─────────────────────────────────────────────────────────────────────────────
// TDR runs GENERATE_DUMP_PROD → UAT → QA in mandatory order (not in parallel),
// so registry contention is unlikely in normal use. The lock is included for
// consistency with CRE and to guard against any future parallel invocations.
//
//   LOCK_STALE_MS  – lock older than this is assumed left by a crashed process
//   LOCK_WAIT_MS   – how long to wait before giving up on acquiring the lock
//   LOCK_POLL_MS   – polling interval while waiting

const REGISTRY_LOCK_FILE  = path.join(__dirname, 'change_request_registry.lock');
const REGISTRY_LOCK_STALE = 30_000;  // 30 s
const REGISTRY_LOCK_WAIT  = 20_000;  // 20 s
const REGISTRY_LOCK_POLL  =    200;  // 200 ms

/** Busy-wait until we can acquire the registry lock. Returns a release function. */
async function acquireRegistryLock(): Promise<() => void> {
  const deadline = Date.now() + REGISTRY_LOCK_WAIT;

  while (true) {
    // Remove a stale lock left by a crashed process
    if (fs.existsSync(REGISTRY_LOCK_FILE)) {
      const age = Date.now() - fs.statSync(REGISTRY_LOCK_FILE).mtimeMs;
      if (age > REGISTRY_LOCK_STALE) {
        try { fs.unlinkSync(REGISTRY_LOCK_FILE); } catch { /* race — another process beat us */ }
      }
    }

    // Atomic exclusive create: only the first writer succeeds
    try {
      fs.writeFileSync(REGISTRY_LOCK_FILE, String(process.pid), { flag: 'wx' });
      return () => { try { fs.unlinkSync(REGISTRY_LOCK_FILE); } catch { /* already gone */ } };
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
    }

    if (Date.now() >= deadline) {
      console.warn('⚠ Could not acquire registry lock within timeout — writing anyway');
      return () => { /* no lock to release */ };
    }

    await new Promise(r => setTimeout(r, REGISTRY_LOCK_POLL));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE REQUEST STORAGE
// ─────────────────────────────────────────────────────────────────────────────

export const ChangeRequestStorage = {
  getStoragePath: () => path.join(__dirname, 'change_request_registry.yaml'),

  generateCrUrl(crNumber: string, releaseVersion: string, sysId?: string): string {
    const base       = 'https://trenterprise.service-now.com/change_request.do';
    const listFilter = encodeURIComponent(
      `active=true^short_description>=Tax Data Repository | ${releaseVersion}^ORDERBYshort_description`,
    );
    return sysId
      ? `${base}?sys_id=${sysId}&sysparm_record_target=change_request&sysparm_record_list=${listFilter}`
      : `${base}?sysparm_query=number%3D${crNumber}`;
  },

  loadAll(): Record<string, CrEntry> {
    try {
      const filePath = this.getStoragePath();
      if (fs.existsSync(filePath)) {
        const raw = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
        if (!raw) return {};
        // Support both flat { crNumber: entry } and nested { releaseVersion: { crNumber: entry } }
        const flat: Record<string, CrEntry> = {};
        for (const value of Object.values(raw)) {
          if (value && typeof value === 'object' && 'crNumber' in (value as object)) {
            const entry = value as CrEntry;
            flat[entry.crNumber] = entry;
          } else if (value && typeof value === 'object') {
            for (const inner of Object.values(value as Record<string, unknown>)) {
              if (inner && typeof inner === 'object' && 'crNumber' in (inner as object)) {
                const entry = inner as CrEntry;
                flat[entry.crNumber] = entry;
              }
            }
          }
        }
        return flat;
      }
    } catch {
      console.log('Note: Could not load change request registry, starting fresh');
    }
    return {};
  },

  /**
   * Parallel-safe save: acquires a file lock before the read-modify-write so
   * concurrent workers cannot overwrite each other's registry entries.
   * Writes nested structure: { releaseVersion: { crNumber: entry } } — same as CRE.
   */
  async save(configName: string, crNumber: string, releaseVersion: string, sysId?: string): Promise<void> {
    const release = await acquireRegistryLock();
    try {
      // Read the raw nested YAML (not the flattened loadAll() result)
      const filePath = this.getStoragePath();
      let nested: Record<string, Record<string, CrEntry>> = {};
      try {
        if (fs.existsSync(filePath)) {
          nested = (yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, Record<string, CrEntry>>) ?? {};
        }
      } catch { /* start fresh */ }

      const entry: CrEntry = {
        crNumber,
        crUrl:     this.generateCrUrl(crNumber, releaseVersion, sysId),
        timestamp: new Date().toISOString(),
        configName,
        releaseVersion,
        ...(sysId && { crSysId: sysId }),
      };

      nested[releaseVersion] ??= {};
      nested[releaseVersion][crNumber] = entry;

      fs.writeFileSync(filePath, yaml.dump(nested, { lineWidth: 200 }), 'utf-8');
      console.log(`✓ CR ${crNumber} (${releaseVersion} / ${configName}) saved to registry`);
      if (sysId) console.log(`  Sys ID: ${sysId}`);
    } catch (error) {
      console.error('Error saving change request:', error);
    } finally {
      release();
    }
  },

  getByConfig(configName: string): string | null {
    const registry = this.loadAll();
    const matches = (Object.entries(registry) as [string, CrEntry][])
      .filter(([, data]) => data.configName === configName)
      .sort((a, b) => new Date(b[1].timestamp).getTime() - new Date(a[1].timestamp).getTime());
    return matches.length > 0 ? matches[0][0] : null;
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
// TEST CONFIGURATIONS
// ─────────────────────────────────────────────────────────────────────────────

export const TEST_CONFIGURATIONS: Record<string, EnvironmentTestData> =
  // Guard: only evaluate IIFEs when RELEASE_VERSION is set.
  // riskmanagement.spec.ts imports this module without RELEASE_VERSION — the
  // guard prevents the IIFEs from calling RELEASE_DETAILS.buildVersion and
  // throwing "No schedule entry for release undefined".
  process.env.RELEASE_VERSION ? {

  // ── 1. Generate Dump from PROD ────────────────────────────────────────────
  GENERATE_DUMP_PROD: (() => {
    const releaseVersion = RELEASE_DETAILS.version;
    const buildVersion   = RELEASE_DETAILS.buildVersion;
    const env            = 'PROD';
    const ci             = 'cdp0797a1';
    const dumpDates      = RELEASE_DETAILS.getDumpDates();
    const shortDesc      = tdrShortDesc(releaseVersion, env, 'Generate production dump files for data refresh');
    const detailedDesc   = `This task is to generate new dump files in production environment, before we proceed with UAT data refresh.

Navigate to /orabackup1/backup/production/, and new dump files ("PROD_SBXTAX.dmp" & "PROD_CONTENT.dmp").

a) The "PROD_SBXTAX.dmp" dump file will have the following schemas - 1) SBXTAX, 2) SBXTAX2, 3) SBXTAX3, 4) SBXTAX4, 5) SBXTAX5, 6) CLOUD_INTL, 7) CAAS_US_G2_QA, 8) CAAS_INTL_G2_QA, 9) cloud_global.
b) The "PROD_CONTENT.dmp" dump file will have the following schemas - 1) CONTENT_REPO, 2) CRAPP_ADMIN.`;

    return {
      configName:      'GENERATE_DUMP_PROD',
      environment:     env,
      configItemText:  ci,
      releaseVersion,
      buildVersion,
      plannedStartDate: dumpDates.startDate,
      plannedEndDate:   dumpDates.endDate,

      get shortDescriptionText()      { return shortDesc; },
      get detailedDescriptionText()   { return detailedDesc; },
      get justificationText()         { return `This is monthly activity to refresh the non-production data with production data.`; },
      get implementationPlanText()    { return `oracle-support-tr will perform the activities as mentioned in the change description.`; },
      get riskAndImpactAnalysisText() { return `There will be no impact to customer/CI/Service during this change execution.`; },
      get backoutPlanText()           { return `oracle-support-tr will restore the system back with previous day's backup as back out and remove the unzipped copied backup files.`; },
      get testPlanText()              { return `Primary resource: Vetcha.Venkatasai@thomsonreuters.com\nSecondary resource: Dharmalingam.Chinnappan@thomsonreuters.com\nThe resource will confirm once dump files are generated in the said path.`; },

      additionalApprovalGroups: [CONTENT_GROUP],
      ctaskConfigs: [
        { assignmentGroup: CONTENT_GROUP, assignedTo: CONTENT_PERSON, shortDescription: shortDesc, detailedDescription: detailedDesc, plannedStartDate: dumpDates.startDate, plannedEndDate: dumpDates.endDate },
      ],
    };
  })(),

  // ── 2. UAT Data Refresh ───────────────────────────────────────────────────
  UAT: (() => {
    const releaseVersion = RELEASE_DETAILS.version;
    const buildVersion   = RELEASE_DETAILS.buildVersion;
    const env            = 'UAT';
    const ci             = 'cdu0791a1';
    const uatDates       = RELEASE_DETAILS.getUATDates();
    const zipCutoffLabel = RELEASE_DETAILS.getZipCutoffLabel();
    const shortDesc      = tdrShortDesc(releaseVersion, env);
    const detailedDesc   = `This is to refresh the ${env} instance(${ci}) with the backups from PRODUCTION instance.

✅ Notes for Oracle Support Team (FYI)

The new IP address for UAT instance(cdu0791a1) is "10.226.88.29 "
The new IP address for PROD instance(cdp0797a1) is "10.226.88.40"

1. Disable Archive Logging:- When running the imports, ensure archive logging is disabled.
2. Exclude Statistics:- Exclude statistics during the import process.
3. Cleanup ${env} Location:- Remove existing dump files (zipped and unzipped) from the ${env} location to free up space.
4. Fatal Error During Cloud Global Staging Refresh:- We encountered a fatal error while refreshing cloud global staging, which appears to be not just a space issue.
5. Rule Out Space Issue:-
a) Drop all sbxtax* schemas and cloud_global schemas.
b) Attempt importing cloud_global schema alone.
6. Next Steps if Successful:- If the above import succeeds, proceed with other schemas as listed in the CR.


✅ Pre-requisite: Before we proceed with ${env} instance data refresh, ensure newly generated dump files ("PROD_SBXTAX.dmp" & "PROD_CONTENT.dmp") should exist in source database, i.e. on Production instance(cdp0797a1) in the path /orabackup1/backup/production/

Source DB - Production instance(cdp0797a1)
Target DB - ${env} instance(${ci})

✅ Steps on source DB - Production instance(cdp0797a1):
1. Remove the old zipped files
a) Navigate to /orabackup1/backup/production/
b) Remove the zip files with the naming pattern PROD_CONTENT*.zip and PROD_SBXTAX*.zip with the date older than ${zipCutoffLabel}

2. Zip backups on Production (cdp0797a1)
a) Navigate to /orabackup1/backup/production/
b) Zip PROD_SBXTAX.dmp & PROD_CONTENT.dmp

Steps on target DB - ${env} instance(${ci}):
3. Delete Previous backups
a) Navigate to /orabackup1/oracle_files/backup
b) Delete PROD_SBXTAX*.dmp* & "PROD_CONTENT*.dmp*"

4. Move zipped backup files from Production instance(cdp0797a1) to ${env} instance(${ci})
a) Navigate to /orabackup1/oracle_files/backup on ${env} instance(${ci})
b) Move PROD_SBXTAX.dmp.gz & PROD_CONTENT.dmp.gz from /orabackup1/backup/production/ on Production instance(cdp0797a1) to /orabackup1/oracle_files/backup on ${env} instance(${ci})

5. Move zipped backups files from Production instance(cdp0797a1) to QA instance(cdq0782a1) - This can be run in parallel to any other ${env} steps.
a) Navigate to /orabackup1 on QA instance(cdq0782a1)
b) Move PROD_SBXTAX.dmp.gz & PROD_CONTENT.dmp.gz from /orabackup1/backup/production/ on Production instance(cdp0797a1) to /orabackup1 on QA instance(cdq0782a1)

6. Unzip the dump files on ${env} instance(${ci})
a) After moving the backup files unzip them.

7. Please kill all the active sessions or drop the user/s forcefully.

8. Drop the schemas from ${env} instance(${ci}), if exists - Schemas named content_repo, crapp_admin, sbxtax, sbxtax2, sbxtax3, sbxtax4, sbxtax5, cloud_intl, caas_us_g2_qa, caas_intl_g2_qa, cloud_global

9. Import the schemas from the backups from step 4 into ${env} (${ci})
Note1:- a) Disable Archive Logging:- When running the imports, ensure archive logging is disabled.
        b) Exclude Statistics:- Exclude statistics during the import process.
Note2:- In case of necessity for instance or database reboot of ${env} and QA, you can procced without getting confirmation from Release management or application team
a) "PROD_CONTENT.dmp" will contain schemas content_repo and crapp_admin
b) "PROD_SBXTAX.dmp" will contain schemas sbxtax, sbxtax2, sbxtax3, sbxtax4, sbxtax5, cloud_intl, caas_us_g2_qa, caas_intl_g2_qa, cloud_global

✅ FYI - This step is for letting oracle support team know that the below are corresponding tablespaces for the schemas from the source (production DB)
a) CONTENT_REPO schema is part of tablespace named CONTENT_REPO, JURIS_TAX_APP_CHG, TAX_APP_SET
b) CRAPP_ADMIN schema is part of tablespace named CRAPP_ADMIN
c) SBXTAX, SBXTAX2, SBXTAX3, SBXTAX4, SBXTAX5, CLOUD_INTL, caas_us_g2_qa, caas_intl_g2_qa, cloud_global schemas will be part of tablespace named OSITAX

10. After the successful ${env} refresh, the count of objects in the ${env} instance(${ci}) should match with the count of objects in the production instance(cdp0797a1). Modify accordingly.`;

    return {
      configName:      'UAT',
      environment:     env,
      configItemText:  ci,
      releaseVersion,
      buildVersion,
      plannedStartDate: uatDates.oracleStartDate,
      plannedEndDate:   uatDates.tdrEndDate,

      get shortDescriptionText()      { return shortDesc; },
      get detailedDescriptionText()   { return detailedDesc; },
      get justificationText()         { return `This is monthly activity to refresh the non-production data with production data.`; },
      get implementationPlanText()    { return `oracle-support-tr will perform the activities as mentioned in the change description.`; },
      get riskAndImpactAnalysisText() { return SHARED_RISK_ANALYSIS; },
      get backoutPlanText()           { return SHARED_BACKOUT_PLAN; },
      get testPlanText()              { return SHARED_TEST_PLAN; },

      additionalApprovalGroups: [CONTENT_GROUP, ORACLE_GROUP],
      ctaskConfigs: [
        {
          assignmentGroup:     ORACLE_GROUP,
          assignedTo:          '',
          shortDescription:    shortDesc,
          detailedDescription: detailedDesc,
          plannedStartDate:    uatDates.oracleStartDate,
          plannedEndDate:      uatDates.oracleEndDate,
        },
        {
          assignmentGroup:     CONTENT_GROUP,
          assignedTo:          CONTENT_PERSON,
          shortDescription:    `TDR ${releaseVersion} - Post Refresh validation by TDR Dev team`,
          detailedDescription: [
            `1. Make sure Schemas named content_repo, crapp_admin, sbxtax, sbxtax2, sbxtax3, sbxtax4, sbxtax5, cloud_intl, caas_us_g2_qa, caas_intl_g2_qa, cloud_global are available`,
            `2. Verify, on the QA DB (cdq0782a1), latest "PROD_CONTENT.dmp.gz & PROD_SBXTAX.dmp.gz" files should exist in the path "/orabackup1".`,
            `Venkat Sai Vethca will verify this step to ensure that we have required files in the mentioned path, so that it will not be a blocker for "QA Data Refresh"`,
          ].join('\n'),
          plannedStartDate: uatDates.tdrStartDate,
          plannedEndDate:   uatDates.tdrEndDate,
        },
      ],
    };
  })(),

  // ── 3. QA Data Refresh ────────────────────────────────────────────────────
  QA: (() => {
    const releaseVersion = RELEASE_DETAILS.version;
    const buildVersion   = RELEASE_DETAILS.buildVersion;
    const env            = 'QA';
    const ci             = 'cdq0782a1';
    const qaDates        = RELEASE_DETAILS.getQADates();
    const shortDesc      = tdrShortDesc(releaseVersion, env);
    const detailedDesc   = `This is to refresh the ${env} DB (${ci}) with the backups from path: /orabackup1

✅ Notes for Oracle Support Team (FYI)

The new IP address for QA instance(cdq0782a1) is "10.226.80.61"
The new IP address for PROD instance(cdp0797a1) is "10.226.88.40"

1. Disable Archive Logging: - When running the imports, ensure archive logging is disabled.
2. Exclude Statistics: - Exclude statistics during the import process.
3. Fatal Error During Cloud Global Staging Refresh: - We encountered a fatal error while refreshing cloud global staging, which appears to be not just a space issue.
4. Rule Out Space Issue:- 
a) Drop all sbxtax* schemas and cloud_global schemas.
b) Attempt importing cloud_global schema alone.
5. Next Steps if Successful: - If the above import succeeds, proceed with other schemas as listed in the CR.

Pre-requisite: On the ${env} DB (${ci}), latest "PROD_CONTENT.dmp.gz & PROD_SBXTAX.dmp.gz" files, should exist in the path "/orabackup1".
Note: Zip files have been moved from Production DB (cdp0797a1) to ${env} DB (${ci}) as part of "UAT Data Refresh" change request task.

1. Unzip the dump files on ${env} (${ci}):
   Unzip the compressed dump files PROD_CONTENT.dmp.gz and PROD_SBXTAX.dmp.gz.
2. If exists, drop the schemas sbxtax, sbxtax2, sbxtax3, sbxtax4, sbxtax5, CLOUD_INTL, CAAS_US_G2_QA, CAAS_INTL_G2_QA from ${env} (${ci}).
   a) we approve force dropping the schemas by killing any active sessions.
3. Import the schemas sbxtax, sbxtax2, sbxtax3, sbxtax4, sbxtax5, CLOUD_INTL, CAAS_US_G2_QA, CAAS_INTL_G2_QA, cloud_global using the dump file named PROD_SBXTAX.dmp.
   a) PROD_SBXTAX.dmp will contain schemas sbxtax, sbxtax2, sbxtax3, sbxtax4, sbxtax5, CLOUD_INTL, CAAS_US_G2_QA, CAAS_INTL_G2_QA.
   b) SBXTAX, SBXTAX2, SBXTAX3, SBXTAX4, SBXTAX5, CLOUD_INTL, CAAS_US_G2_QA, CAAS_INTL_G2_QA schemas will be part of tablespace named OSITAX.
4. Drop the schemas content_repo and crapp_admin from ${env} (${ci}).
   a) we approve force dropping the schemas by killing any active sessions.
5. Import the schemas content_repo and crapp_admin using the dump file named PROD_CONTENT.dmp.
   a) This is big import, If it is okay, you can use exclude stats during the import and gather schema stats after the import is completed. That way this step will go faster. But we will let you decide and handle as it works.
   b) PROD_CONTENT.dmp will contain schemas content_repo and crapp_admin.
   c) CONTENT_REPO schema is part of tablespace named CONTENT_REPO, JURIS_TAX_APP_CHG, TAX_APP_SET.
   d) CRAPP_ADMIN schema is part of tablespace named CRAPP_ADMIN.

Note 1: Step 4 and 5 can be executed in parallel to Step 2 and 3.
Note 2: The schema names and tablespace names are same in PRODUCTION DB and ${env} DB.
Note 3: Content_repo schema may take 5 hours or more.
crapp_admin schema may take 10 minutes.
sbxtax* schemas may take 4 hours.

######################################### DBA Note #################################################
Once the refresh activity completed enable archive logging which disable before the start of the activity and also validate it.
###################################################################################################`;

    return {
      configName:      'QA',
      environment:     env,
      configItemText:  ci,
      releaseVersion,
      buildVersion,
      plannedStartDate: qaDates.oracleStartDate,
      plannedEndDate:   qaDates.tdrEndDate,

      get shortDescriptionText()      { return shortDesc; },
      get detailedDescriptionText()   { return detailedDesc; },
      get justificationText()         { return `To refresh QA Refresh for testing with latest data`; },
      get implementationPlanText()    { return `Oracle Support TR will zip the backups from Production, move them to QA instance, unzip them`; },
      get riskAndImpactAnalysisText() { return SHARED_RISK_ANALYSIS; },
      get backoutPlanText()           { return SHARED_BACKOUT_PLAN; },
      get testPlanText()              { return SHARED_TEST_PLAN; },

      additionalApprovalGroups: [CONTENT_GROUP, ORACLE_GROUP],
      ctaskConfigs: [
        {
          assignmentGroup:     ORACLE_GROUP,
          assignedTo:          '',
          shortDescription:    shortDesc,
          detailedDescription: detailedDesc,
          plannedStartDate:    qaDates.oracleStartDate,
          plannedEndDate:      qaDates.oracleEndDate,
        },
        {
          assignmentGroup:     CONTENT_GROUP,
          assignedTo:          CONTENT_PERSON,
          shortDescription:    `TDR ${releaseVersion} - Post Refresh validations by TDR Dev team`,
          detailedDescription: [
            `TDR ${releaseVersion} - Post Refresh validation by TDR Dev team`,
            `1. Make sure the following schemas are available: 1) content_repo, 2) crapp_admin, 3) SBXTAX, 4) SBXTAX2, 5) SBXTAX3, 6) SBXTAX4, 7) SBXTAX5, 8) CLOUD_INTL, 9) CAAS_US_G2_QA, 10) CAAS_INTL_G2_QA, 11) cloud_global`,
            `2. TDR - QA application should be up and running`,
          ].join('\n'),
          plannedStartDate: qaDates.tdrStartDate,
          plannedEndDate:   qaDates.tdrEndDate,
        },
      ],
    };
  })(),
} : {};

// ─────────────────────────────────────────────────────────────────────────────
// PARALLEL EXECUTION — all 3 configs are independent Change Requests
// Each test gets its own browser worker; dates are set independently in the YAML.
// Use Object.entries(TEST_CONFIGURATIONS) in the spec (same pattern as CRE).
// The ordered array is kept as an alias so any existing code that imports it
// continues to work without changes.
// ─────────────────────────────────────────────────────────────────────────────
export const TEST_CONFIGURATIONS_ORDERED: [string, EnvironmentTestData][] =
  Object.entries(TEST_CONFIGURATIONS) as [string, EnvironmentTestData][];