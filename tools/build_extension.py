#!/usr/bin/env python3
"""Build browser-specific unpacked extension directories."""

from __future__ import annotations

import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension"
DIST = ROOT / "dist"


def build(browser: str) -> Path:
    destination = DIST / browser
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(SOURCE / "common", destination)
    shutil.copy2(SOURCE / f"manifest.{browser}.json", destination / "manifest.json")
    if browser == "chrome":
        shutil.copy2(SOURCE / "background-loader.js", destination / "background-loader.js")
    return destination


def main() -> None:
    for browser in ("chrome", "firefox"):
        destination = build(browser)
        print(f"Built {browser}: {destination}")


if __name__ == "__main__":
    main()
