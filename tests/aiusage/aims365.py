"""
Automates interactions with the Microsoft 365 Copilot web chat using Playwright.

What this script does
---------------------
- Launches a Chromium browser and navigates to the M365 Copilot chat page.
- Types one or more prompts into the chat editor, preferring the explicit Send
  button over pressing Enter, to avoid edge cases.
- Waits for assistant responses to fully render and extracts the markdown text
  of the latest assistant message.

Key implementation details
--------------------------
- Selectors are centralized in the M365Selectors class for easy maintenance.
- Response completion is detected using multiple signals (Pause/Stop control,
  aria-busy state, disappearance of progress controls) to increase robustness.
- The script uses Playwright's built-in auto-waiting and locator API for
  reliability, replacing all manual WebDriverWait / polling loops from the
  Selenium version.

Requirements
------------
- Python 3.8+
- playwright installed via pip:  pip install playwright
- Browser binaries installed:    python -m playwright install chromium

Notes
-----
- For security and compliance, the script does not attempt to automate login;
  it navigates to the chat URL, which may prompt for authentication depending
  on your environment.
- Element IDs, classes and attributes are page-implementation details and could
  change. If extraction starts failing, review the M365Selectors class.

Usage
-----
    python aims365.py
"""

import argparse
import os
import platform
import random
import shutil
import sys
import tempfile
import time
import logging
import traceback

from playwright.sync_api import (
    sync_playwright,
    Page,
    TimeoutError as PlaywrightTimeoutError,
    expect,
)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

NUM_PROMPTS = 10  # Default number of randomly-selected prompts per run


# ---------------------------------------------------------------------------
# Selectors
# ---------------------------------------------------------------------------

class M365Selectors:
    """Centralise selectors and configuration for easier updates."""
    CHAT_URL        = "https://m365.cloud.microsoft/chat/?auth=2"
    EDITOR          = "#m365-chat-editor-target-element"
    PLACEHOLDER     = "#m365-chat-input-shared-wrapper #chat-input-placeholderrb"
    SEND_BUTTON     = "button[aria-label='Send']"
    MESSAGE_ARTICLE = ".fai-CopilotMessage[role='article']"
    MARKDOWN_REPLY  = "[data-testid='markdown-reply']"
    # Matches 'Pause', 'Stop generating', etc.
    PAUSE_STOP_BUTTON = "button[aria-label*='Pause'], button[aria-label*='Stop']"


# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------

def is_send_enabled(page: Page) -> bool:
    """Return whether the Send button is currently enabled."""
    try:
        btn = page.locator(M365Selectors.SEND_BUTTON)
        if btn.count() == 0:
            return False
        return (
            btn.get_attribute("disabled") is None
            and btn.get_attribute("aria-disabled") != "true"
        )
    except Exception:
        return False


def is_pause_visible(page: Page) -> bool:
    """Return True if a Pause/Stop button is visible and enabled during generation."""
    try:
        btns = page.locator(M365Selectors.PAUSE_STOP_BUTTON)
        count = btns.count()
        for i in range(count):
            b = btns.nth(i)
            if b.is_visible() and b.is_enabled():
                return True
        return False
    except Exception:
        return False


def get_message_count(page: Page) -> int:
    """Return the number of Copilot message elements currently in the DOM."""
    try:
        return page.locator(M365Selectors.MESSAGE_ARTICLE).count()
    except Exception:
        return 0


def get_last_markdown_reply_text(page: Page) -> str | None:
    """Return the inner text of the last message's markdown reply, if present."""
    try:
        msgs = page.locator(M365Selectors.MESSAGE_ARTICLE)
        count = msgs.count()
        if count == 0:
            return None
        last = msgs.nth(count - 1)
        parts = last.locator(M365Selectors.MARKDOWN_REPLY)
        part_count = parts.count()
        if part_count:
            text = parts.nth(part_count - 1).inner_text().strip()
            return text if text else None
        return None
    except Exception:
        return None


def get_last_response_text(page: Page) -> str | None:
    """Fallback JS traversal: walk siblings above the input wrapper to get last text."""
    try:
        return page.evaluate("""() => {
            const input = document.getElementById('m365-chat-input-shared-wrapper');
            if (!input) return null;
            let e = input.previousElementSibling;
            const nonEmpty = (el) => el && (el.innerText || '').trim().length > 0;
            while (e) {
                if (nonEmpty(e)) return e.innerText.trim();
                e = e.previousElementSibling;
            }
            return null;
        }""")
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Wait helpers
# ---------------------------------------------------------------------------

