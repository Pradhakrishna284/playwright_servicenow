/**
 * SSO SETUP — runs ONCE to capture authenticated session into auth_servicenow.json
 * =====================================================================
 *
 * FILE LOCATION:
 *   auth_servicenow.json is written to the PROJECT ROOT (one level above this file)
 *   (i.e. playwright_servicenow/auth_servicenow.json), which matches the storageState path
 *   (playwright.config.ts lives at root so __dirname there = root, no subdir needed).
 *   
 *
 * SESSION LIFETIME: 2 hours
 *   auth_servicenow.json is reused for 2 hours from the time it was created.
 *   After 2 hours the session is considered stale and this setup must be re-run.
 *   The script checks the age automatically — if still fresh it skips login entirely.
 *   (PingID sessions can expire in ~3 hours of inactivity; 2 h is a safe conservative threshold.)
 *
 * PARALLEL-SAFE LOCK:
 *   A .lock file prevents two concurrent sso_setup invocations from racing to
 *   write auth_servicenow.json at the same time. The second process waits up to
 *   90 s for the first to finish, then reads the freshly-written session file.
 *
 * WHEN TO RE-RUN:
 *   • First time setting up on a new machine
 *   • auth_servicenow.json does not exist
 *   • auth_servicenow.json is older than 2 hours
 *   • You see an "auth_servicenow.json is stale" warning in the console
 *   • Tests fail with a redirect to the SSO login page
 *
 * USAGE:
 *   npx playwright test sso_setup.ts --project=setup --headed
 *
 * CREDENTIALS — read from .env file (never hardcode here):
 *   SSO_USERNAME=YOUR_EMPLOYEE_ID
 *   SSO_PASSWORD=YOUR_SSO_PASSWORD
 *   SSO_URL=https://sso.thomsonreuters.com/idp/SSO.saml2
 *
 * After this runs successfully, all test workers reuse auth_servicenow.json —
 * no per-test SSO login needed.
 */

import { test as setup, expect } from '@playwright/test';
import path from 'path';
import fs   from 'fs';

// ─── paths ───────────────────────────────────────────────────────────────────
// sso_setup.ts lives in tests/ so __dirname = tests/.
// storageState: path.join(__dirname, '..', 'auth_servicenow.json') in the config
// reads from (its __dirname = root, so no subdir needed).
const AUTH_FILE = path.join(__dirname, '..', 'auth_servicenow.json');
const LOCK_FILE = path.join(__dirname, '..', 'auth_servicenow.lock');

// ─── timing constants ────────────────────────────────────────────────────────
const AUTH_MAX_AGE_MS  = 2 * 60 * 60 * 1000; // 2 hours — conservative PingID session window
const LOCK_WAIT_MS     = 90_000;              // max time to wait for another process's lock
const LOCK_POLL_MS     = 500;                 // how often to poll the lock file
const LOCK_STALE_MS    = 5 * 60 * 1000;      // lock older than 5 min → treat as stale/crashed

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Returns true when auth_servicenow.json exists AND is younger than AUTH_MAX_AGE_MS */
function isSessionFresh(): boolean {
  if (!fs.existsSync(AUTH_FILE)) return false;
  const age = Date.now() - fs.statSync(AUTH_FILE).mtimeMs;
  return age < AUTH_MAX_AGE_MS;
}

/**
 * Acquires an exclusive file lock.
 * Returns false immediately if another non-stale lock is held.
 * Returns true when we successfully wrote our own lock.
 */
function acquireLock(): boolean {
  if (fs.existsSync(LOCK_FILE)) {
    const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (lockAge < LOCK_STALE_MS) {
      return false; // another process holds a fresh lock
    }
    // Stale lock left by a crashed process — remove it
    console.log('⚠ Stale lock file found — removing and proceeding');
    fs.unlinkSync(LOCK_FILE);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');
  return true;
}

function releaseLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

/**
 * Waits up to LOCK_WAIT_MS for another process to release its lock.
 * Returns true once the session file is available (or the lock is gone).
 * Returns false on timeout.
 */
async function waitForLock(): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, LOCK_POLL_MS));

    if (!fs.existsSync(LOCK_FILE)) {
      // Lock gone — check whether the session was successfully written
      return isSessionFresh();
    }

    const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (lockAge >= LOCK_STALE_MS) {
      console.log('⚠ Lock became stale while waiting — assuming the other process crashed');
      return false; // caller will retry the full login
    }
  }
  console.error('❌ Timed out waiting for SSO lock to be released');
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// SETUP TEST
// ─────────────────────────────────────────────────────────────────────────────

