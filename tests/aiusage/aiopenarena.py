"""
aiopenarena.py — OpenArena AI Platform Usage Automation
=========================================================

PURPOSE
-------
Drives the Thomson Reuters OpenArena AI platform to send a randomised set of
prompts and confirm each response via the "Estimated query cost:" signal.
Intended for AI usage measurement, regression testing, and load benchmarking.

WHAT IT DOES
------------
1. Launches Chromium and navigates to the OpenArena application URL.
2. Performs SSO login (TR PingID / SAML flow) — mirrors the pattern used in
   sso_setup.ts so both Python automation and TypeScript Playwright tests
   share identical SSO logic and .env credential conventions.
3. Dismisses any post-login loading overlay and profile modal.
4. Randomly selects NUM_PROMPTS prompts from the PROMPTS pool.
5. For each prompt:
   a. Ensures the "Temporary chat" toggle is OFF (chats saved).
   b. Injects text into the Shadow-DOM-backed saf-text-area input.
   c. Clicks the Shadow-DOM-backed saf-button send control.
   d. Waits for "Estimated query cost:" to appear (response complete).
   e. Refreshes the page for a clean next session.

SSO / CREDENTIALS  (aligns with sso_setup.ts conventions)
----------------------------------------------------------
Credentials are read from environment variables — never hardcoded.
Create a .env file (or export them in your shell):

    SSO_USERNAME=6106377
    SSO_PASSWORD=YourPassword
    SSO_URL=https://sso.thomsonreuters.com/as/authorization.oauth2
    OPENARENA_URL=https://dataandanalytics.int.thomsonreuters.com/ai-platform/ai-experiences/use/5cfcd3aa-df19-4615-8ff7-798f109e3e57

Load the .env file before running:
    pip install python-dotenv
    # The script calls load_dotenv() automatically if python-dotenv is installed.

KEY DESIGN DECISIONS
--------------------
- Shadow DOM is pierced exclusively via page.evaluate() — Playwright does not
  auto-pierce arbitrary custom Shadow roots.
- All JS snippets are defined as module-level constants for easy editing.
- SSO logic mirrors sso_setup.ts: wait for SSO hostname, fill #username /
  #password, click #signOnButton, then wait for the app hostname.
- wait_for_url_complete() uses Playwright's page.wait_for_url() + load-state
  check instead of a hand-rolled polling loop.

REQUIREMENTS
------------
    pip install playwright python-dotenv
    python -m playwright install chromium

USAGE
-----
    python aiopenarena.py                  # headed, 10 prompts
    python aiopenarena.py --headless       # headless (CI)
    python aiopenarena.py --count 5        # custom prompt count
"""

from __future__ import annotations

import argparse
import logging
import os
import random
import sys
import time
import traceback
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import (
    Page,
    TimeoutError as PlaywrightTimeoutError,
    sync_playwright,
)

# Load .env if python-dotenv is available (optional but recommended).
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ─────────────────────────────────────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURATION  (override via environment variables or .env)
# ─────────────────────────────────────────────────────────────────────────────

NUM_PROMPTS   = 10
SSO_USERNAME  = os.getenv("SSO_USERNAME", "")
SSO_PASSWORD  = os.getenv("SSO_PASSWORD", "")
SSO_URL       = os.getenv("SSO_URL", "https://sso.thomsonreuters.com/as/authorization.oauth2")
OPENARENA_URL = os.getenv(
    "OPENARENA_URL",
    "https://dataandanalytics.int.thomsonreuters.com/ai-platform/ai-experiences/use/3a875be6-996a-4a44-b78d-d9aa2584f9a4",
)

# auth_openarena.json — separate from auth_servicenow.json (which is for ServiceNow/CRE/TDR).
# The existing auth_servicenow.json only contains cookies for trenterprise.service-now.com
# and has NO cookies for dataandanalytics.int.thomsonreuters.com (OpenArena).
# We save the OpenArena session to its own file so it can be reused without
# re-running SSO on every execution.
#
# Folder layout:
#   c:\playwright_servicenow\auth_openarena.json             <- written by this script
#   c:\playwright_servicenow\tests\aiusage\aiopenarena.py  <- this script
AUTH_FILE         = Path(__file__).parent.parent.parent / "auth_openarena.json"
AUTH_MAX_AGE_SECS = 8 * 60 * 60  # 8 hours — same limit as sso_setup.ts