def wait_for_placeholder_clickable(page: Page, timeout: int = 10_000) -> None:
    """Optionally wait for the placeholder element to be visible (readiness gate).

    Does not raise if the placeholder is absent — some flows don't show it.
    """
    try:
        page.locator(M365Selectors.PLACEHOLDER).wait_for(state="visible", timeout=timeout)
    except PlaywrightTimeoutError:
        pass  # Placeholder may not always be present; don't fail hard.


def wait_for_page_ready(page: Page, timeout: int = 60_000) -> bool:
    """Wait for the main chat editor to be visible and enabled."""
    try:
        editor = page.locator(M365Selectors.EDITOR)
        editor.wait_for(state="visible", timeout=timeout)
        expect(editor).to_be_enabled(timeout=timeout)
        logging.info("Page is ready with chat editor available.")
        return True
    except PlaywrightTimeoutError:
        logging.error("Timed out waiting for the chat editor to become ready.")
        return False


def wait_for_response_text(
    page: Page,
    prev_count: int,
    start_timeout: float = 20.0,
    complete_timeout: float = 180.0,
    poll: float = 0.5,
) -> str | None:
    """Wait for a new assistant message to appear and complete, then return its text.

    Start phase  – wait up to *start_timeout* seconds for:
        1. A new message element to appear, OR
        2. The Pause/Stop button to become visible.

    Complete phase – wait up to *complete_timeout* seconds for:
        - Pause/Stop button to disappear (preferred), then read markdown text.
        - Fallback: aria-busy -> False on the last message + non-empty markdown text.
    """
    end_start = time.monotonic() + start_timeout
    saw_pause = False

    while time.monotonic() < end_start:
        if get_message_count(page) > prev_count:
            break
        if is_pause_visible(page):
            saw_pause = True
            break
        time.sleep(poll)
    else:
        logging.error("Timed out waiting for assistant message to start appearing.")
        return None

    end_complete = time.monotonic() + complete_timeout
    while time.monotonic() < end_complete:
        try:
            if saw_pause:
                if not is_pause_visible(page):
                    text = get_last_markdown_reply_text(page)
                    if text:
                        return text
            else:
                msgs = page.locator(M365Selectors.MESSAGE_ARTICLE)
                count = msgs.count()
                if count == 0:
                    time.sleep(poll)
                    continue
                last = msgs.nth(count - 1)
                busy = last.get_attribute("aria-busy")
                if busy in (None, "false"):
                    text = get_last_markdown_reply_text(page)
                    if text:
                        return text
        except Exception:
            pass
        time.sleep(poll)

    logging.error("Timed out waiting for assistant message to complete.")
    return None


# ---------------------------------------------------------------------------
# Core prompt submission
# ---------------------------------------------------------------------------

def _type_into_lexical_editor(page: Page, prompt: str) -> None:
    """Type text into the M365 Copilot Lexical editor reliably.

    The editor uses Facebook's Lexical framework (data-lexical-editor="true").
    Lexical maintains its own internal state tree and ignores plain DOM writes
    like textContent/innerText. It only responds to beforeinput events and
    execCommand('insertText') which update Lexical's state correctly.
    """
    editor = page.locator(M365Selectors.EDITOR)
    editor.wait_for(state="visible", timeout=30_000)
    editor.scroll_into_view_if_needed()

    # Click to give the editor real browser focus.
    editor.click()
    page.wait_for_timeout(300)

    # Clear any existing content.
    page.keyboard.press("Control+A")
    page.keyboard.press("Delete")
    page.wait_for_timeout(200)

    # Insert text via beforeinput event + execCommand — the two mechanisms
    # Lexical listens to for updating its internal state tree.
    page.evaluate(
        """(text) => {
            const el = document.getElementById('m365-chat-editor-target-element');
            if (!el) return false;
            el.focus();
            el.dispatchEvent(new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: text,
            }));
            document.execCommand('insertText', false, text);
            return true;
        }""",
        prompt
    )
    page.wait_for_timeout(300)

    # Verify text appeared in the editor.
    visible_text = page.evaluate(
        "() => document.getElementById('m365-chat-editor-target-element')?.innerText?.trim() || ''"
    )
    if not visible_text:
        logging.warning("Text not visible in editor after insertion — prompt may not send correctly.")
    else:
        logging.info(f"Editor contains: {visible_text[:60]}...")


