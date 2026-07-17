# Scripts Directory

This directory contains automation scripts for managing test configurations and releases.

## Available Scripts

### updateReleaseConfig.js (Recommended)

**Purpose:** Automatically updates release version and deployment dates in testDataConfig_CRE.ts

**Usage:**
```bash
npm run update-release 2026.03.00
```

Or directly:
```bash
node scripts/updateReleaseConfig.js 2026.03.00
```

**What it does:**
1. Reads deployment dates from `2026_Release_Schedule.xlsx`
2. Updates `RELEASE_DETAILS.version` in testDataConfig_CRE.ts
3. Updates all 5 deployment windows: SAT, UAT_EMEA, UAT_AMER, PROD_EMEA, PROD_AMER

**Example Output:**
```
📋 Release Version: 2026.03.00
🔍 Reading deployment schedule from Excel...

✅ Files found
📄 Reading from sheet: Sheet1
✅ Deployment dates found:
   SAT:       13-02-2026
   UAT_EMEA:  25-02-2026
   UAT_AMER:  26-02-2026
   PROD_EMEA: 04-03-2026
   PROD_AMER: 05-03-2026

✅ Successfully updated testDataConfig_CRE.ts
📝 Updated version: 2026.03.00
🎉 All deployment windows updated!
```

---

### updateReleaseConfig.ts

**Purpose:** TypeScript version of the update script (requires ts-node)

**Usage:**
```bash
npx ts-node scripts/updateReleaseConfig.ts 2026.03.00
```

**Difference from .js version:**
- Type-safe implementation
- Better for TypeScript projects
- Requires additional TypeScript dependencies

---

## NPM Scripts

Add to your `package.json` scripts section:

```json
"scripts": {
  "update-release": "node scripts/updateReleaseConfig.js"
}
```

Then use:
```bash
npm run update-release 2026.03.00
```

---

## Requirements

### Dependencies
- `xlsx` - For reading Excel files (auto-installed if missing)
- `node` - v14+ recommended

### Files Required
- `../../tests/2026_Release_Schedule.xlsx` - Release schedule with deployment dates
- `../../tests/CRE/testDataConfig_CRE.ts` - Configuration file to update

---

## Excel File Structure

The `2026_Release_Schedule.xlsx` file should follow this format:

```
┌─────────────────────────────────────────────────────────┐
│ Column A  │ Column B  │ Column C  │ ... │ Column E     │
├─────────────────────────────────────────────────────────┤
│ Release   │ SAT       │ UAT_EMEA  │ ... │ PROD_AMER   │
│ Version   │           │           │     │              │
├─────────────────────────────────────────────────────────┤
│ 2026.01.00│ 2026-01-10│ 2026-01-15│ ... │ 2026-01-21  │
│ 2026.02.00│ 2026-02-10│ 2026-02-18│ ... │ 2026-02-26  │
│ 2026.03.00│ 2026-03-10│ 2026-03-18│ ... │ 2026-03-26  │
│ 2026.04.00│ 2026-04-10│ 2026-04-18│ ... │ 2026-04-26  │
└─────────────────────────────────────────────────────────┘
```

**Requirements:**
- First row must contain headers: `Release Version`, `SAT`, `UAT_EMEA`, `UAT_AMER`, `PROD_EMEA`, `PROD_AMER`
- First column contains release versions in format `YYYY.MM.00`
- Date values can be in any standard date format
- All 5 environments must have dates for each release version

---

## Config File Structure

The script updates `testDataConfig_CRE.ts` in this section:

```typescript
const RELEASE_DETAILS = {
  version: '2026.03.00',  // ← Updated here
  buildVersion: 'Build#0',
  // ... other properties ...
  
  deploymentWindows: {
    SAT: createDeploymentWindow('13-02-2026'),         // ← Updated here
    UAT_EMEA: createDeploymentWindow('25-02-2026'),    // ← Updated here
    UAT_AMER: createDeploymentWindow('26-02-2026'),    // ← Updated here
    PROD_EMEA: createDeploymentWindow('04-03-2026'),   // ← Updated here
    PROD_AMER: createDeploymentWindow('05-03-2026'),   // ← Updated here
  },
};
```

Each deployment window is automatically formatted with:
- Start time: `16:20:00`
- End time: `23:30:00`

---

## Common Commands

### Update to latest release
```bash
npm run update-release 2026.03.00
```

### Update with version validation
The script automatically validates:
- Version format: `YYYY.MM.00`
- Release version exists in Excel
- All 5 environments have dates

### Batch update (multiple releases)
```bash
npm run update-release 2026.03.00
npm run update-release 2026.04.00
npm run update-release 2026.05.00
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `XLSX is not defined` | Run `npm install xlsx` |
| `File not found` | Ensure you're in project root and Excel file exists at `tests/2026_Release_Schedule.xlsx` |
| `Invalid version format` | Use format `YYYY.MM.00` (e.g., `2026.03.00`) |
| `Release version not found` | Check Excel file contains the release version in first column |
| `Module not found` | Run `npm install` to install all dependencies |

---

## Features

✅ **Automatic Date Formatting** - Converts any date format to `DD-MM-YYYY`

✅ **Validation** - Checks version format and finds all required environments

✅ **Error Messages** - Clear, actionable error messages for debugging

✅ **Automatic Dependencies** - Installs `xlsx` if not present

✅ **Single Command** - One-line release updates: `npm run update-release 2026.03.00`

✅ **Safe Updates** - Only modifies version and deployment windows, preserves all other config

---

## Version History

| Version | Changes |
|---------|---------|
| 1.0 | Initial release with JS and TS versions |

---

## Future Enhancements

- [ ] Support for updating buildVersion from Excel
- [ ] Backup creation before updates
- [ ] Batch mode for updating multiple releases
- [ ] Validation report generation
- [ ] Dry-run mode to preview changes

---

## Support & Feedback

For detailed usage information, see: [RELEASE_CONFIG_UPDATER_GUIDE.md](../RELEASE_CONFIG_UPDATER_GUIDE.md)
