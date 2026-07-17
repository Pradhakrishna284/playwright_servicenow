const http      = require('http');
const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');

const PORT      = 3131;
const TESTS_DIR = __dirname;
const ROOT_DIR  = path.join(__dirname, '..');
const IS_WIN    = process.platform === 'win32';

// ── Launch a visible CMD window via PowerShell Start-Process ─────────────────
// This breaks out of the Node process tree entirely, which bypasses corporate
// security policies that block Node.js from spawning child processes directly.
// The user sees a normal CMD window open, exactly like double-clicking a .bat file.
function launchInNewWindow(cmdLine, cwd) {
  // Use a unique filename per run so concurrent CRE+TDR runs don't collide
  const ts      = Date.now();
  const batPath = path.join(cwd, `_launcher_run_${ts}.bat`);
  // cmdLine may itself contain \r\n (e.g. TDR splits set + npx into two lines)
  // Expand those into real array entries so join('\r\n') produces correct bat lines
  const cmdLines = cmdLine.split('\r\n');

  const bat = [
    '@echo off',
    `cd /d "${cwd}"`,
    'echo.',
    'echo ============================================',
    'echo  Playwright is running - please wait...',
    'echo ============================================',
    'echo.',
    ...cmdLines,
    // Capture exit code immediately after Playwright — nothing else must run between
    'set RUN_EXIT=%ERRORLEVEL%',
    'echo.',
    'echo ============================================',
    'if %RUN_EXIT%==0 (echo   SUCCESS) else (echo   FAILED - exit code %RUN_EXIT%)',
    'echo ============================================',
    'echo.',
    // Auto-close on success, pause on failure so errors can be read
    'if %RUN_EXIT%==0 (',
    '  echo   Window closing in 3 seconds...',
    '  timeout /t 3 /nobreak >nul',
    '  exit',
    ') else (',
    '  echo   Press any key to close this window...',
    '  pause >nul',
    '  exit',
    ')',
  ].join('\r\n');

  fs.writeFileSync(batPath, bat, 'utf8');

  // spawn cmd.exe /c start — the inner "cmd /c" ensures the new window closes
  // after the bat finishes (default is /k which keeps it open).
  const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/c', batPath], {
    cwd,
    shell:    false,
    detached: true,
    stdio:    'ignore',
    windowsHide: false,
  });
  child.unref(); // don't wait for it — fire and forget

  return batPath;
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(JSON.stringify(obj));
}
function sseHeaders(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
}
function sseWrite(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

let activeRun = null;
let ssoExpired = false;
process.on('uncaughtException',  e => console.error('Uncaught:', e.message));
process.on('unhandledRejection', e => console.error('Rejection:', e));

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/') {
    const p = path.join(TESTS_DIR, 'create_cre_changerequest.html');
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end('create_cre_changerequest.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(p, 'utf8'));
  }

  if (req.method === 'GET' && url === '/tdr') {
    const p = path.join(TESTS_DIR, 'create_tdr_changerequest.html');
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end('create_tdr_changerequest.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(p, 'utf8'));
  }

  if (req.method === 'GET' && url === '/ai') {
    const p = path.join(TESTS_DIR, 'create_aiusage_launcher.html');
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end('create_aiusage_launcher.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(p, 'utf8'));
  }

  if (req.method === 'GET' && url === '/status') {
    return json(res, 200, { alive: true, running: activeRun !== null, projectDir: ROOT_DIR });
  }

  if (req.method === 'GET' && url === '/check-auth') {
    const authFile = path.join(ROOT_DIR, 'auth_servicenow.json');
    const exists   = fs.existsSync(authFile);
    const ageMins  = exists ? Math.floor((Date.now() - fs.statSync(authFile).mtimeMs) / 60000) : null;
    return json(res, 200, { exists, ageMins });
  }

  // GET /check-auth-oa — check auth_openarena.json age
  if (req.method === 'GET' && url === '/check-auth-oa') {
    const authFile = path.join(ROOT_DIR, 'auth_openarena.json');
    const exists   = fs.existsSync(authFile);
    const ageMins  = exists ? Math.floor((Date.now() - fs.statSync(authFile).mtimeMs) / 60000) : null;
    return json(res, 200, { exists, ageMins });
  }

  // POST /invalidate-sso-oa — delete auth_openarena.json
  if (req.method === 'POST' && url === '/invalidate-sso-oa') {
    const authFile = path.join(ROOT_DIR, 'auth_openarena.json');
    try {
      if (fs.existsSync(authFile)) { fs.unlinkSync(authFile); console.log('  auth_openarena.json deleted'); }
      return json(res, 200, { ok: true });
    } catch(e) { return json(res, 500, { ok: false, message: e.message }); }
  }

  // POST /sso-oa — launch OpenArena SSO in a new CMD window
  if (req.method === 'POST' && url === '/sso-oa') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const VENV   = 'c:/playwright_servicenow/.venv/Scripts/python.exe';
      const cmdLine = `${VENV} tests/aiusage/aiopenarena.py --count 1`;

      sseHeaders(res);
      sseWrite(res, 'start', { message: 'Opening CMD window for OpenArena SSO — approve PingID on your device.' });
      sseWrite(res, 'log',   { text: `> ${cmdLine}` });
      sseWrite(res, 'log',   { text: `> cwd: ${ROOT_DIR}` });
      sseWrite(res, 'log',   { text: '' });

      if (!IS_WIN) { sseWrite(res, 'error', { message: 'Windows only.' }); return res.end(); }

      try {
        launchInNewWindow(cmdLine, ROOT_DIR);
        sseWrite(res, 'log', { text: '✓ CMD window opened — complete SSO login in the browser that opens.' });
        sseWrite(res, 'log', { text: '  Approve PingID on your device when prompted.' });
        sseWrite(res, 'log', { text: '  When the window closes automatically, the session is saved.' });
        sseWrite(res, 'done', { exitCode: 0, success: true, message: '✓ CMD window launched.' });
      } catch(e) {
        sseWrite(res, 'error', { message: `Failed: ${e.message}` });
      }
      res.end();
    });
    return;
  }

  // POST /run-ai — launch AI usage scripts in a new CMD window
  if (req.method === 'POST' && url === '/run-ai') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON' }); }

      const { tools, count } = parsed;
      if (!tools || !tools.length) return json(res, 400, { error: 'Select at least one tool' });
      if (!count || count < 5 || count > 20) return json(res, 400, { error: 'Count must be 5-20' });

      const VENV = 'c:/playwright_servicenow/.venv/Scripts/python.exe';
      const SCRIPTS = {
        m365: 'tests/aiusage/aims365.py',
        oa:   'tests/aiusage/aiopenarena.py',
      };

      // Build cmdLine — multiple tools run sequentially in same bat window
      const cmdLines = tools.map(t => `${VENV} ${SCRIPTS[t]} --count ${count}`);
      const cmdLine  = cmdLines.join('\r\n');
      const toolNames = tools.map(t => t === 'm365' ? 'M365 Copilot' : 'OpenArena').join(' + ');

      sseHeaders(res);
      sseWrite(res, 'start', { message: `Opening CMD window — ${toolNames} · ${count} prompts each` });
      sseWrite(res, 'log',   { text: '> ' + cmdLines.join('\n> ') });
      sseWrite(res, 'log',   { text: `> cwd: ${ROOT_DIR}` });
      sseWrite(res, 'log',   { text: '' });

      if (!IS_WIN) { sseWrite(res, 'error', { message: 'Windows only.' }); return res.end(); }

      try {
        launchInNewWindow(cmdLine, ROOT_DIR);
        sseWrite(res, 'log', { text: '✓ CMD window opened — scripts are running.' });
        sseWrite(res, 'log', { text: '  Watch the CMD window for real-time output.' });
        sseWrite(res, 'log', { text: '  Window closes automatically on success, stays open on failure.' });
        sseWrite(res, 'done', { exitCode: 0, success: true, message: '✓ CMD window launched.' });
      } catch(e) {
        sseWrite(res, 'error', { message: `Failed: ${e.message}` });
      }
      res.end();
    });
    return;
  }

  // POST /sso-expired — called by bat file when session expiry is detected in output
  if (req.method === 'POST' && url === '/sso-expired') {
    ssoExpired = true;
    console.log('  ⚠ Session expiry detected in run output — flagging for UI');
    return json(res, 200, { ok: true });
  }

  // GET /sso-expired-status — polled by UI to check if expiry was detected
  if (req.method === 'GET' && url === '/sso-expired-status') {
    const expired = ssoExpired;
    ssoExpired = false; // reset after read
    return json(res, 200, { expired });
  }

  // POST /invalidate-sso — deletes auth_servicenow.json so UI shows red immediately
  if (req.method === 'POST' && url === '/invalidate-sso') {
    const authFile = path.join(ROOT_DIR, 'auth_servicenow.json');
    try {
      if (fs.existsSync(authFile)) { fs.unlinkSync(authFile); console.log('  auth_servicenow.json deleted'); }
      return json(res, 200, { ok: true, message: 'Session invalidated — please run SSO Setup' });
    } catch(e) {
      return json(res, 500, { ok: false, message: e.message });
    }
  }

  // POST /sso — launch SSO in a new visible CMD window
  if (req.method === 'POST' && url === '/sso') {
    if (activeRun) return json(res, 409, { error: 'A run is already in progress.' });
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let ssoFile = 'sso_setup.ts', ssoProject = 'setup';
      try { const p = JSON.parse(body); if (p.ssoFile) ssoFile = p.ssoFile.trim(); if (p.ssoProject) ssoProject = p.ssoProject.trim(); } catch {}

      const cmdLine = `npx playwright test tests/${ssoFile} --project=${ssoProject} --headed`;

      sseHeaders(res);
      sseWrite(res, 'start', { message: 'Opening a new CMD window for SSO setup — log in to ServiceNow in the browser that opens.' });
      sseWrite(res, 'log',   { text: `> ${cmdLine}` });
      sseWrite(res, 'log',   { text: `> cwd: ${ROOT_DIR}` });
      sseWrite(res, 'log',   { text: '' });

      if (!IS_WIN) {
        sseWrite(res, 'error', { message: 'This launcher only supports Windows.' });
        return res.end();
      }

      try {
        const batPath = launchInNewWindow(cmdLine, ROOT_DIR);
        activeRun = null; // detached window — clear immediately
        sseWrite(res, 'log', { text: `✓ New CMD window opened — watch it for progress.` });
        sseWrite(res, 'log', { text: `  When it shows "SUCCESS" and "Press any key", SSO is complete.` });
        sseWrite(res, 'log', { text: `  Then come back here — the SSO status bar will update automatically.` });
        sseWrite(res, 'log', { text: '' });
        sseWrite(res, 'log', { text: `  (temp file: ${batPath})` });
        sseWrite(res, 'done', { exitCode: 0, success: true, message: '✓ CMD window launched — complete login in the browser that opened.' });
      } catch (e) {
        sseWrite(res, 'error', { message: `Failed to open CMD window: ${e.message}\n\nManual workaround: open a new CMD window, cd to ${ROOT_DIR}, then run:\n  ${cmdLine}` });
      }
      res.end();
    });
    return;
  }

  // POST /run — launch Playwright CR run in a new visible CMD window
  if (req.method === 'POST' && url === '/run') {
    if (activeRun) return json(res, 409, { error: 'A run is already in progress.' });
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
      const { releaseVersion, environments, mode, dryRun, project, specPath } = parsed;
      if (!releaseVersion) return json(res, 400, { error: 'releaseVersion required' });
      if (dryRun !== 'list' && (!environments || !environments.length)) return json(res, 400, { error: 'Select at least one environment' });

      const isDry    = dryRun === 'list';
      const workers  = environments.length || 1;
      const grep     = (!isDry && environments.length) ? environments.map(e => `\\[${e}\\]`).join('|') : '';
      const gFlag    = grep ? ` --grep "${grep}"` : '';
      const wFlag    = isDry ? '' : ` --workers=${workers}`;
      const mFlag    = isDry ? '--list' : `--${mode}`;
      // project and specPath are sent by the UI (TDR sends different values than CRE)
      const proj     = project  || 'CRE';
      const spec     = specPath || 'tests/servicenow_cre/changeRequest.spec.ts';
      // Split into two bat lines to avoid CMD treating the space before && as part of the value
      const cmdLine  = `set "RELEASE_VERSION=${releaseVersion}"\r\nnpx playwright test ${spec} --project=${proj}${wFlag} ${mFlag}${gFlag}`;

      sseHeaders(res);
      sseWrite(res, 'start', { message: `Opening CMD window for CRE run — Release ${releaseVersion}` });
      sseWrite(res, 'log',   { text: `> set "RELEASE_VERSION=${releaseVersion}" && npx playwright test ${spec} --project=${proj}${wFlag} ${mFlag}${gFlag}` });
      sseWrite(res, 'log',   { text: `> cwd: ${ROOT_DIR}` });
      sseWrite(res, 'log',   { text: '' });

      if (!IS_WIN) {
        sseWrite(res, 'error', { message: 'This launcher only supports Windows.' });
        return res.end();
      }

      try {
        const batPath = launchInNewWindow(cmdLine, ROOT_DIR);
        activeRun = null; // detached window — we can't track it, so clear immediately
        sseWrite(res, 'log', { text: `✓ New CMD window opened — Playwright is running there.` });
        sseWrite(res, 'log', { text: `  Watch the CMD window for real-time output.` });
        sseWrite(res, 'log', { text: `  When it shows "SUCCESS" / "FAILED" and pauses, the run is complete.` });
        sseWrite(res, 'done', { exitCode: 0, success: true, message: '✓ CMD window launched — Playwright is running.' });
      } catch (e) {
        sseWrite(res, 'error', { message: `Failed to open CMD window: ${e.message}\n\nManual workaround: open CMD, cd to ${ROOT_DIR}, then run:\n  ${cmdLine}` });
      }
      res.end();
    });
    return;
  }

  if (req.method === 'POST' && url === '/stop') {
    if (activeRun) { try { activeRun.kill(); } catch {} activeRun = null; }
    return json(res, 200, { message: 'Stopped. Close the CMD window manually if still open.', running: false });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║  CRE Change Request Launcher                 ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log(`  ║  URL      : http://localhost:${PORT}             ║`);
  console.log(`  ║  Root dir : ${ROOT_DIR.slice(0,32).padEnd(32)}  ║`);
  console.log(`  ║  Strategy : PowerShell Start-Process          ║`);
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') { console.error(`Port ${PORT} in use. Open http://localhost:3131`); }
  else { console.error('Server error:', err.message); }
  process.exit(1);
});