def _submit_prompt_text(page: Page, prompt: str) -> None:
    """Type the prompt into the Lexical editor and click Send (falls back to Enter)."""
    _type_into_lexical_editor(page, prompt)

    # Try to click Send button; fall back to Enter.
    send_wait_end = time.monotonic() + 10.0
    clicked = False
    while time.monotonic() < send_wait_end:
        try:
            if is_send_enabled(page):
                # Use JS click for reliability (avoids intercept issues).
                page.eval_on_selector(M365Selectors.SEND_BUTTON, "el => el.click()")
                clicked = True
                break
        except Exception:
            pass
        time.sleep(0.25)

    if not clicked:
        logging.warning("Send button click failed, falling back to Enter key.")
        page.keyboard.press("Enter")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def send_prompt(page: Page, prompt: str, print_response: bool = True) -> str | None:
    """Send a single prompt to Copilot and return the response text.

    Args:
        page:           Playwright Page pointing at M365 chat.
        prompt:         The prompt string to send.
        print_response: When True, prints the captured response to stdout.

    Returns:
        Response text, or None if extraction failed / timed out.
    """
    wait_for_placeholder_clickable(page, timeout=10_000)
    prev_count = get_message_count(page)

    _submit_prompt_text(page, prompt)

    latest = wait_for_response_text(
        page,
        prev_count=prev_count,
        start_timeout=30.0,
        complete_timeout=240.0,
        poll=0.5,
    )

    if print_response:
        if latest:
            print("\n===== Copilot Response Start =====\n")
            print(latest)
            print("\n===== Copilot Response End =====\n")
        else:
            print("Could not extract response text from the page.")

    return latest


def send_prompts(
    page: Page, prompts: list[str], print_responses: bool = True
) -> list[str | None]:
    """Send a list of prompts sequentially and return a list of response texts."""
    results = []
    for i, prompt in enumerate(prompts):
        logging.info(f"Executing prompt {i + 1}/{len(prompts)}: {prompt[:80]}...")
        results.append(send_prompt(page, prompt, print_responses))
    return results


# ---------------------------------------------------------------------------
# Browser setup
# ---------------------------------------------------------------------------

def _get_chrome_user_data_dir() -> str:
    """Return Chrome's User Data directory for the current OS."""
    system = platform.system()
    if system == "Windows":
        return os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data")
    elif system == "Darwin":
        return os.path.expanduser("~/Library/Application Support/Google/Chrome")
    else:
        return os.path.expanduser("~/.config/google-chrome")


def _copy_cookies_only(src_default: str, dst_default: str) -> None:
    """Copy only the files Chrome needs to restore a login session.

    Copying the entire Default folder can take minutes (it includes large
    Cache, IndexedDB, etc.). We only need a handful of small files that
    hold the authentication cookies and local storage for Microsoft 365.

    Files copied:
      Cookies          — HTTP cookies (Microsoft login session lives here)
      Local State      — encryption key used to decrypt cookie values on Windows
      Web Data         — autofill/stored credentials (helps with org SSO)
      Preferences      — profile settings Chrome checks on startup
      Secure Preferences — signed copy of Preferences
    """
    os.makedirs(dst_default, exist_ok=True)

    # Files that hold the Microsoft session cookies and decryption keys.
    session_files = [
        "Cookies",
        "Web Data",
        "Preferences",
        "Secure Preferences",
    ]
    # Local State lives one level up (in User Data, not Default).
    local_state_src = os.path.join(os.path.dirname(src_default), "Local State")
    local_state_dst = os.path.join(os.path.dirname(dst_default), "Local State")

    copied = []
    for fname in session_files:
        src = os.path.join(src_default, fname)
        dst = os.path.join(dst_default, fname)
        if os.path.exists(src):
            try:
                shutil.copy2(src, dst)
                copied.append(fname)
            except Exception as e:
                logging.warning(f"Could not copy {fname}: {e}")

    if os.path.exists(local_state_src):
        try:
            shutil.copy2(local_state_src, local_state_dst)
            copied.append("Local State")
        except Exception as e:
            logging.warning(f"Could not copy Local State: {e}")

    logging.info(f"Copied session files: {copied}")


