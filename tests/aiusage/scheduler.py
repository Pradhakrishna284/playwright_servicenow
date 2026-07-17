"""
scheduler.py — Periodic scheduler for aiopenarena.py
======================================================

Runs aiopenarena.py automatically at configured intervals using the
`schedule` library (pure Python, no external daemon required).

INSTALL (one-time)
------------------
    c:/playwright_servicenow/.venv/Scripts/python.exe -m pip install schedule

USAGE
-----
    # Run 5 prompts every 2 hours (headed)
    c:/playwright_servicenow/.venv/Scripts/python.exe tests/aiusage/scheduler.py

    # Run 10 prompts every hour, headless
    c:/playwright_servicenow/.venv/Scripts/python.exe tests/aiusage/scheduler.py --interval 60 --count 10 --headless

    # Run once at a specific time each day (e.g. 09:00)
    c:/playwright_servicenow/.venv/Scripts/python.exe tests/aiusage/scheduler.py --at 09:00 --count 5 --headless

ARGUMENTS
---------
    --interval  INT     Minutes between runs  (default: 120)
    --at        HH:MM   Run once daily at this time instead of on an interval
    --count     INT     Prompts per run       (default: 5)
    --headless          Pass --headless to aiopenarena.py

Press Ctrl+C to stop.
"""

from __future__ import annotations

import argparse
import logging
import subprocess
import sys
from pathlib import Path

import schedule
import time

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)

PYTHON     = sys.executable                          # same venv python
SCRIPT     = Path(__file__).parent / "aiopenarena.py"


def run_aiopenarena(count: int, headless: bool) -> None:
    """Launch aiopenarena.py as a subprocess and stream its output."""
    cmd = [PYTHON, str(SCRIPT), "--count", str(count)]
    if headless:
        cmd.append("--headless")
    log.info(f"Starting: {' '.join(cmd)}")
    result = subprocess.run(cmd, text=True)
    if result.returncode == 0:
        log.info("Run completed successfully.")
    else:
        log.warning(f"Run finished with exit code {result.returncode}.")


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Scheduler for aiopenarena.py")
    p.add_argument("--interval", type=int,  default=120,   help="Minutes between runs (default: 120)")
    p.add_argument("--at",       type=str,  default=None,  help="Daily run time HH:MM (overrides --interval)")
    p.add_argument("--count",    type=int,  default=5,     help="Prompts per run (default: 5)")
    p.add_argument("--headless", action="store_true",      help="Run browser headless")
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    job = lambda: run_aiopenarena(args.count, args.headless)  # noqa: E731

    if args.at:
        # Daily at a fixed time, e.g. --at 09:00
        schedule.every().day.at(args.at).do(job)
        log.info(f"Scheduled: daily at {args.at} | count={args.count} | headless={args.headless}")
    else:
        # Every N minutes
        schedule.every(args.interval).minutes.do(job)
        log.info(
            f"Scheduled: every {args.interval} minute(s) | "
            f"count={args.count} | headless={args.headless}"
        )

    log.info("Running immediately for the first time…")
    job()

    log.info("Scheduler running — press Ctrl+C to stop.")
    try:
        while True:
            schedule.run_pending()
            time.sleep(30)
    except KeyboardInterrupt:
        log.info("Scheduler stopped.")


if __name__ == "__main__":
    main()
