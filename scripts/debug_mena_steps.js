'use strict';
const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const RELEASE_VERSION = process.env.RELEASE_VERSION || '2026.05.00';
const scheduleFile    = path.join(__dirname, '../tests/CRE/cre_release_schedule.yaml');
const schedule        = yaml.load(fs.readFileSync(scheduleFile, 'utf-8'));
const row             = schedule.releases[RELEASE_VERSION];

if (!row) {
  console.error(`No entry for release "${RELEASE_VERSION}" in cre_release_schedule.yaml`);
  process.exit(1);
}

const BUILD_VERSION = row.buildVersion;
const { start, end } = schedule.deployment_times;

const SHAREPOINT_BASE  = 'https://trten.sharepoint.com/sites/IndirectTaxReleaseManagement/SitePages/';
const releaseBranchUrl = v =>
  `${SHAREPOINT_BASE}Content%20Rate%20Extract%20Cloud%20Release%20Branch%20Summary%20-%20CRE%20${v}.aspx`;

const CTASK_FOOTER =
  '\nFor Git Hashes and Artifacts, please refer to this link ' +
  "[In the table 'CRE Cloud {RELEASEVERSION}', Under the section '{ENVIRONMENT} Deployment : {BUILDVERSION}']\n";

const GROUPS = {
  rm:      'IDT-RELEASE-MGMT-TR',
  devops:  'APP-DEVOPS-IDT',
  techops: 'APP-SUPPORT-IDT',
  qa:      'APP-IDT-QA',
};

function ip(s, env, release, build) {
  return s
    .replace(/\{RELEASEVERSION\}/g, release)
    .replace(/\{BUILDVERSION\}/g,   build)
    .replace(/\{ENVIRONMENT\}/g,    env);
}

const CONFIGS = [
  {
    configName: 'SAT', env: 'SAT', region: null, cloud: 'AWS', approvalGroup: 'APP-DEVOPS-IDT',
    ctasks: { rm: [], devops: [1, 2], techops: [], qa: [] },
    steps: {
      1: 'STEP1: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} AWS {ENVIRONMENT} & OCI QA',
      2: 'STEP2: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} AWS {ENVIRONMENT} & OCI QA',
    },
  },
  {
    configName: 'UAT_EMEA', env: 'UAT', region: 'EMEA', cloud: 'AWS', approvalGroup: 'APP-SUPPORT-IDT',
    ctasks: { rm: [], devops: [], techops: [1, 2], qa: [3] },
    steps: {
      1: 'STEP1: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} AWS EMEA {ENVIRONMENT}',
      2: 'STEP2: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} AWS EMEA {ENVIRONMENT}',
      3: 'STEP3: QA Validation: CRE {RELEASEVERSION} | APP | AWS EMEA {ENVIRONMENT}',
    },
  },
  {
    configName: 'UAT_AMER', env: 'UAT', region: 'AMER', cloud: 'AWS/OCI', approvalGroup: 'APP-SUPPORT-IDT',
    ctasks: { rm: [], devops: [], techops: [1, 2, 3, 4], qa: [5] },
    steps: {
      1: 'STEP1: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} AWS AMER {ENVIRONMENT}',
      2: 'STEP2: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} OCI AMER {ENVIRONMENT}',
      3: 'STEP3: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} AWS AMER {ENVIRONMENT}',
      4: 'STEP4: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} OCI AMER {ENVIRONMENT}',
      5: 'STEP5: QA Validation: CRE {RELEASEVERSION} | APP | AWS/OCI AMER {ENVIRONMENT}',
    },
  },
  {
    configName: 'UAT_MENA', env: 'UAT', region: 'MENA', cloud: 'OCI', approvalGroup: 'APP-SUPPORT-IDT',
    ctasks: { rm: [], devops: [], techops: [1, 2], qa: [3] },
    steps: {
      1: 'STEP1: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} OCI MENA {ENVIRONMENT}',
      2: 'STEP2: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} OCI MENA {ENVIRONMENT}',
      3: 'STEP3: QA Validation: CRE {RELEASEVERSION} | APP | OCI MENA {ENVIRONMENT}',
    },
  },
  {
    configName: 'PROD_EMEA', env: 'PROD', region: 'EMEA', cloud: 'AWS', approvalGroup: 'APP-SUPPORT-IDT',
    ctasks: { rm: [], devops: [], techops: [1, 2], qa: [3] },
    steps: {
      1: 'STEP1: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} AWS EMEA {ENVIRONMENT}',
      2: 'STEP2: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} AWS EMEA {ENVIRONMENT}',
      3: 'STEP3: QA Validation: CRE {RELEASEVERSION} | APP | AWS EMEA {ENVIRONMENT}',
    },
  },
  {
    configName: 'PROD_AMER', env: 'PROD', region: 'AMER', cloud: 'AWS/OCI', approvalGroup: 'APP-SUPPORT-IDT',
    ctasks: { rm: [], devops: [], techops: [1, 2, 3, 4], qa: [5] },
    steps: {
      1: 'STEP1: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} AWS AMER {ENVIRONMENT}',
      2: 'STEP2: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} OCI AMER {ENVIRONMENT}',
      3: 'STEP3: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} AWS AMER {ENVIRONMENT}',
      4: 'STEP4: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} OCI AMER {ENVIRONMENT}',
      5: 'STEP5: QA Validation: CRE {RELEASEVERSION} | APP | AWS/OCI AMER {ENVIRONMENT}',
    },
  },
  {
    configName: 'PROD_MENA', env: 'PROD', region: 'MENA', cloud: 'OCI', approvalGroup: 'APP-SUPPORT-IDT',
    ctasks: { rm: [], devops: [], techops: [1, 2], qa: [3] },
    steps: {
      1: 'STEP1: Deploy a208263_ocre-app-ce-stg-sdm LB changes to CRE {RELEASEVERSION} OCI MENA {ENVIRONMENT}',
      2: 'STEP2: Deploy a208263_ocre-app-ce-stg-sdm APP changes to CRE {RELEASEVERSION} OCI MENA {ENVIRONMENT}',
      3: 'STEP3: QA Validation: CRE {RELEASEVERSION} | APP | OCI MENA {ENVIRONMENT}',
    },
  },
];

const SEP = '='.repeat(80);

for (const cfg of CONFIGS) {
  const { configName, env, region, cloud, ctasks, steps } = cfg;
  const date        = row[configName];
  const regionLabel = region || '--';

  const roleOf = n => {
    if (ctasks.rm.includes(n))      return 'RM';
    if (ctasks.devops.includes(n))  return 'DEVOPS';
    if (ctasks.techops.includes(n)) return 'TECHOPS';
    if (ctasks.qa.includes(n))      return 'QA';
  };

  const allSteps = [...new Set([
    ...ctasks.rm, ...ctasks.devops, ...ctasks.techops, ...ctasks.qa,
  ])].sort((a, b) => a - b);

  console.log('\n' + SEP);
  console.log(` ${configName}   env:${env}   region:${regionLabel}   cloud:${cloud}   date:${date}`);
  console.log(SEP);

  for (const n of allSteps) {
    const role  = roleOf(n);
    const group = GROUPS[role.toLowerCase()];
    const short = ip(steps[n], env, RELEASE_VERSION, BUILD_VERSION);
    console.log(`  [CTASK ${n}]  Role: ${role.padEnd(8)}  Group: ${group}`);
    console.log(`  Short Desc : ${short}`);
    console.log('');
  }
}

console.log(SEP);
console.log(' Done.');
console.log(SEP);