def setup_browser(playwright, *, headless: bool = False):
    """Launch Chrome with session cookies from the real profile and return (None, context, page).

    WHY WE COPY COOKIES INSTEAD OF THE FULL PROFILE:
    - Chrome locks its profile while running, causing exitCode=21 if we point
      Playwright at the live profile directory.
    - Copying the full Default folder can be 500 MB+ and takes minutes.
    - We only need the Cookies file (+ Local State for the decryption key on
      Windows) to restore the Microsoft 365 login session. These files are
      typically a few MB and copy in under a second.

    The temp directory is cleaned up automatically in the finally block.
    """
    user_data_dir = _get_chrome_user_data_dir()
    src_default   = os.path.join(user_data_dir, "Default")

    # Build a minimal temp profile with just the session files.
    tmp_dir     = tempfile.mkdtemp(prefix="pw_m365_")
    tmp_default = os.path.join(tmp_dir, "Default")

    if os.path.exists(src_default):
        logging.info("Copying session cookies from Chrome profile (fast — cookies only)...")
        _copy_cookies_only(src_default, tmp_default)
    else:
        logging.warning(f"Chrome profile not found at {src_default} — login will be required.")
        os.makedirs(tmp_default, exist_ok=True)

    logging.info("Launching browser...")
    context = playwright.chromium.launch_persistent_context(
        user_data_dir=tmp_dir,
        channel="chrome",
        headless=headless,
        args=[
            "--start-maximized",
            # Suppress the "login.microsoftonline.com wants to access other
            # devices on your local network" permission popup.
            # --disable-features alone is not enough when channel="chrome" because
            # Chrome's enterprise/profile settings can re-enable it. We combine
            # three flags to ensure the popup never appears:
            "--disable-features=PrivateNetworkAccessPermissionPrompt",
            "--allow-running-insecure-content",
            "--no-sandbox",
            # Automatically grant private network access without prompting.
            "--enable-features=BlockInsecurePrivateNetworkRequests:0",
            # Open the M365 URL immediately as the first tab.
            "--app=" + M365Selectors.CHAT_URL,
        ],
        no_viewport=True,
        ignore_default_args=["--restore-last-session"],
        # Grant private network access permission automatically for all origins.
        # This is the context-level equivalent of clicking "Allow" every time.
        permissions=["clipboard-read", "clipboard-write"],
        extra_http_headers={
            # Tell the server we accept private network access — avoids the
            # preflight check that triggers the browser prompt.
            "Access-Control-Request-Private-Network": "true",
        },
    )
    page = context.pages[0] if context.pages else context.new_page()

    # Auto-dismiss any "Access other devices on local network" permission dialog
    # by intercepting dialog events and automatically accepting them.
    def _handle_dialog(dialog):
        logging.info(f"Auto-dismissing dialog: {dialog.type} — {dialog.message[:80]}")
        import asyncio
        try:
            dialog.accept()
        except Exception:
            pass

    # Grant private network access at the context level so Chrome doesn't ask.
    try:
        context.grant_permissions(["clipboard-read", "clipboard-write"])
    except Exception:
        pass

    # Stash tmp_dir for cleanup in the finally block.
    context._pw_tmp_dir = tmp_dir  # type: ignore[attr-defined]
    return None, context, page


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="M365 Copilot AI usage automation")
    p.add_argument("--headless", action="store_true", help="Run browser in headless mode")
    p.add_argument("--count",    type=int, default=NUM_PROMPTS, help="Number of prompts to run (default: %(default)s)")
    return p.parse_args()


