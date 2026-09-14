#!/usr/bin/env python3
"""Build browser-specific unpacked extensions and optional store upload ZIPs."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


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


def package_extension(browser: str, directory: Path) -> Path:
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if browser == "chrome":
        # The Web Store rejects the key used to stabilize unpacked development IDs.
        manifest.pop("key", None)
    packages = DIST / "packages"
    packages.mkdir(parents=True, exist_ok=True)
    destination = packages / f"browser-proxy-{browser}-{manifest['version']}.zip"
    with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
        for path in sorted(directory.rglob("*")):
            if not path.is_file():
                continue
            name = path.relative_to(directory).as_posix()
            if browser == "chrome" and name == "manifest.json":
                archive.writestr(name, json.dumps(manifest, indent=2) + "\n")
            else:
                archive.write(path, name)
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--package",
        action="store_true",
        help="Also create unsigned store upload ZIPs under dist/packages",
    )
    arguments = parser.parse_args()
    for browser in ("chrome", "firefox"):
        destination = build(browser)
        print(f"Built {browser}: {destination}")
        if arguments.package:
            archive = package_extension(browser, destination)
            print(f"Packaged {browser}: {archive}")


if __name__ == "__main__":
    main()
