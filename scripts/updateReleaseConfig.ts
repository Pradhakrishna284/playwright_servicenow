#!/usr/bin/env node

/**
 * RELEASE CONFIGURATION UPDATER
 * =============================
 * 
 * Purpose: Updates RELEASE_DETAILS and deploymentWindows in testDataConfig_CRE.ts
 *          based on deployment dates from 2026_Release_Schedule.xlsx
 * 
 * Usage: npx ts-node scripts/updateReleaseConfig.ts 2026.03.00
 * 
 * What it does:
 * 1. Takes a release version as command-line argument (e.g., 2026.03.00)
 * 2. Reads the 2026_Release_Schedule.xlsx file
 * 3. Finds the deployment dates for SAT, UAT_EMEA, UAT_AMER, PROD_EMEA, PROD_AMER
 * 4. Updates the testDataConfig_CRE.ts file with new version and deployment windows
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Get release version from command line arguments
const releaseVersion = process.argv[2];

if (!releaseVersion) {
  console.error('❌ Error: Release version is required!');
  console.error('Usage: npx ts-node scripts/updateReleaseConfig.ts 2026.03.00');
  process.exit(1);
}

// Validate version format (YYYY.MM.00)
if (!/^\d{4}\.\d{2}\.\d{2}$/.test(releaseVersion)) {
  console.error(`❌ Error: Invalid version format "${releaseVersion}". Expected format: YYYY.MM.00`);
  process.exit(1);
}

console.log(`📋 Release Version: ${releaseVersion}`);
console.log('🔍 Reading deployment schedule from Excel...\n');

// ==================== INSTALLATION CHECK ====================
function ensureXlsxInstalled() {
  try {
    require('xlsx');
  } catch {
    console.log('📦 Installing xlsx package...');
    try {
      execSync('npm install xlsx --save', { stdio: 'inherit' });
    } catch (error) {
      console.error('❌ Failed to install xlsx package');
      process.exit(1);
    }
  }
}

// ==================== MAIN SCRIPT ====================
async function main() {
  try {
    ensureXlsxInstalled();
    
    const XLSX = require('xlsx');
    
    // Paths
    const excelPath = path.join(__dirname, '../tests/CRE_2026_Release Schedule.xlsx');
    const configPath = path.join(__dirname, '../tests/CRE/testDataConfig_CRE.ts');
    
    // Check file existence
    if (!fs.existsSync(excelPath)) {
      throw new Error(`Excel file not found: ${excelPath}`);
    }
    
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    
    // Read Excel file
    const workbook = XLSX.readFile(excelPath);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    
    if (!worksheet) {
      throw new Error('No worksheets found in Excel file');
    }
    
    console.log(`📄 Reading from sheet: ${workbook.SheetNames[0]}`);
    
    // Parse Excel data
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[];
    
    if (!data || data.length === 0) {
      throw new Error('Excel file is empty');
    }
    
    // Find the row matching the release version
    // Expected format: First column = Release Version, Then columns for each environment
    const deploymentDates = findDeploymentDates(data, releaseVersion);
    
    if (!deploymentDates) {
      throw new Error(`Release version "${releaseVersion}" not found in Excel file`);
    }
    
    console.log('✅ Deployment dates found:');
    console.log(`   SAT:       ${deploymentDates.SAT}`);
    console.log(`   UAT_EMEA:  ${deploymentDates.UAT_EMEA}`);
    console.log(`   UAT_AMER:  ${deploymentDates.UAT_AMER}`);
    console.log(`   PROD_EMEA: ${deploymentDates.PROD_EMEA}`);
    console.log(`   PROD_AMER: ${deploymentDates.PROD_AMER}\n`);
    
    // Update the config file
    updateConfigFile(configPath, releaseVersion, deploymentDates);
    
    console.log('✅ Successfully updated testDataConfig_CRE.ts');
    console.log(`📝 Updated version: ${releaseVersion}`);
    console.log('🎉 All deployment windows updated!\n');
    
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Finds deployment dates for a specific release version in Excel data
 * Handles Excel format with:
 * - Column 0: Release Version (e.g., "CRE 2026.03.00")
 * - Columns for SAT APP, UAT EMEA, UAT AMER, PROD EMEA, PROD AMER
 */
function findDeploymentDates(
  data: any[],
  releaseVersion: string
): Record<string, string> | null {
  // Define which columns contain the environment dates
  // Based on Excel header structure
  const columnMap: Record<string, number> = {
    SAT: 8,           // Column H: SAT APP
    UAT_EMEA: 11,     // Column K: UAT EMEA
    UAT_AMER: 12,     // Column L: UAT AMER
    PROD_EMEA: 14,    // Column N: PROD EMEA
    PROD_AMER: 15     // Column O: PROD AMER
  };
  
  // Find the row with matching release version
  // Release versions in Excel are prefixed with "CRE " (e.g., "CRE 2026.03.00")
  const searchVersion = `CRE ${releaseVersion}`;
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!Array.isArray(row)) continue;
    
    // Check first column for release version
    const versionCell = String(row[0] || '').trim();
    
    if (versionCell === searchVersion) {
      // Extract dates for all environments
      const result: Record<string, string> = {};
      
      Object.entries(columnMap).forEach(([env, colIndex]) => {
        if (colIndex < row.length) {
          const dateValue = row[colIndex];
          const formattedDate = formatDateForConfig(dateValue);
          if (formattedDate) {
            result[env] = formattedDate;
          }
        }
      });
      
      // Verify we found all required dates
      if (Object.keys(result).length === 5) {
        return result;
      }
    }
  }
  
  return null;
}

/**
 * Formats Excel date to DD-MM-YYYY format
 * Handles both Excel serial numbers and string dates
 */
function formatDateForConfig(dateValue: any): string | null {
  if (!dateValue) return null;
  
  let date: Date;
  
  // Excel stores dates as serial numbers (days since 1899-12-30)
  // 25569 = number of days between 1899-12-30 (Excel epoch) and 1970-01-01 (Unix epoch)
  if (typeof dateValue === 'number') {
    // Convert Excel serial date to JavaScript Date
    date = new Date((dateValue - 25569) * 24 * 60 * 60 * 1000);
  } else {
    // Try to parse as string
    const parsed = new Date(dateValue);
    if (isNaN(parsed.getTime())) {
      return null;
    }
    date = parsed;
  }
  
  // Format as DD-MM-YYYY
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  
  return `${day}-${month}-${year}`;
}

/**
 * Updates the testDataConfig_CRE.ts file with new version and deployment dates
 */
function updateConfigFile(
  configPath: string,
  releaseVersion: string,
  deploymentDates: Record<string, string>
): void {
  let content = fs.readFileSync(configPath, 'utf-8');
  
  // Update version
  content = content.replace(
    /version:\s*'[^']*'/,
    `version: '${releaseVersion}'`
  );
  
  // Update deployment windows
  const environments = ['SAT', 'UAT_EMEA', 'UAT_AMER', 'PROD_EMEA', 'PROD_AMER'];
  
  environments.forEach(env => {
    const date = deploymentDates[env];
    if (date) {
      // Replace the createDeploymentWindow call for this environment
      const pattern = new RegExp(
        `${env}:\\s*createDeploymentWindow\\('[^']*'\\)`,
        'g'
      );
      content = content.replace(pattern, `${env}: createDeploymentWindow('${date}')`);
    }
  });
  
  // Write back to file
  fs.writeFileSync(configPath, content, 'utf-8');
}

// Run the main function
main();
