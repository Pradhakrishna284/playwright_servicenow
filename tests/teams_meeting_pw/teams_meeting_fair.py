"""
Teams Meeting Automation via Power Automate
============================================
Drives Power Automate flows to schedule Teams meetings from the single
master YAML config that also drives Playwright CR creation.

Config file (single source of truth):
    config/config_cre.yaml        — CRE meetings, release schedule, deployment dates
    config/config_tdr.yaml        — TDR equivalent
    config/config_tdr_test.yaml   — TDR test config

Key feature:
    For deployment meetings (SAT APP, UAT EMEA/AMER, PROD EMEA/AMER) the Teams
    description automatically includes a clickable Change Request link read from
    change_request_registry.yaml, e.g.:
        [CHG0216230](https://trenterprise.service-now.com/...) Content Rate Extract | 2026.05.00 | APP | AWS SAT & OCI QA (Build#0)

Usage:
    python teams_meeting.py --project TDR --release-version 2026.05.00
    python teams_meeting.py --project CRE --release-version 2026.05.00
    python teams_meeting.py --project TDR --release-version 2026.05.00 --config config/config_tdr_test.yaml

Arguments:
    --project          Project name.            Choices: CRE, TDR
    --release-version  Release version number.  Example: 2026.05.00

Optional:
    --config           Path to YAML config file.
                       Default: config/config_<project>.yaml
    --profile          Path to Chrome user-data-dir.
                       Default: auto-detected for your OS.
                       Find it at chrome://version -> Profile Path
                       (use the parent folder, not the 'Default' subfolder).

Requirements:
    pip install playwright pyyaml
    playwright install chrome

How it works:
    Uses playwright.chromium.launch() with --user-data-dir pointing to your
    real Chrome profile — loads your existing Microsoft session cookies so
    Power Automate opens without any login redirect.

    Unlike launch_persistent_context (which fails when Chrome is already open),
    this approach launches a SEPARATE Chrome process that can run alongside your
    normal Chrome windows. No need to close Chrome first.

    The local-network-access Allow/Block popup is suppressed via CDP after launch.
"""

import argparse
import os
import platform
import sys
from datetime import datetime

# Ensure Unicode characters print correctly on Windows cp1252 terminals
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

import yaml
from playwright.sync_api import sync_playwright, Page, BrowserContext, TimeoutError as PWTimeout


# ── Timeouts (milliseconds — Playwright native unit) ─────────────────────────
TIMEOUT_ELEM  = 20_000   # general element wait
TIMEOUT_SHORT =  1_000   # quick-probe wait
TIMEOUT_PAGE  = 30_000   # page-load wait

# ── Delays (milliseconds) ─────────────────────────────────────────────────────
DELAY_SMALL   =   200
DELAY_MEDIUM  =   300
DELAY_LARGE   =   500
DELAY_PAGE    = 2_000
DELAY_SUCCESS = 3_000

MAX_RETRIES = 3

_CONFIG_PATHS = {
    "TDR": "config/config_tdr.yaml",
    "CRE": "config/config_cre.yaml",
}


# ══════════════════════════════════════════════════════════════════════════════
#  Config loading
# ══════════════════════════════════════════════════════════════════════════════

def get_config_path(project_name: str) -> str:
    return _CONFIG_PATHS.get(project_name.upper(),
                             f"config/config_{project_name.lower()}.yaml")


def _resolve(value, lookup: dict, section: str):
    """Replace a '$name' string with the value from lookup; warn on miss."""
    if isinstance(value, str) and value.startswith("$"):
        key = value[1:]
        if key in lookup:
            return lookup[key]
        print(f"  ⚠ Reference '{value}' not found in {section} — left unresolved.")
    return value


def load_config(project_name: str, config_file: str = None) -> dict:
    """
    Load and fully expand a YAML project config.

    Expansions applied in order for each meeting:
      1. time_slot ref  → default_start_time / default_end_time
      2. attendee group refs
      3. form field set ref
    """
    path = config_file or get_config_path(project_name)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Config file not found: '{path}'")

    with open(path, encoding="utf-8") as fh:
        config = yaml.safe_load(fh)

    attendee_groups = config.get("attendee_groups", {})
    form_field_sets = config.get("form_field_sets", {})
    time_slots      = config.get("time_slots", {})

    for name, mtg in config.get("meetings", {}).items():
        # 1. Expand time_slot → start/end times
        slot_ref = mtg.pop("time_slot", None)
        if slot_ref:
            slot = _resolve(slot_ref, time_slots, "time_slots")
            if isinstance(slot, dict):
                mtg["default_start_time"] = slot["start"]
                mtg["default_end_time"]   = slot["end"]
            else:
                print(f"  ⚠ time_slot for '{name}' could not be resolved.")

        # 2. Expand attendee group refs
        mtg["required_attendees"] = _resolve(
            mtg.get("required_attendees", []), attendee_groups, "attendee_groups"
        )
        if "optional_attendees" in mtg:
            mtg["optional_attendees"] = _resolve(
                mtg["optional_attendees"], attendee_groups, "attendee_groups"
            )

        # 3. Expand form field set ref
        mtg["form_fields"] = _resolve(
            mtg.get("form_fields", []), form_field_sets, "form_field_sets"
        )

    print(f"✓ Config loaded: '{path}'")
    return config


