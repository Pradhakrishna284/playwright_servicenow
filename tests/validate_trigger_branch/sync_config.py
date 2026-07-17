"""
sync_config.py

Regenerates the `CONFIG` JS object inside verify_trigger_branches.html
directly from config_github.yaml, so the two files can never drift apart.

The GitHub token in the YAML is intentionally NEVER copied into the HTML.
The HTML collects the PAT from the user at runtime via the header field —
that's the only place a token should live for a static client-side page.

Usage:
  python sync_config.py
  python sync_config.py --yaml config_github.yaml --html verify_trigger_branches.html
"""

import argparse
import re
import sys

import yaml

START_MARKER = "// ── CONFIG:START ──"
END_MARKER   = "// ── CONFIG:END ──"


def js_str(s: str) -> str:
    """Render a Python string as a single-quoted JS string literal."""
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def js_str_array(items) -> str:
    return "[" + ",".join(js_str(i) for i in items) + "]"


def build_config_js(config: dict) -> str:
    projects = config.get("projects", {})
    if not projects:
        sys.exit("❌ No 'projects' found in YAML config")

    lines = []
    lines.append(START_MARKER)
    lines.append("const CONFIG = {")
    lines.append("  projects: {")

    proj_names = list(projects.keys())
    for pi, (proj_name, proj_cfg) in enumerate(projects.items()):
        repo = proj_cfg["repository"]
        lines.append(f"    {proj_name}: {{")
        lines.append(
            f"      repository: {{ owner: {js_str(repo['owner'])}, "
            f"name: {js_str(repo['name'])}, "
            f"description: {js_str(repo['description'])} }},"
        )
        lines.append("      environments: {")

        envs = proj_cfg.get("environments", {})
        env_names = list(envs.keys())
        for ei, (env_name, env_cfg) in enumerate(envs.items()):
            branches = env_cfg["trigger_branch"]
            if isinstance(branches, str):
                branches = [branches]
            comma = "," if ei < len(env_names) - 1 else ""
            lines.append(
                f"        {env_name}: {{ description: {js_str(env_cfg['description'])}, "
                f"trigger_branch: {js_str_array(branches)} }}{comma}"
            )

        lines.append("      }")
        comma = "," if pi < len(proj_names) - 1 else ""
        lines.append(f"    }}{comma}")

    lines.append("  }")
    lines.append("};")
    lines.append(END_MARKER)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yaml", default="config_github.yaml", help="Path to config_github.yaml")
    parser.add_argument("--html", default="verify_trigger_branches.html", help="Path to the HTML file to update")
    args = parser.parse_args()

    with open(args.yaml, encoding="utf-8") as f:
        config = yaml.safe_load(f)

    with open(args.html, encoding="utf-8") as f:
        html = f.read()

    if START_MARKER not in html or END_MARKER not in html:
        sys.exit(
            f"❌ Could not find {START_MARKER!r} / {END_MARKER!r} markers in '{args.html}'.\n"
            "   The HTML file must contain these markers around the CONFIG block."
        )

    new_config_js = build_config_js(config)

    pattern = re.compile(
        re.escape(START_MARKER) + r".*?" + re.escape(END_MARKER),
        re.DOTALL,
    )
    updated_html, count = pattern.subn(new_config_js, html, count=1)
    if count != 1:
        sys.exit("❌ Failed to replace CONFIG block (unexpected marker count)")

    if updated_html == html:
        print("✅ CONFIG already up to date — no changes needed.")
        return

    with open(args.html, "w", encoding="utf-8") as f:
        f.write(updated_html)

    print(f"✅ Synced CONFIG in '{args.html}' from '{args.yaml}'.")
    print("   Note: the GitHub token is never written into the HTML — it is entered")
    print("   by the user at runtime in the page's PAT field.")


if __name__ == "__main__":
    main()