# ─────────────────────────────────────────────────────────────────────────────
# SHADOW-DOM JAVASCRIPT CONSTANTS
# All Shadow DOM interaction is done via JS — Playwright cannot auto-pierce
# arbitrary custom elements.
# ─────────────────────────────────────────────────────────────────────────────

# Returns true when the Send button (and its inner shadow button) are both enabled.
_JS_IS_SEND_ENABLED = """() => {
    try {
        const host = document.querySelector("saf-button[data-testid='chat-send-btn']");
        if (!host) return false;
        const classes     = (host.getAttribute('class') || '').split(' ');
        const hostEnabled = host.getAttribute('disabled') === null
                         && host.getAttribute('aria-disabled') !== 'true'
                         && !classes.includes('disabled');
        const inner = host.shadowRoot?.querySelector('button, [role="button"]');
        if (!inner) return hostEnabled;
        const innerDisabled = inner.hasAttribute('disabled')
                           || inner.getAttribute('aria-disabled') === 'true';
        return hostEnabled && !innerDisabled && getComputedStyle(inner).pointerEvents !== 'none';
    } catch { return false; }
}"""

# Clicks the inner button inside the Shadow DOM Send host element.
_JS_CLICK_SEND = """() => {
    try {
        const host = document.querySelector("saf-button[data-testid='chat-send-btn']");
        if (!host) return false;
        (host.shadowRoot?.querySelector('button, [role="button"]') || host).click();
        return true;
    } catch { return false; }
}"""

# Sets text into the saf-text-area shadow editable and fires the necessary events
# so the framework recognises the change.
_JS_TYPE_TEXT = """(text) => {
    const host = document.querySelector("saf-text-area[data-testid='chat-input']")
               || document.querySelector('saf-text-area');
    if (!host) return false;
    const INPUT_SELS = ["textarea", "[contenteditable='true']", "div[role='textbox']", "input[type='text']"];
    const visited = new Set();
    function findIn(root) {
        if (!root) return null;
        for (const sel of INPUT_SELS) {
            const el = root.querySelector(sel); if (el) return el;
        }
        for (const el of root.querySelectorAll('*')) {
            if (el?.shadowRoot && !visited.has(el)) {
                visited.add(el);
                const res = findIn(el.shadowRoot);
                if (res) return res;
            }
        }
        return null;
    }
    const editable = findIn(host.shadowRoot || host);
    if (editable) {
        editable.focus();
        if ('value' in editable)          { editable.value = ''; editable.value = text; }
        else if (editable.isContentEditable) { editable.textContent = text; editable.innerText = text; }
        editable.dispatchEvent(new Event('input',  {bubbles:true, composed:true}));
        editable.dispatchEvent(new Event('change', {bubbles:true, composed:true}));
        try { editable.dispatchEvent(new InputEvent('input', {bubbles:true, composed:true, inputType:'insertText', data:text})); } catch {}
        return true;
    }
    // Host-level fallback if no editable found in shadow tree.
    try { if ('value' in host) host.value = text; } catch {}
    host.dispatchEvent(new Event('input',  {bubbles:true, composed:true}));
    host.dispatchEvent(new CustomEvent('saf-input', {bubbles:true, composed:true, detail:{value:text}}));
    return false;
}"""

# Returns aria-checked state of the Temporary Chat toggle switch.
_JS_SWITCH_ARIA = """() => {
    const sw = document.querySelector("saf-switch[data-testid='conversation-switch']");
    return sw ? sw.getAttribute('aria-checked') : null;
}"""

# Clicks the toggle switch's inner indicator to flip its state.
_JS_CLICK_SWITCH = """() => {
    const host = document.querySelector("saf-switch[data-testid='conversation-switch']");
    if (!host?.shadowRoot) return false;
    const part = host.shadowRoot.querySelector('span[part="checked-indicator"]')
               || host.shadowRoot.querySelector('div[part="switch"]');
    (part || host).click();
    return true;
}"""


# ─────────────────────────────────────────────────────────────────────────────
# SHADOW DOM INTERACTION HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _is_send_enabled(page: Page) -> bool:
    """Return True when the Send saf-button is fully enabled."""
    try:
        return bool(page.evaluate(_JS_IS_SEND_ENABLED))
    except Exception:
        return False