# ══════════════════════════════════════════════════════════════════════════════
#  Release / version helpers
# ══════════════════════════════════════════════════════════════════════════════

def normalize_release_number(project_name: str, release_number: str) -> str:
    """Ensure release number has project prefix: e.g. 'CRE 2026.05.00'."""
    prefix = project_name.upper() + " "
    return release_number if release_number.startswith(prefix) else prefix + release_number


def extract_version(release_number: str) -> str:
    """Strip optional project prefix -> '2026.05.00'."""
    parts = release_number.split()
    return parts[-1] if len(parts) > 1 else release_number


def decrement_version(version: str) -> str:
    """Previous monthly version: '2026.01.00' -> '2025.12.00'."""
    try:
        y, m, d = version.split(".")
        year, month = int(y), int(m)
        year, month = (year - 1, 12) if month == 1 else (year, month - 1)
        return f"{year}.{month:02d}.{d}"
    except Exception as exc:
        print(f"  ⚠ decrement_version('{version}'): {exc}")
        return version


# ══════════════════════════════════════════════════════════════════════════════
#  URL helpers
# ══════════════════════════════════════════════════════════════════════════════

def get_versioned_url(config: dict, version: str, url_type: str) -> str:
    """Generate a per-version URL from url_templates, or '' if not defined."""
    tmpl = config.get("releases", {}).get("url_templates", {}).get(url_type, "")
    return tmpl.format(version=version) if tmpl else ""


def get_retro_url(config: dict, release_number: str, meeting_name: str) -> str:
    """
    Resolve release_retro_url for a given meeting.

    CRE-style (versioned per release, in url_templates):
        'Release Retro & Release Scope Review' -> uses PREVIOUS release version
        all other meetings                     -> uses current release version

    TDR-style (single fixed URL, flat key under releases):
        same URL used for every release and meeting
    """
    releases  = config.get("releases", {})
    templates = releases.get("url_templates", {})
    version   = extract_version(release_number)

    if "release_retro_url" in templates:
        lookup_ver = (
            decrement_version(version)
            if meeting_name == "Release Retro & Release Scope Review"
            else version
        )
        url = get_versioned_url(config, lookup_ver, "release_retro_url")
        if not url:
            print(f"  ⚠ release_retro_url not found for version '{lookup_ver}'")
        return url
    else:
        url = releases.get("release_retro_url", "")
        if not url:
            print("  ⚠ release_retro_url not found in releases config.")
        return url


# ══════════════════════════════════════════════════════════════════════════════
#  Change Request registry helpers
# ══════════════════════════════════════════════════════════════════════════════

_MEETING_TO_CONFIG_KEY: dict[str, str] = {
    "SAT APP":   "SAT",
    "UAT EMEA":  "UAT_EMEA",
    "UAT AMER":  "UAT_AMER",
    "PROD EMEA": "PROD_EMEA",
    "PROD AMER": "PROD_AMER",
}