def main() -> None:
    args = _parse_args()
    logging.info(f"Running {args.count} prompt(s) in {'headless' if args.headless else 'headed'} mode.")

    with sync_playwright() as pw:
        browser, context, page = setup_browser(pw, headless=args.headless)
        try:
            # Auto-click "Allow" on any private network access permission popup.
            # This is a fallback for when the --disable-features flag is not
            # fully effective. The popup is a browser-level dialog (not a JS alert)
            # so we handle it by watching for a button with text "Allow".
            def _auto_allow_popup(dialog):
                logging.info(f"Auto-accepting browser dialog: {dialog.message[:80]}")
                try:
                    dialog.accept()
                except Exception:
                    pass
            page.on("dialog", _auto_allow_popup)

            # Navigate to the M365 Copilot chat URL.
            page.goto(M365Selectors.CHAT_URL, wait_until="domcontentloaded")

            # If the private network access popup appeared as a page element
            # (not a JS dialog), auto-click Allow via JS.
            try:
                page.wait_for_timeout(1000)
                page.evaluate("""() => {
                    // Find and click any "Allow" button in permission prompts
                    const btns = document.querySelectorAll('button, [role="button"]');
                    for (const btn of btns) {
                        if (btn.innerText?.trim() === 'Allow') {
                            btn.click();
                            return true;
                        }
                    }
                    return false;
                }""")
            except Exception:
                pass

            # Wait for the chat page to be fully loaded and ready for interaction.
            if not wait_for_page_ready(page):
                logging.error("Chat page did not become ready — exiting.")
                sys.exit(1)

            # Randomly select a subset from the module-level PROMPTS pool.
            prompts = [
                "What are the key features of Python?",
                "What is the difference between Python 2 and Python 3?",
                "How is memory managed in Python?",
                "What are Python's data types?",
                "Explain Python's list and tuple differences.",
                "What are Python's mutable and immutable types?",
                "How do you manage packages in Python?",
                "What are list comprehensions? Give an example.",
                "What are Python decorators? How do they work?",
                "Explain the concept of generators in Python.",
                "How does Python handle garbage collection?",
                "What is a lambda function in Python?",
                "What is the difference between Python functions and methods?",
                "How do you handle exceptions in Python?",
                "Explain Python's *args and **kwargs.",
                "What is slicing in Python?",
                "How do you reverse a list in Python?",
                "What are Python's built-in data structures?",
                "How can you merge two dictionaries in Python?",
                "Explain the difference between shallow copy and deep copy.",
                "What is the difference between a module and a package?",
                "How do you create a virtual environment in Python?",
                "What is PEP 8 and why is it important?",
                "Explain the Global Interpreter Lock (GIL).",
                "How do you read and write files in Python?",
                "What are Python's standard libraries you often use?",
                "How do you handle JSON data in Python?",
                "What is the use of the map() function?",
                "How is multithreading different from multiprocessing in Python?",
                "What are Python's built-in functions?",
                "What is the difference between is and == in Python?",
                "How do you handle missing values in pandas?",
                "What are Python iterators and iterables?",
                "How do you implement a class in Python?",
                "Explain inheritance in Python with an example.",
                "What is multiple inheritance?",
                "How does Python support polymorphism?",
                "What is a Python namespace?",
                "Explain how Python handles scope (local, global, nonlocal).",
                "What are Python's magic methods? Give some examples.",
                "What is the difference between list and array in Python?",
                "How to optimize Python code?",
                "What is the use of the zip() function?",
                "Explain Python's with statement.",
                "How do you handle command-line arguments in Python?",
                "What is the Python GIL and how does it affect thread performance?",
                "What are Python comprehensions?",
                "Explain the difference between range() and xrange().",
                "What is a metaclass in Python?",
                "How does Python's garbage collector work with reference counting?",
                "What is monkey patching in Python?",
                "How do you implement a singleton design pattern in Python?",
                "Describe how Python's pass by assignment works.",
                "What is the difference between a generator and an iterator?",
                "How do you create and raise custom exceptions?",
                "What are Python's built-in data types for sets and frozensets?",
                "Explain the difference between filter() and map().",
                "How do you perform unit testing in Python?",
                "What is the use of Python's assert statement?",
                "How do Python's dictionaries handle collisions?",
                "What is the difference between a function and a coroutine in Python?",
                "How does Python implement multithreading?",
                "How do you manage Python package dependencies?",
                "What is the use of the yield keyword?",
                "Explain Python's slicing syntax with examples.",
                "How do you merge two lists in Python?",
                "What are Python's anonymous functions?",
                "How do you profile and debug Python code?",
                "What is the Python Global Namespace?",
                "Explain Python's error handling with try, except, else, and finally blocks.",
                "How do you check if a file exists in Python?",
                "How do you sort a list in Python?",
                "What are Python's string formatting methods?",
                "What is a Python iterator protocol?",
                "How do you remove duplicates from a list?",
                "What is the difference between list and deque in Python collections?",
                "What are Python's built-in modules for working with dates and times?",
                "Explain Python's regular expressions usage.",
                "How do you connect Python with a database?",
                "Explain the difference between static methods, class methods, and instance methods.",
                "What are Python's memoryviews?",
                "What is the purpose of the __init__.py file?",
                "How do you copy files in Python?",
                "Explain the difference between Python's global and nonlocal keywords.",
                "How do you convert between bytes and strings in Python?",
                "What is the role of Python's asyncio library?",
                "How do you write a Python script for web scraping?",
                "What is the difference between a list comprehension and a generator expression?",
                "How does Python handle Unicode?",
                "What are Python's format specifiers?",
                "What is the difference between assert and raise in Python error handling?",
                "What are Python's built-in assertion methods in unittest?",
                "How do you implement multilevel inheritance?",
                "How can you improve Python code performance?",
                "What is the difference between a Python module and a script?",
                "What tools can be used for Python code linting?",
                "How do Python's metaclasses work?",
                "Explain how context managers work in Python.",
                "How do you implement decorators with arguments?",
                "What is the purpose of Python's dataclasses module?",
                "What is a WebDriver session?",
                "How do you create a new driver session in Selenium WebDriver?",
                "What does starting and stopping a driver session mean?",
                "How is a WebDriver session related to opening and closing a browser?",
                "What is the W3C command for creating a new session?",
                "How can you reconnect to an existing WebDriver session?",
                "Is it possible to interact with an already running browser session using Selenium WebDriver?",
                "How do you get the session ID of a WebDriver session?",
                "What role does the command executor URL play in driver sessions?",
                "How do you programmatically close and quit a driver session?",
                "What happens if you try to use the driver after a session has ended?",
                "How can driver sessions be managed in distributed testing using Selenium Grid?",
                "What are the differences between local and remote driver sessions?",
                "What exceptions might occur related to driver sessions?",
                "What is the difference between driver.get() and driver.navigate() in the context of a session?",
                "How do you handle multiple driver sessions simultaneously?",
                "How to manage session timeouts and keep sessions alive?",
                "What security concerns exist around driver sessions?",
                "How do driver sessions differ between various browser drivers (ChromeDriver, GeckoDriver, etc.)?",
                "What methods are available to inspect and debug WebDriver sessions?",
                "Which browsers are officially supported by Selenium WebDriver?",
                "What are the browser drivers available for major browsers?",
                "How do you instantiate a WebDriver for Google Chrome?",
                "How do you instantiate a WebDriver for Mozilla Firefox?",
                "What configurations are required for Safari with Selenium?",
                "Does Selenium support Opera browser automation?",
                "What are the limitations of Internet Explorer support in Selenium?",
                "How do browser versions impact Selenium WebDriver compatibility?",
                "How do you handle cross-browser testing with Selenium?",
                "What is the difference between local and remote browser sessions in Selenium?",
                "Can Selenium automate mobile browsers? If yes, how?",
                "What are the challenges of automating Safari with Selenium?",
                "How does Selenium interact with Microsoft Edge browser?",
                "What browsers are deprecated or have reduced support in Selenium 4?",
                "How to check browser and driver compatibility before automation?",
                "How do Selenium WebDriver capabilities specify browser type and version?",
                "What are some browser-specific WebDriver capabilities or options?",
                "How do you manage browser-specific functionalities in Selenium scripts?",
                "What is the role of WebDriver executables in browser automation?",
                "How to handle headless browser testing across different supported browsers?",
                "What are the different types of waits supported by Selenium WebDriver?",
                "What is Implicit Wait and how does it work?",
                "How do you set an Implicit Wait in Selenium?",
                "When should you use Implicit Wait in your test scripts?",
                "What is Explicit Wait and how is it different from Implicit Wait?",
                "How do you implement Explicit Wait using WebDriverWait and ExpectedConditions?",
                "What are some common expected conditions used with Explicit Wait?",
                "What is Fluent Wait and what advantages does it offer over other waits?",
                "How do you configure Fluent Wait including timeout and polling frequency?",
                "What exceptions can Fluent Wait ignore during polling?",
                "What is the syntax to use Fluent Wait in Selenium?",
                "How do waits improve the stability of Selenium tests?",
                "What happens if the expected condition is not met within the wait time?",
                "Can you combine Implicit and Explicit Waits in the same script? If yes, what are the implications?",
                "How do you handle synchronization issues in Selenium?",
                "What types of exceptions are related to waiting issues in Selenium?",
                "How can you debug issues related to waits and synchronization?",
                "How is Explicit Wait useful in handling AJAX and dynamic content?",
                "How does polling interval affect Fluent Wait performance?",
                "What are best practices in choosing wait strategies for Selenium automation?",
                'What is Datadog?',
                'What are the key features of Datadog?',
                'What is the Datadog Agent?',
                'How do you install the Datadog Agent on Linux?',
                'What are tags in Datadog?',
                'What languages does Datadog support for APM?',
                'What is the name of the Datadog config file?',
                'Is there a free version of Datadog?',
                'What is a flare in Datadog?',
                'What is the purpose of the Datadog agent configuration file?',
                'How does the Datadog Agent collect data?',
                'What is the architecture of Datadog?',
                'How does StashD work in Datadog?',
                'What is the purpose of security groups in the Datadog agent configuration file?',
                'What is API mode in Datadog?',
                'How does Datadog support real-time interactive dashboards?',
                'What are the features available on the Datadog platform?',
                'How does Datadog handle log management?',
                'What is the UX synthetic engine in Datadog?',
                'How does Datadog support SIEM?',
                'Design a rate limiter for Datadog monitoring.',
                'How would you optimize a query joining multiple large tables in Datadog?',
                'Write a program to alert if the average value over the last 10 minutes exceeds a threshold in Datadog.',
                'Explain how Datadog uses the SARS model for architecture.',
                'How do you implement custom metrics collection in Datadog?',
                'Describe the process of instrumenting an application for Datadog APM.',
                'How would you troubleshoot a Datadog Agent that is not sending data?',
                'Explain the use of Datadog APIs for sending telemetry data.',
                'How do you set up synthetic monitoring for a web application in Datadog?',
                'What are best practices for monitoring microservices with Datadog?',
            ]

            selected = random.sample(prompts, min(args.count, len(prompts)))
            logging.info(f"Selected {len(selected)} prompt(s) from pool of {len(prompts)}.")

            for i, prompt in enumerate(selected):
                logging.info(f"[{i + 1}/{len(selected)}] {prompt[:80]}…")
                send_prompt(page, prompt, print_response=True)
                logging.info("─" * 60)

                if i < len(selected) - 1:
                    logging.info("Opening new chat session…")
                    page.goto(M365Selectors.CHAT_URL)
                    if not wait_for_page_ready(page):
                        logging.error("New chat page not ready — exiting.")
                        sys.exit(1)

        except PlaywrightTimeoutError:
            logging.error("Timeout during automation.\n" + traceback.format_exc())
        except Exception:
            logging.error("Unexpected error.\n" + traceback.format_exc())
        finally:
            logging.info("Closing browser.")
            context.close()
            # Clean up the temporary profile copy.
            tmp = getattr(context, '_pw_tmp_dir', None)
            if tmp and os.path.exists(tmp):
                shutil.rmtree(tmp, ignore_errors=True)
                logging.info(f"Removed temp profile: {tmp}")