def type_into_textarea(page: Page, text: str, timeout: int = 20_000) -> None:
    """
    Wait for saf-text-area to appear, then inject *text* through its Shadow DOM.

    Falls back to keyboard typing if the JS injection returns False.
    """
    page.wait_for_selector("saf-text-area", state="attached", timeout=timeout)
    page.eval_on_selector(
        "saf-text-area",
        "el => { el.scrollIntoView({block:'center'}); el.click(); }",
    )
    if not page.evaluate(_JS_TYPE_TEXT, text):
        # Keyboard fallback: focus host, select-all, delete, type.
        page.eval_on_selector("saf-text-area", "el => el.focus()")
        page.keyboard.press("Control+A")
        page.keyboard.press("Delete")
        page.keyboard.type(text)


def click_send_button(page: Page, timeout: float = 10.0) -> bool:
    """
    Poll until Send is enabled (up to *timeout* s) then click it.

    Returns True on success; falls back to Enter key and returns False.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _is_send_enabled(page) and page.evaluate(_JS_CLICK_SEND):
            return True
        time.sleep(0.25)
    log.warning("Send button not ready — falling back to Enter key.")
    page.keyboard.press("Enter")
    return False


def handle_temporary_chat_switch(page: Page) -> None:
    """
    Ensure the 'Temporary chat' toggle is OFF so conversations are saved.

    Silently skips if the toggle is not found within 20 s (some views omit it).
    """
    try:
        page.wait_for_selector(
            "saf-switch[data-testid='conversation-switch']",
            state="attached",
            timeout=20_000,
        )
        is_on = page.evaluate(_JS_SWITCH_ARIA) == "true"
        log.info(f"'Temporary chat' is {'ON — turning OFF' if is_on else 'already OFF'}.")
        if is_on:
            page.evaluate(_JS_CLICK_SWITCH)
            page.wait_for_function(
                "() => document.querySelector(\"saf-switch[data-testid='conversation-switch']\")"
                "?.getAttribute('aria-checked') === 'false'",
                timeout=5_000,
            )
            log.info("'Temporary chat' turned OFF.")
    except Exception as exc:
        log.warning(f"Could not handle chat switch: {exc}")


# ─────────────────────────────────────────────────────────────────────────────
# WAIT HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def wait_for_chat_ui(page: Page, timeout: int = 90_000) -> None:
    """Block until both the textarea and send button are in the DOM."""
    page.wait_for_selector("saf-text-area", state="attached", timeout=timeout)
    page.wait_for_selector("saf-button[data-testid='chat-send-btn']", state="attached", timeout=timeout)


def wait_for_url_complete(page: Page, expected_parts: list[str], timeout: int = 90_000) -> None:
    """
    Wait until the URL contains all *expected_parts* and document is ready.

    Uses Playwright's page.wait_for_url() for the URL part, then checks
    document.readyState rather than a hand-rolled loop.
    """
    if expected_parts:
        # Build a regex that matches all required parts anywhere in the URL.
        import re
        pattern = re.compile("(?=.*" + ")(?=.*".join(re.escape(p) for p in expected_parts) + ")")
        page.wait_for_url(pattern, timeout=timeout, wait_until="domcontentloaded")
    # Use domcontentloaded — SPAs rarely fire the 'load' event cleanly.
    page.wait_for_load_state("domcontentloaded", timeout=timeout)


def wait_for_loading_overlay_gone(page: Page, timeout: int = 10_000) -> None:
    """Wait for the loading overlay to disappear; non-fatal if absent."""
    try:
        page.wait_for_selector(
            "div[data-testid='loading-overlay']", state="hidden", timeout=timeout
        )
        log.info("Loading overlay gone.")
    except PlaywrightTimeoutError:
        log.info("No loading overlay detected.")


def wait_for_estimated_cost(page: Page, timeout: int = 90_000) -> None:
    """
    Wait for 'Estimated query cost:' to appear — the signal that the AI
    response is fully rendered and the query has been logged.
    """
    log.info("Waiting for 'Estimated query cost:'…")
    try:
        page.wait_for_selector("text=Estimated query cost:", state="visible", timeout=timeout)
        log.info("'Estimated query cost:' appeared — response complete.")
    except PlaywrightTimeoutError:
        log.warning("'Estimated query cost:' did not appear within the timeout.")


# ─────────────────────────────────────────────────────────────────────────────
# AUTH.JSON HELPERS
# Same pattern as sso_setup.ts — save session after first login, reuse it on
# subsequent runs so SSO is only prompted once every 8 hours.
# ─────────────────────────────────────────────────────────────────────────────

def _is_auth_fresh() -> bool:
    """Return True if auth_openarena.json exists and is less than 8 hours old."""
    if not AUTH_FILE.exists():
        return False
    age = time.time() - AUTH_FILE.stat().st_mtime
    return age < AUTH_MAX_AGE_SECS


def _load_auth_state() -> str | None:
    """Return path to auth_openarena.json if it is fresh, otherwise None."""
    if _is_auth_fresh():
        age_min = int((time.time() - AUTH_FILE.stat().st_mtime) / 60)
        log.info(f"✓ auth_openarena.json is fresh ({age_min}m old) — reusing saved session, no SSO needed.")
        return str(AUTH_FILE)
    if AUTH_FILE.exists():
        log.info("⚠  auth_openarena.json is stale (>8h) — will re-authenticate and save a new session.")
    else:
        log.info("⚠  auth_openarena.json not found — will authenticate and save session for future runs.")
    return None


def _save_auth_state(context) -> None:
    """Save the current browser session to auth_openarena.json."""
    try:
        AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
        context.storage_state(path=str(AUTH_FILE))
        log.info(f"✓ Session saved to {AUTH_FILE} — will be reused for the next 8 hours.")
    except Exception as exc:
        log.warning(f"Could not save auth_openarena.json: {exc}")


# ─────────────────────────────────────────────────────────────────────────────
# SSO LOGIN
# Mirrors the pattern used in sso_setup.ts:
#   1. Navigate to app → redirect to SSO hostname.
#   2. Fill #username + #password with a small delay.
#   3. Click #signOnButton.
#   4. Wait for redirect back to the application hostname.
# ─────────────────────────────────────────────────────────────────────────────

def perform_sso_login(
    page: Page,
    user_id: str,
    password: str,
    sso_url: str,
    expected_final_url_parts: list[str],
    force_sso: bool = False,
) -> None:
    """
    Complete the TR SSO (PingID/SAML) login flow.

    Parameters mirror the sso_setup.ts conventions:
        user_id                  — SSO_USERNAME from .env
        password                 — SSO_PASSWORD from .env
        sso_url                  — SSO_URL from .env (hostname is extracted)
        expected_final_url_parts — substrings that must all appear in the
                                   final app URL after redirect
        force_sso                — when True, wait specifically for SSO redirect
                                   instead of accepting the initial app URL as
                                   "already logged in" (prevents false early-return
                                   when page.goto() still shows app host before the
                                   SSO redirect fires)
    """
    sso_host = urlparse(sso_url).netloc  # e.g. "sso.thomsonreuters.com"
    app_host  = expected_final_url_parts[0] if expected_final_url_parts else ""

    log.info(f"Waiting for SSO host '{sso_host}' or app host '{app_host}' in URL…")

    if force_sso:
        # When no cached session exists we MUST wait for the SSO redirect.
        # page.goto(app_url) briefly shows the app host before the server-side
        # SSO redirect fires — checking app_host alone triggers a false early-return.
        try:
            page.wait_for_function(
                f"() => location.href.includes('{sso_host}')",
                timeout=30_000,
            )
            log.info(f"SSO redirect detected — on '{sso_host}'.")
        except PlaywrightTimeoutError:
            # No SSO redirect observed — verify the chat UI is reachable instead.
            log.info("No SSO redirect detected — checking whether app UI is accessible…")
            try:
                page.wait_for_selector("saf-text-area", state="attached", timeout=10_000)
                log.info("Chat UI accessible without SSO redirect — session already valid.")
                return
            except PlaywrightTimeoutError:
                raise PlaywrightTimeoutError(
                    f"Expected SSO redirect to '{sso_host}' but neither the SSO page nor "
                    "the chat UI appeared. Check network access and credentials."
                )
    else:
        page.wait_for_function(
            f"() => location.href.includes('{sso_host}') || location.href.includes('{app_host}')",
            timeout=30_000,
        )
        if not (user_id and password and sso_host in page.url):
            log.info("No credentials / already on app — assuming session is active.")
            return

    if not (user_id and password):
        log.info("No credentials provided — cannot fill SSO form.")
        return
    if sso_host not in page.url:
        log.info("Not on SSO login page — skipping credential entry.")
        return

    log.info("On SSO login page — filling credentials (mirrors sso_setup.ts behaviour)…")

    def _fill_field(selector: str, value: str) -> bool:
        """Try main page then all frames; return True if filled."""
        try:
            page.wait_for_selector(selector, state="visible", timeout=8_000)
            loc = page.locator(selector)
            loc.scroll_into_view_if_needed()
            loc.click()
            loc.fill(value)
            return True
        except PlaywrightTimeoutError:
            pass
        for frame in page.frames:
            try:
                frame.wait_for_selector(selector, state="visible", timeout=3_000)
                frame.locator(selector).fill(value)
                log.info(f"Filled '{selector}' in sub-frame: {frame.url}")
                return True
            except Exception:
                continue
        return False

    _fill_field("#username", str(user_id))
    _fill_field("#password", str(password))
    page.wait_for_timeout(500)  # Allow form validation to enable the sign-on button.

    # Click sign-on button — try locator first, JS click as fallback.
    submit_sel = "a#signOnButton, button#signOnButton, button[type='submit']"
    try:
        btn = page.locator(submit_sel).first
        btn.scroll_into_view_if_needed()
        btn.click()
    except Exception:
        page.eval_on_selector(submit_sel, "el => el.click()")
    log.info("SSO credentials submitted — waiting for redirect…")

    # Wait for redirect back to the target application.
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        url = page.url
        if all(p in url for p in expected_final_url_parts):
            log.info("Redirected to target app successfully.")
            return
        try:
            wait_for_chat_ui(page, timeout=2_000)
            log.info("Chat UI ready — redirect complete.")
            return
        except Exception:
            pass
        time.sleep(0.5)

    raise PlaywrightTimeoutError("Timed out waiting for SSO redirect to target app.")


def dismiss_profile_modal(page: Page) -> None:
    """Click 'Cancel' on the post-login profile modal if it appears."""
    try:
        cancel = page.locator("saf-button:has-text('Cancel')")
        cancel.wait_for(state="visible", timeout=5_000)
        page.eval_on_selector("saf-button:has-text('Cancel')", "el => el.click()")
        cancel.wait_for(state="hidden", timeout=10_000)
        log.info("Profile modal dismissed.")
        page.wait_for_timeout(3_000)  # Let UI settle.
    except PlaywrightTimeoutError:
        log.info("No profile modal appeared.")
    except Exception as exc:
        log.warning(f"Unexpected error dismissing profile modal: {exc}")


# ─────────────────────────────────────────────────────────────────────────────
# PROMPT POOL
# ─────────────────────────────────────────────────────────────────────────────

PROMPTS: list[str] = [
    # Git & GitHub
    "What is Git and how does it work?",
    "What is GitHub and how is it different from Git?",
    "How do you initialize a Git repository?",
    "How do you clone a GitHub repository?",
    "What is the difference between git fetch and git pull?",
    "How do you create a new branch in Git?",
    "How do you switch branches?",
    "How do you merge branches in Git?",
    "What is a pull request?",
    "How do you resolve merge conflicts?",
    "Explain the Git workflow for a typical feature branch.",
    "How do you commit changes in Git?",
    "What is staging in Git?",
    "How do you check the status of files in Git?",
    "What is the difference between git add and git commit?",
    "How do you undo the last commit?",
    "How do you delete a branch in Git?",
    "What are tags in Git and how do you create them?",
    "Explain the difference between a bare and non-bare repository.",
    "How do you set up Git configuration for user name and email?",
    # Playwright
    "What is Playwright?",
    "What are the advantages of Playwright?",
    "What are the disadvantages of Playwright?",
    "Which programming languages are supported by Playwright?",
    "What types of tests does Playwright support?",
    "How do Selenium and Playwright differ?",
    # Datadog
    "What is Datadog?",
    "What are the key features of Datadog?",
    "What is the Datadog Agent?",
    "How do you install the Datadog Agent on Linux?",
    "What are tags in Datadog?",
    "What languages does Datadog support for APM?",
    "What is the name of the Datadog config file?",
    "Is there a free version of Datadog?",
    "What is a flare in Datadog?",
    "What is the purpose of the Datadog agent configuration file?",
    "How does the Datadog Agent collect data?",
    "What is the architecture of Datadog?",
    "How does StashD work in Datadog?",
    "What is the purpose of security groups in the Datadog agent configuration file?",
]


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="OpenArena AI usage automation")
    p.add_argument("--headless", action="store_true", help="Run browser headless (CI mode)")
    p.add_argument("--count",    type=int, default=NUM_PROMPTS, help="Number of prompts to run")
    return p.parse_args()


def _derive_url_parts(url: str) -> list[str]:
    """Extract [hostname, last-path-segment] from an application URL."""
    parsed = urlparse(url)
    parts = [p for p in parsed.path.split("/") if p]
    result = [parsed.netloc]
    if parts:
        result.append(parts[-1])
    return result


def main() -> None:
    args = _parse_args()

    # Validate required credentials (mirrors sso_setup.ts validation block).
    missing = [name for name, val in [
        ("SSO_USERNAME", SSO_USERNAME),
        ("SSO_PASSWORD", SSO_PASSWORD),
        ("SSO_URL",      SSO_URL),
        ("OPENARENA_URL", OPENARENA_URL),
    ] if not val]
    if missing:
        log.error(
            f"Missing required environment variables: {', '.join(missing)}\n"
            "Add them to a .env file or export them before running:\n"
            "  SSO_USERNAME=6106377\n"
            "  SSO_PASSWORD=yourPassword\n"
            "  SSO_URL=https://sso.thomsonreuters.com/as/authorization.oauth2\n"
            "  OPENARENA_URL=https://dataandanalytics.int.thomsonreuters.com/..."
        )
        sys.exit(1)

    expected_url_parts = _derive_url_parts(OPENARENA_URL)
    selected = random.sample(PROMPTS, min(args.count, len(PROMPTS)))
    log.info(f"Running {len(selected)} prompt(s) | {'headless' if args.headless else 'headed'} mode.")

    with sync_playwright() as pw:
        # Use channel='chrome' (installed Chrome) so organisation policies,
        # certificates and extensions are applied — avoids the security
        # blocker popup that appears when using the bundled Chromium.
        # Mirrors playwright.config.ts: { use: { channel: 'chrome' } }
        # PROXY: if your corporate network requires a proxy to reach internal .int. hosts,
        # set HTTPS_PROXY in your .env, e.g.: HTTPS_PROXY=http://proxy.thomsonreuters.com:8080
        # Leave it unset to use system/VPN routing (most common case).
        proxy_server = os.getenv("HTTPS_PROXY") or os.getenv("https_proxy")
        browser = pw.chromium.launch(
            headless=args.headless,
            channel="chrome",
            proxy={"server": proxy_server} if proxy_server else None,
            args=[
                "--start-maximized",
                "--disable-features=PrivateNetworkAccessPermissionPrompt",
            ],
        )

        # Load auth_openarena.json if fresh — reuses saved session to skip SSO/PingID.
        # If stale/missing we do a full SSO login then save a new auth_openarena.json.
        auth_state = _load_auth_state()
        context = browser.new_context(
            no_viewport=True,
            storage_state=auth_state,   # None = fresh context (will prompt SSO)
        )
        page = context.new_page()

        try:
            page.goto(OPENARENA_URL, wait_until="domcontentloaded", timeout=90_000)

            if not auth_state:
                # No valid session — perform full SSO login (PingID MFA included).
                # force_sso=True prevents a false early-return caused by page.goto()
                # briefly showing the app URL before the SSO redirect fires.
                perform_sso_login(
                    page,
                    user_id=SSO_USERNAME,
                    password=SSO_PASSWORD,
                    sso_url=SSO_URL,
                    expected_final_url_parts=expected_url_parts,
                    force_sso=True,
                )
                # Save session IMMEDIATELY after SSO redirect succeeds so that
                # a PingID approval is never wasted — even if the chat UI wait
                # below times out, the next run will reuse this session.
                _save_auth_state(context)
                log.info("Waiting for chat UI to confirm SSO succeeded…")
                wait_for_chat_ui(page, timeout=90_000)
            else:
                # Session loaded from auth_openarena.json — wait for app to be ready.
                log.info("Session restored from auth_openarena.json — waiting for app…")
                try:
                    wait_for_chat_ui(page, timeout=30_000)
                except PlaywrightTimeoutError:
                    log.warning(
                        "Chat UI not detected after session restore — "
                        "attempting re-authentication…"
                    )
                    # Stale/invalid session — navigate fresh and re-run SSO.
                    page.goto(OPENARENA_URL, wait_until="domcontentloaded", timeout=90_000)
                    perform_sso_login(
                        page,
                        user_id=SSO_USERNAME,
                        password=SSO_PASSWORD,
                        sso_url=SSO_URL,
                        expected_final_url_parts=expected_url_parts,
                        force_sso=True,
                    )
                    # Save immediately after redirect — same reasoning as above.
                    _save_auth_state(context)
                    log.info("Waiting for chat UI after re-authentication…")
                    wait_for_chat_ui(page, timeout=90_000)

            wait_for_loading_overlay_gone(page)
            dismiss_profile_modal(page)

            for i, prompt in enumerate(selected):
                log.info(f"[{i + 1}/{len(selected)}] {prompt[:80]}…")

                handle_temporary_chat_switch(page)
                wait_for_chat_ui(page, timeout=10_000)

                type_into_textarea(page, prompt)
                click_send_button(page, timeout=10.0)
                wait_for_estimated_cost(page, timeout=90_000)
                log.info("─" * 60)

                if i < len(selected) - 1:
                    log.info("Refreshing for next prompt…")
                    page.reload()
                    try:
                        wait_for_url_complete(page, expected_url_parts, timeout=30_000)
                        wait_for_chat_ui(page, timeout=30_000)
                    except Exception:
                        pass

        except PlaywrightTimeoutError:
            log.error("Timeout during automation.\n" + traceback.format_exc())
        except Exception:
            log.error("Unexpected error.\n" + traceback.format_exc())
        finally:
            log.info("Closing browser.")
            context.close()
            browser.close()
            sys.exit(0)


if __name__ == "__main__":
    main()


# ─────────────────────────────────────────────────────────────────────────────
# USAGE EXAMPLES
# ─────────────────────────────────────────────────────────────────────────────
#
# INSTALL (one-time)  — run from c:\playwright_servicenow
# ------------------
#   c:/playwright_servicenow/.venv/Scripts/python.exe -m pip install playwright python-dotenv
#   c:/playwright_servicenow/.venv/Scripts/python.exe -m playwright install chromium
#
# CONFIGURE CREDENTIALS  (.env file in c:\playwright_servicenow)
# --------------------------------------------------------------
#   SSO_USERNAME=6106377
#   SSO_PASSWORD=YourSSOPassword
#   SSO_URL=https://sso.thomsonreuters.com/as/authorization.oauth2
#   OPENARENA_URL=https://dataandanalytics.int.thomsonreuters.com/ai-platform/...
#
# RUN (headed — approve PingID on your device on first run only)
# --------------------------------------------------------------
#   cd c:\playwright_servicenow
#   c:/playwright_servicenow/.venv/Scripts/python.exe tests/aiusage/aiopenarena.py
#
#   First run:  SSO login + PingID MFA approval required.
#               Session is saved to auth_openarena.json automatically.
#   Next runs:  No login needed — session reused from auth_openarena.json (8h).
#
# RUN (headless — CI / scheduled job, session must already be established)
# ------------------------------------------------------------------------
#   c:/playwright_servicenow/.venv/Scripts/python.exe tests/aiusage/aiopenarena.py --headless
#
# RUN with custom prompt count
# ----------------------------
#   c:/playwright_servicenow/.venv/Scripts/python.exe tests/aiusage/aiopenarena.py --count 5
#   c:/playwright_servicenow/.venv/Scripts/python.exe tests/aiusage/aiopenarena.py --headless --count 20
#
# RELATIONSHIP TO sso_setup.ts
# ----------------------------
# This script uses its OWN session file: auth_openarena.json
# (NOT auth_servicenow.json — that file only has ServiceNow cookies, not OpenArena cookies)
#   • Same .env variable names (SSO_USERNAME, SSO_PASSWORD, SSO_URL)
#   • Same selector strategy (#username, #password, #signOnButton)
#   • Same 8-hour session lifetime
#   • auth_openarena.json is saved after first SSO login, reused for 8 hours
#   • SSO + PingID MFA is only needed once per 8-hour window
# First run: approve PingID on your device. Subsequent runs skip SSO entirely.
#
# NOTES
# -----
# • Shadow DOM elements (saf-text-area, saf-button, saf-switch) are
#   interacted with via page.evaluate() — CSS selectors alone cannot pierce
#   custom Shadow roots.
# • If selectors change after a platform update, edit the _JS_* constants.
# • To add prompts, extend the PROMPTS list above.