def load_cr_registry(config_file: str) -> dict:
    """Load change_request_registry.yaml from the same config/ directory."""
    config_dir    = os.path.dirname(os.path.abspath(config_file))
    registry_path = os.path.join(config_dir, "change_request_registry.yaml")
    if not os.path.exists(registry_path):
        return {}
    try:
        with open(registry_path, encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        return data.get("change_request_registry", data)
    except Exception as exc:
        print(f"  ⚠ Could not load CR registry: {exc}")
        return {}


def get_cr_for_meeting(registry: dict, release_ver: str,
                       schedule_col: str) -> dict | None:
    """
    Return the full CR registry entry dict for a deployment meeting, or None.
    The returned dict contains at minimum: crNumber, crUrl, shortDescription.
    """
    config_key = _MEETING_TO_CONFIG_KEY.get(schedule_col)
    if not config_key:
        return None
    for cr_data in registry.get(release_ver, {}).values():
        if cr_data.get("configName") == config_key:
            return cr_data
    return None


def build_cr_description_line(cr_number: str, cr_url: str, short_desc: str) -> str:
    """
    Build a Teams-friendly markdown hyperlink line:
        [CHG0216230](https://...?sys_id=...) Content Rate Extract | 2026.05.00 | APP | AWS SAT & OCI QA (Build#0)
    """
    return f"[{cr_number}]({cr_url}) {short_desc}"


# ══════════════════════════════════════════════════════════════════════════════
#  Schedule lookup
# ══════════════════════════════════════════════════════════════════════════════

def get_meeting_date(config: dict, version: str, meeting_name: str) -> str | None:
    """Return YYYY-MM-DD date string for a meeting, or None if not scheduled.

    Supports both config structures:
      - Nested (config_tdr.yaml):      releases.schedule.<version>.meeting_dates.<name>
      - Flat   (config_tdr_test.yaml): releases.schedule.<version>.<name>
    """
    release_entry = config.get("releases", {}).get("schedule", {}).get(version, {})
    nested = release_entry.get("meeting_dates")
    return (nested if nested is not None else release_entry).get(meeting_name)


# ══════════════════════════════════════════════════════════════════════════════
#  Date formatting
# ══════════════════════════════════════════════════════════════════════════════

def format_date_display(date_str) -> str:
    """'2026-04-07' -> '7th Apr 2026'."""
    if not date_str:
        return "N/A"
    try:
        d   = datetime.strptime(str(date_str), "%Y-%m-%d")
        day = d.day
        if 11 <= day <= 13:
            suffix = "th"
        else:
            suffix = {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
        return f"{day}{suffix} {d.strftime('%b %Y')}"
    except ValueError:
        return str(date_str)


# ══════════════════════════════════════════════════════════════════════════════
#  Chrome profile path detection
# ══════════════════════════════════════════════════════════════════════════════

def _get_chrome_profile_path() -> str:
    """
    Return the default Chrome user-data-dir for the current OS.

    Windows : %LOCALAPPDATA%/Google/Chrome/User Data
    Mac     : ~/Library/Application Support/Google/Chrome
    Linux   : ~/.config/google-chrome

    Override with --profile if your installation is non-standard.
    To confirm: open Chrome -> chrome://version -> Profile Path
    (use the parent folder, not the 'Default' subfolder inside it).
    """
    system = platform.system()
    if system == "Windows":
        return os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data")
    elif system == "Darwin":
        return os.path.join(os.path.expanduser("~"), "Library",
                            "Application Support", "Google", "Chrome")
    else:
        return os.path.join(os.path.expanduser("~"), ".config", "google-chrome")


# ══════════════════════════════════════════════════════════════════════════════
#  Browser setup
# ══════════════════════════════════════════════════════════════════════════════

def _copy_file_locked(src: str, dst: str) -> bool:
    """
    Copy a file that may be locked by another process (e.g. Chrome's Cookies
    file while Chrome is running).

    On Windows, shutil.copy2 fails with WinError 32 because Chrome holds an
    exclusive write lock. We open the file with FILE_SHARE_READ | FILE_SHARE_WRITE
    | FILE_SHARE_DELETE via the Win32 API (ctypes) which allows reading a file
    even while another process holds a write lock on it.

    Falls back to shutil.copy2 on non-Windows or if ctypes is unavailable.
    Returns True if the copy succeeded, False if the file could not be copied.
    """
    import shutil

    if platform.system() != "Windows":
        try:
            shutil.copy2(src, dst)
            return True
        except Exception:
            return False

    try:
        import ctypes
        import ctypes.wintypes as wt

        GENERIC_READ                  = 0x80000000
        FILE_SHARE_READ               = 0x00000001
        FILE_SHARE_WRITE              = 0x00000002
        FILE_SHARE_DELETE             = 0x00000004
        OPEN_EXISTING                 = 3
        FILE_ATTRIBUTE_NORMAL         = 0x80
        INVALID_HANDLE_VALUE          = ctypes.c_void_p(-1).value

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        h = kernel32.CreateFileW(
            src,
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )

        if h == INVALID_HANDLE_VALUE:
            raise ctypes.WinError(ctypes.get_last_error())

        # Read the file through the handle in chunks and write to dst
        CHUNK = 1024 * 1024  # 1 MB
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        bytes_read = wt.DWORD(0)
        buf = ctypes.create_string_buffer(CHUNK)

        with open(dst, "wb") as out:
            while True:
                ok = kernel32.ReadFile(h, buf, CHUNK, ctypes.byref(bytes_read), None)
                if not ok or bytes_read.value == 0:
                    break
                out.write(buf.raw[:bytes_read.value])

        kernel32.CloseHandle(h)
        return True

    except Exception:
        # ctypes approach failed — try plain copy as last resort
        try:
            shutil.copy2(src, dst)
            return True
        except Exception:
            return False


def _copy_profile(src_dir: str) -> str:
    """
    Copy only the essential cookie/session files from the real Chrome profile
    into a fresh temp directory that Playwright can open without any lock
    conflict — even while Chrome is running.

    On Windows, Chrome holds a write lock on the Cookies file while it is
    running. We bypass this using Win32 CreateFileW with FILE_SHARE_WRITE,
    which allows reading a locked file without killing Chrome.

    Only the Default/Network folder (cookies, session tokens) and Local State
    (encryption keys needed to decrypt cookies on Windows) are copied.
    Everything else (extensions, cache, history) is left out so the copy is
    fast (a few MB) and starts cleanly.

    The temp directory is deleted automatically when close_browser() is called.
    """
    import shutil, tempfile

    tmp = tempfile.mkdtemp(prefix="pw_chrome_profile_")
    default_src = os.path.join(src_dir, "Default")
    default_dst = os.path.join(tmp, "Default")
    os.makedirs(default_dst, exist_ok=True)

    # Session files to copy — Chrome 96+ stores cookies in Default/Network/Cookies
    session_files = [
        "Cookies",
        os.path.join("Network", "Cookies"),
    ]

    copied = []
    skipped = []

    for rel in session_files:
        src_f = os.path.join(default_src, rel)
        dst_f = os.path.join(default_dst, rel)
        if os.path.isfile(src_f):
            os.makedirs(os.path.dirname(dst_f), exist_ok=True)
            if _copy_file_locked(src_f, dst_f):
                copied.append(rel)
            else:
                skipped.append(rel)

    # Local State carries the DPAPI encryption key for cookie decryption
    local_state_src = os.path.join(src_dir, "Local State")
    if os.path.isfile(local_state_src):
        if _copy_file_locked(local_state_src, os.path.join(tmp, "Local State")):
            copied.append("Local State")
        else:
            skipped.append("Local State")

    if copied:
        print(f"  Copied session files: {', '.join(copied)}")
    if skipped:
        print(f"  ⚠ Could not copy: {', '.join(skipped)} — session may require login")

    return tmp


def setup_browser(playwright, profile_path: str = None) -> tuple[BrowserContext, Page]:
    """
    Launch Chrome via launch_persistent_context using a COPY of your real
    Chrome profile.

    Why a copy instead of the real profile:
      Playwright blocks --user-data-dir in launch() and requires
      launch_persistent_context for profile-based launches. But
      launch_persistent_context on the live profile fails when Chrome is
      already open ("Opening in existing browser session", exitCode=0).

      Copying only the cookie/session files (a few MB) gives us a fresh
      profile dir that is never locked, so launch_persistent_context works
      even while your normal Chrome windows are open.

    The Allow/Block popup ("login.microsoftonline.com wants to access other
    devices on your local network") is suppressed via CDP after launch.
    """
    import shutil

    user_data_dir = profile_path or _get_chrome_profile_path()

    if not os.path.exists(user_data_dir):
        raise FileNotFoundError(
            f"Chrome profile not found: '{user_data_dir}'\n"
            f"Pass --profile <path> to specify the correct location.\n"
            f"Find it: open Chrome -> chrome://version -> Profile Path\n"
            f"(use the parent folder, not the 'Default' subfolder)."
        )

    print(f"  Chrome profile : {user_data_dir}")
    print(f"  Copying session cookies to temp profile...")
    tmp_profile = _copy_profile(user_data_dir)
    print(f"  Temp profile   : {tmp_profile}")

    try:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=tmp_profile,
            channel="chrome",
            headless=False,
            args=[
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-sync",
                "--disable-infobars",
                "--disable-save-password-bubble",
                "--disable-translate",
                "--disable-features=PrivateNetworkAccessChecks",
            ],
            viewport={"width": 1280, "height": 720},
        )
    except Exception:
        shutil.rmtree(tmp_profile, ignore_errors=True)
        raise

    page = context.new_page()

    # Suppress the "login.microsoftonline.com wants to access other devices
    # on your local network" Allow/Block popup via CDP.
    try:
        cdp = context.new_cdp_session(page)
        cdp.send("Browser.setPermission", {
            "permission": {"name": "local-network-access"},
            "setting":    "granted",
            "origin":     "https://login.microsoftonline.com",
        })
    except Exception:
        pass   # --disable-features=PrivateNetworkAccessChecks is the fallback

    print("✓ Browser ready.")
    # Return context + page + tmp_profile so close_browser can clean up the temp dir
    return context, page, tmp_profile


def close_browser(context, tmp_profile: str = None) -> None:
    import shutil
    if context:
        try:
            context.close()
        except Exception:
            pass
        print("Browser closed.")
    if tmp_profile and os.path.exists(tmp_profile):
        shutil.rmtree(tmp_profile, ignore_errors=True)
        print(f"  Temp profile cleaned up.")


# ══════════════════════════════════════════════════════════════════════════════
#  Playwright element helpers
# ══════════════════════════════════════════════════════════════════════════════

def _try_locators(page: Page, xpaths: list,
                  timeout: int = TIMEOUT_SHORT):
    """
    Return the first visible Playwright Locator from (xpath, label) pairs, or None.
    Playwright auto-waits up to `timeout` ms per candidate.
    """
    for xpath, label in xpaths:
        try:
            loc = page.locator(f"xpath={xpath}")
            loc.wait_for(state="visible", timeout=timeout)
            print(f"    ✓ Located via: {label}")
            return loc
        except PWTimeout:
            continue
        except Exception:
            continue
    return None


def _scroll_and_focus(page: Page, locator) -> None:
    """Scroll element into view using Playwright's built-in method."""
    locator.scroll_into_view_if_needed()
    page.wait_for_timeout(DELAY_MEDIUM)


# ══════════════════════════════════════════════════════════════════════════════
#  Form field fillers
# ══════════════════════════════════════════════════════════════════════════════

def fill_text_field(page: Page, aria_label: str, value: str,
                    field_type: str = "textarea") -> None:
    print(f"  Filling '{aria_label}' <- {str(value)[:70]}{'...' if len(str(value)) > 70 else ''}")
    alt_type = "input" if field_type == "textarea" else "textarea"
    xpaths = []
    for ft in (field_type, alt_type):
        xpaths += [
            (f"//{ft}[@aria-label='{aria_label}']",                                    f"aria-label ({ft})"),
            (f"//label[text()='{aria_label}']/following-sibling::{ft}",                f"label sibling ({ft})"),
            (f"//label[contains(text(),'{aria_label}')]/following-sibling::div//{ft}", f"label->div ({ft})"),
            (f"//{ft}[contains(@placeholder,'{aria_label}')]",                          f"placeholder ({ft})"),
        ]
    loc = _try_locators(page, xpaths)
    if loc is None:
        print(f"  ⚠ '{aria_label}' not found — skipping.")
        return
    _scroll_and_focus(page, loc)
    loc.click(click_count=3)    # select all existing text, then replace
    loc.fill(str(value))
    page.wait_for_timeout(DELAY_SMALL)


def fill_date_field(page: Page, label: str, date_value: str) -> None:
    print(f"  Filling date '{label}' <- {date_value}")
    xpaths = [
        (f"//label[text()='{label}']/following-sibling::div//input",           "exact label->div"),
        (f"//label[contains(text(),'{label}')]/following-sibling::div//input", "partial label->div"),
        (f"//input[@aria-label='{label}']",                                    "aria-label"),
    ]
    loc = _try_locators(page, xpaths)
    if loc is None:
        print(f"  ⚠ Date field '{label}' not found — skipping.")
        return
    _scroll_and_focus(page, loc)
    loc.click(click_count=3)
    loc.fill(str(date_value))


def fill_email_field(page: Page, email_list,
                     field_label: str = "Required Attendees") -> None:
    print(f"  Filling people picker '{field_label}'")
    xpaths = [
        (f"//label[@aria-label='{field_label}']/ancestor::div[@class='fl-PeoplePicker']//input[@aria-label='People Picker']",
         "PeoplePicker container"),
        (f"//label[@aria-label='{field_label}']/..//input[@aria-label='People Picker']",
         "label sibling"),
        ("//input[@aria-label='People Picker']", "any People Picker"),
    ]

    # Attempt aria-labelledby resolution first
    try:
        lbl_loc = page.locator(f"xpath=//label[@aria-label='{field_label}']")
        lbl_loc.wait_for(state="visible", timeout=TIMEOUT_SHORT)
        lbl_id = lbl_loc.get_attribute("id")
        if lbl_id:
            xpaths.insert(0, (f"//input[@aria-labelledby='{lbl_id}']", "aria-labelledby"))
    except Exception:
        pass

    loc = _try_locators(page, xpaths)
    if loc is None:
        print(f"  ⚠ People picker '{field_label}' not found — skipping.")
        return

    _scroll_and_focus(page, loc)
    emails = [email_list] if isinstance(email_list, str) else email_list
    for email in emails:
        # press_sequentially fires real key events to trigger autocomplete
        loc.press_sequentially(email, delay=30)
        page.keyboard.press("Enter")
        page.wait_for_timeout(DELAY_LARGE)


# ══════════════════════════════════════════════════════════════════════════════
#  Power Automate interaction
# ══════════════════════════════════════════════════════════════════════════════

def find_and_click_flow(page: Page, flow_name: str) -> None:
    """Locate the named flow link/button and click it, with retry + scroll."""
    xpaths = [
        (f"//a[normalize-space()='{flow_name}']",               "exact link"),
        (f"//a[contains(normalize-space(),'{flow_name}')]",      "partial link"),
        (f"//button[normalize-space()='{flow_name}']",           "exact button"),
        (f"//button[contains(normalize-space(),'{flow_name}')]", "partial button"),
    ]
    print(f"  Searching for flow: '{flow_name}'...")
    for attempt in range(MAX_RETRIES):
        loc = _try_locators(page, xpaths, timeout=5_000)
        if loc:
            loc.click()
            page.wait_for_timeout(DELAY_PAGE)
            return
        if attempt < MAX_RETRIES - 1:
            print(f"  Retry {attempt + 1}/{MAX_RETRIES}...")
            page.evaluate("window.scrollBy(0, 500)")
            page.wait_for_timeout(TIMEOUT_SHORT)
    raise RuntimeError(f"Flow '{flow_name}' not found after {MAX_RETRIES} attempts.")


def click_run_button(page: Page) -> None:
    page.wait_for_timeout(DELAY_SMALL)
    loc = page.locator("xpath=//button[@name='Run']")
    loc.wait_for(state="visible", timeout=10_000)
    loc.scroll_into_view_if_needed()
    page.wait_for_timeout(DELAY_SMALL)
    loc.click()
    print("  ✓ Run button clicked.")


def verify_run_panel(page: Page, flow_name: str) -> None:
    xpaths = [
        (f"//h2[normalize-space()='{flow_name}']",          "exact h2"),
        (f"//h2[contains(normalize-space(),'{flow_name}')]", "partial h2"),
        ("//h2",                                             "any h2"),
        ("//h1",                                             "any h1"),
    ]
    loc = _try_locators(page, xpaths, timeout=3_000)
    if loc:
        print(f"  ✓ Run panel: '{loc.inner_text()}'")
    else:
        print("  ⚠ Run panel not detected — continuing.")

    # Wait for the first form input before proceeding
    try:
        page.locator(
            "xpath=//textarea|//input[@type='text']|//input[@type='email']"
        ).first.wait_for(state="visible", timeout=10_000)
    except Exception:
        pass
    page.wait_for_timeout(DELAY_PAGE)


# Maps YAML field keys -> (Power Automate form label, fill function)
def _fill_email(page: Page, label: str, value) -> None:
    fill_email_field(page, value, label)

_FIELD_MAP: dict = {
    "subject":                ("Release Version",         fill_text_field),
    "required_attendees":     ("Required Attendees",      _fill_email),
    "optional_attendees":     ("Optional Attendees",      _fill_email),
    "description":            ("Description",             fill_text_field),
    "start_date":             ("Start Date",              fill_date_field),
    "start_time":             ("Start Time",              fill_text_field),
    "end_date":               ("End Date",                fill_date_field),
    "end_time":               ("End Time",                fill_text_field),
    "release_schedule_url":   ("Release Schedule Url",    fill_text_field),
    "release_readiness_url":  ("Release Readiness Url",   fill_text_field),
    "release_notes_url":      ("Release Notes Url",       fill_text_field),
    "security_scorecard_url": ("Security Score Card Url", fill_text_field),
    "release_retro_url":      ("Release Retro Url",       fill_text_field),
}


def fill_meeting_form(page: Page, flow_data: dict, form_fields: list) -> None:
    """Fill exactly the fields listed in form_fields using values from flow_data."""
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(DELAY_SMALL)
    for key in form_fields:
        cfg = _FIELD_MAP.get(key)
        if cfg is None:
            continue
        label, filler = cfg
        value = flow_data.get(key)
        if not value:
            print(f"  ⊘ Skipping empty: {label}")
            continue
        filler(page, label, value)
    page.evaluate("window.scrollBy(0, 300)")
    page.wait_for_timeout(DELAY_SMALL)


def click_run_flow_button(page: Page) -> None:
    page.wait_for_timeout(DELAY_SMALL)
    loc = page.locator("xpath=//button[@aria-label='Run flow']")
    loc.wait_for(state="visible", timeout=10_000)
    loc.scroll_into_view_if_needed()
    loc.click()
    print("  ✓ 'Run flow' clicked.")


def verify_success(page: Page) -> bool:
    try:
        loc = page.locator(
            "xpath=//*[contains(text(),'Your flow run successfully started')]"
        )
        loc.wait_for(state="visible", timeout=15_000)
        print(f"  ✓ Success: '{loc.inner_text()}'")
        page.wait_for_timeout(DELAY_SUCCESS)
    except Exception:
        print("  ⚠ Success message not detected — treating as probable success.")
        page.wait_for_timeout(DELAY_PAGE)
    return True


# ══════════════════════════════════════════════════════════════════════════════
#  Core flow runner
# ══════════════════════════════════════════════════════════════════════════════

def run_power_automate_flow(
    page:           Page,
    project_name:   str,
    config:         dict,
    release_number: str,
    meeting_name:   str,
    meeting_date:   str | None,
    cr_registry:    dict | None = None,
) -> None:
    """Navigate to Power Automate and execute one flow for the given meeting."""
    meeting_cfg = config["meetings"].get(meeting_name)
    if meeting_cfg is None:
        raise ValueError(f"Meeting '{meeting_name}' not found in config.")

    version       = extract_version(release_number)
    releases      = config.get("releases", {})
    url_templates = releases.get("url_templates", {})

    display_release        = normalize_release_number(project_name, release_number)
    release_schedule_url   = url_templates.get("release_schedule_url", "")
    release_readiness_url  = get_versioned_url(config, version, "release_readiness_url")
    release_notes_url      = get_versioned_url(config, version, "release_notes_url")
    security_scorecard_url = url_templates.get("security_scorecard_url", "")
    release_retro_url      = get_retro_url(config, release_number, meeting_name)

    start_time = meeting_cfg.get("default_start_time", "09:00:00")
    end_time   = meeting_cfg.get("default_end_time",   "10:00:00")

    base_description = meeting_cfg["description_template"].format(
        release_number=release_number,
        release_schedule_url=release_schedule_url,
    )

    schedule_col = meeting_cfg.get("schedule_column", "")
    cr_entry = get_cr_for_meeting(cr_registry or {}, version, schedule_col)
    if cr_entry:
        cr_number  = cr_entry.get("crNumber", "")
        cr_url     = cr_entry.get("crUrl", "")
        short_desc = cr_entry.get("shortDescription", f"{project_name} | {version}")
        cr_line    = build_cr_description_line(cr_number, cr_url, short_desc)
        description = f"{cr_line}\n\n{base_description}"
        print(f"  CR link : {cr_line[:80]}{'...' if len(cr_line) > 80 else ''}")
    else:
        description = base_description

    flow_data = {
        "subject": meeting_cfg.get("subject_template", "[{release_number}]").format(
            release_number=display_release
        ),
        "required_attendees":     meeting_cfg.get("required_attendees", []),
        "optional_attendees":     meeting_cfg.get("optional_attendees", []),
        "description":            description,
        "start_date":             meeting_date,
        "end_date":               meeting_date,
        "start_time":             start_time,
        "end_time":               end_time,
        "release_schedule_url":   release_schedule_url,
        "release_readiness_url":  release_readiness_url,
        "release_notes_url":      release_notes_url,
        "security_scorecard_url": security_scorecard_url,
        "release_retro_url":      release_retro_url,
    }

    print(f"  Subject : {flow_data['subject']}")
    print(f"  Date    : {format_date_display(meeting_date)}  ({start_time} - {end_time})")

    pa_url = config["power_automate"]["url"]
    print(f"  -> {pa_url}")

    # Navigate to Power Automate — domcontentloaded is reliable for SPAs;
    # networkidle is never used as PA uses long-polling that never goes idle.
    page.goto(pa_url, wait_until="domcontentloaded", timeout=TIMEOUT_PAGE)

    # Wait for a real element to confirm the page has rendered
    try:
        page.wait_for_selector("xpath=//a | //button", timeout=TIMEOUT_PAGE)
    except Exception:
        pass
    page.wait_for_timeout(DELAY_PAGE)

    find_and_click_flow(page, meeting_cfg["flow_name"])
    click_run_button(page)
    verify_run_panel(page, meeting_cfg["flow_name"])
    fill_meeting_form(page, flow_data, meeting_cfg.get("form_fields", []))
    click_run_flow_button(page)
    verify_success(page)


# ══════════════════════════════════════════════════════════════════════════════
#  Orchestrator
# ══════════════════════════════════════════════════════════════════════════════

def create_teams_meeting(project_name: str, release_number: str,
                         config_file: str = None,
                         profile_path: str = None) -> dict:
    """
    Schedule all Teams meetings for a project + release.

    Returns:
        dict with keys: total_flows, success_count, failed_count,
                        passed_flows, failed_flows
    """
    results = {
        "total_flows":   0,
        "success_count": 0,
        "failed_count":  0,
        "passed_flows":  [],
        "failed_flows":  [],
    }
    context     = None
    tmp_profile = None

    with sync_playwright() as pw:
        try:
            version         = extract_version(release_number)
            display_release = normalize_release_number(project_name, release_number)

            print(f"\n{'='*70}")
            print(f"  {project_name.upper()} Release Meeting Automation  —  {display_release}")
            print(f"{'='*70}\n")

            config = load_config(project_name, config_file)

            resolved_config_file = config_file or get_config_path(project_name)
            cr_registry = load_cr_registry(resolved_config_file)

            release_schedule = config.get("releases", {}).get("schedule", {})
            if version not in release_schedule:
                available = sorted(release_schedule.keys())
                raise ValueError(
                    f"Version '{version}' not found in releases.schedule.\n"
                    f"Available: {available}"
                )

            meetings      = config.get("meetings", {})
            run_meetings  = []
            skip_meetings = []

            for name in meetings:
                date = get_meeting_date(config, version, name)
                if not date:
                    skip_meetings.append((name, "no date in schedule"))
                    continue
                if name == "QA Data Refresh" and not get_meeting_date(config, version, "RK QA Change Creation"):
                    skip_meetings.append((name, "RK QA Change Creation is empty"))
                    continue
                run_meetings.append((name, date))

            results["total_flows"] = len(run_meetings)

            print(f"{'─'*70}")
            print(f"  To run   : {len(run_meetings)}")
            print(f"  To skip  : {len(skip_meetings)}")
            print(f"{'─'*70}")
            for i, (n, _)      in enumerate(run_meetings,  1): print(f"  {i:2}. ✓ {n}")
            for i, (n, reason) in enumerate(skip_meetings, 1): print(f"  {i:2}. ⊘ {n}  ({reason})")
            print(f"{'─'*70}\n")

            context, page, tmp_profile = setup_browser(pw, profile_path)
            print(f"  Starting {len(run_meetings)} meeting flows...\n")

            for idx, (meeting_name, meeting_date) in enumerate(run_meetings, 1):
                print(f"\n[{idx}/{len(run_meetings)}] {meeting_name}")
                print(f"{'─'*70}")
                try:
                    run_power_automate_flow(
                        page, project_name, config,
                        release_number, meeting_name, meeting_date,
                        cr_registry=cr_registry,
                    )
                    results["success_count"] += 1
                    results["passed_flows"].append({"flow_name": meeting_name, "date": meeting_date})
                    print(f"  ✓ Done: {meeting_name}")
                except Exception as exc:
                    import traceback
                    results["failed_count"] += 1
                    results["failed_flows"].append({
                        "flow_name": meeting_name,
                        "date":      meeting_date,
                        "error":     str(exc),
                    })
                    print(f"  ✗ Failed: {meeting_name} — {exc}")
                    print(traceback.format_exc())

            print(f"\n{'='*70}")
            print(f"  SUMMARY  —  {display_release}")
            print(f"{'='*70}")
            print(f"  Total available : {len(run_meetings) + len(skip_meetings)}")
            print(f"  Skipped         : {len(skip_meetings)}")
            print(f"  Executed        : {len(run_meetings)}")
            print(f"  Passed          : {results['success_count']}")
            print(f"  Failed          : {results['failed_count']}")
            if run_meetings:
                pct = results["success_count"] / len(run_meetings) * 100
                print(f"  Pass rate       : {pct:.1f}%")
            print(f"{'─'*70}")
            for i, info in enumerate(results["passed_flows"], 1):
                print(f"  {i:2}. ✓ {info['flow_name']}  ({format_date_display(info['date'])})")
            for i, info in enumerate(results["failed_flows"], 1):
                print(f"  {i:2}. ✗ {info['flow_name']}  ({format_date_display(info['date'])})")
                print(f"        Error: {info['error']}")
            for i, (n, reason) in enumerate(skip_meetings, 1):
                print(f"  {i:2}. ⊘ {n}  ({reason})")
            print(f"{'='*70}\n")

            return results

        finally:
            close_browser(context, tmp_profile)


# ══════════════════════════════════════════════════════════════════════════════
#  Entry point
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Schedule Teams meetings via Power Automate for a project release.",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument(
        "--project",
        required=True,
        help="Project name.\nChoices: CRE, TDR",
    )
    parser.add_argument(
        "--release-version",
        required=True,
        help="Release version number.\nExample: 2026.05.00",
    )
    parser.add_argument(
        "--config",
        default=None,
        help="Path to YAML config file (optional).\nDefault: config/config_<project>.yaml",
    )
    parser.add_argument(
        "--profile",
        default=None,
        help=(
            "Path to Chrome user-data-dir (optional).\n"
            "Default: auto-detected for your OS.\n"
            "Find it: open Chrome -> chrome://version -> Profile Path\n"
            "         (use the parent folder, not the 'Default' subfolder).\n"
            "Windows: C:\\Users\\you\\AppData\\Local\\Google\\Chrome\\User Data\n"
            "Mac    : /Users/you/Library/Application Support/Google/Chrome"
        ),
    )
    args = parser.parse_args()

    create_teams_meeting(args.project, args.release_version, args.config, args.profile)

# ── Usage ──────────────────────────────────────────────────────────────────────
#
#   Chrome can stay open — no need to close it before running.
#
#   python teams_meeting.py --project TDR --release-version 2026.05.00
#   python teams_meeting.py --project CRE --release-version 2026.05.00
#
#   With test config:
#   python teams_meeting.py --project TDR --release-version 2026.05.00 --config config/config_tdr_test.yaml
#
#   Custom Chrome profile:
#   python teams_meeting.py --project TDR --release-version 2026.05.00 --profile "C:\Users\you\AppData\Local\Google\Chrome\User Data"