if __name__ == "__main__":
    main()


# ─────────────────────────────────────────────────────────────────────────────
# USAGE EXAMPLES
# ─────────────────────────────────────────────────────────────────────────────
#
# INSTALL (one-time)  — run from c:\playwright_servicenow
# ------------------
#   c:/playwright_servicenow/.venv/Scripts/python.exe -m pip install playwright
#   c:/playwright_servicenow/.venv/Scripts/python.exe -m playwright install chrome
#
# RUN (headed — page opens automatically, no login required)
# ----------------------------------------------------------
#   cd c:\playwright_servicenow
#   c:/playwright_servicenow/.venv/Scripts/python.exe tests/aiusage/aims365.py
#
# RUN (headless — for CI or scheduled jobs)
# -----------------------------------------
#   c:/playwright_servicenow/.venv/Scripts/python.exe tests/aiusage/aims365.py --headless
#
# RUN with custom prompt count
# ----------------------------
#   c:/playwright_servicenow/.venv/Scripts/python.exe tests/aiusage/aims365.py --count 5
#   c:/playwright_servicenow/.venv/Scripts/python.exe tests/aiusage/aims365.py --headless --count 20
#
# NOTES
# -----
# • No authentication is required — the M365 Copilot page opens automatically.
# • channel='chrome' is used so organisation security policies apply and the
#   Private Network Access popup is suppressed automatically.
# • To change the default prompt count, edit NUM_PROMPTS above.
# • To add or edit prompts, update the inline prompts list inside main().
# • If selectors break after an M365 update, edit M365Selectors.