setup('Authenticate via SSO/PingID', async ({ page }) => {
  setup.setTimeout(180_000); // 3 min — allows time for slow SSO page + PingID MFA approval

  // ── Fast path: session already fresh ──────────────────────────────────────
  if (isSessionFresh()) {
    const age = Date.now() - fs.statSync(AUTH_FILE).mtimeMs;
    console.log(`✓ auth_servicenow.json is fresh (${Math.round(age / 60_000)}m old) — skipping SSO login`);
    return;
  }

  // ── Slow path: try to acquire the write lock ───────────────────────────────
  if (!acquireLock()) {
    console.log('⏳ Another process is authenticating — waiting for auth_servicenow.json…');
    const ok = await waitForLock();
    if (ok) {
      console.log('✓ Session file written by peer process — skipping our own SSO login');
      return;
    }
    // Peer timed out / crashed — we fall through and do the login ourselves
    console.log('⚠ Peer process did not produce a valid session — attempting our own login');
  }

  // ── We hold the lock — proceed with the full SSO login ────────────────────
  try {
    if (fs.existsSync(AUTH_FILE)) {
      console.log('⚠ auth_servicenow.json is stale — re-authenticating…');
    }

    const ssoUsername = process.env.SSO_USERNAME;
    const ssoPassword = process.env.SSO_PASSWORD;
    const ssoUrl      = process.env.SSO_URL;

    const missing = [
      !ssoUsername && 'SSO_USERNAME',
      !ssoPassword && 'SSO_PASSWORD',
      !ssoUrl      && 'SSO_URL',
    ].filter(Boolean);

    if (missing.length) {
      // No .env credentials → interactive/manual fallback:
      // open the browser, let ServiceNow redirect to SSO, and wait for the user
      // to complete the full login (credentials + PingID MFA) themselves.
      // This covers the common case where a user skips the explicit SSO setup
      // step and runs a test project directly for the first time.
      setup.setTimeout(180_000); // 3 min total — 2 min for login + buffer
      console.log(`⚠ .env credentials not set (${missing.join(', ')}) — switching to interactive mode.`);
      console.log('👉 A browser window will open. Please complete the SSO login (including PingID MFA) manually…');

      await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForLoadState('domcontentloaded');

      console.log('⏳ Waiting for you to complete SSO authentication (up to 2 minutes)…');
      await page.waitForURL(/trenterprisedev\.service-now\.com/, { timeout: 120_000, waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('domcontentloaded');
      console.log('✓ SSO login complete — saving session…');

      await page.context().storageState({ path: AUTH_FILE });
      console.log(`✓ Session saved to ${AUTH_FILE} (valid for 8 hours)`);
      return; // skip the auto-fill code path below; finally{} still runs → lock released
    }

    // Navigate to the app — ServiceNow will redirect to SSO login page
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 120_000 });

    // Wait for redirect to SSO domain
    const ssoHostname = new URL(ssoUrl!).hostname;
    await expect(page).toHaveURL(new RegExp(ssoHostname), { timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');
    console.log('✓ Redirected to SSO login page');

    // Fill credentials
    await page.locator('#username').click();
    await page.locator('#username').type(ssoUsername!, { delay: 50 });
    await page.locator('#password').click();
    await page.locator('#password').type(ssoPassword!, { delay: 50 });
    await page.waitForTimeout(500);
    await page.locator('#signOnButton').click();
    await page.waitForLoadState('domcontentloaded');
    console.log('✓ Credentials submitted');

    // Wait for redirect to ServiceNow (dev environment skips PingID MFA)
    console.log('⏳ Waiting for redirect to ServiceNow…');
    await page.waitForURL(/trenterprisedev\.service-now\.com/, { timeout: 30_000, waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');
    console.log('✓ SSO authentication successful');

    await expect(page).toHaveURL(/trenterprisedev\.service-now\.com/);

    // Save the authenticated session — all workers will reuse this
    await page.context().storageState({ path: AUTH_FILE });
    console.log(`✓ Session saved to ${AUTH_FILE}`);

  } finally {
    // Always release the lock, even if login failed
    releaseLock();
  }
});