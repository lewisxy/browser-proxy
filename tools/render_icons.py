#!/usr/bin/env python3
"""Render extension PNG icons from the SVG sources. Requires rsvg-convert (librsvg)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


ICONS = Path(__file__).resolve().parents[1] / "extension" / "common" / "icons"
SIZES = (16, 32, 48, 96, 128)


def main() -> None:
    if shutil.which("rsvg-convert") is None:
        raise SystemExit("rsvg-convert not found; install librsvg (e.g. brew install librsvg)")
    for size in SIZES:
        # The 16px toolbar size has its own pixel-aligned drawing.
        source = ICONS / ("icon-16.svg" if size == 16 else "icon.svg")
        output = ICONS / f"icon-{size}.png"
        subprocess.run(
            ["rsvg-convert", "-w", str(size), "-h", str(size), str(source), "-o", str(output)],
            check=True,
        )
        print(f"Rendered {output.relative_to(ICONS.parents[2])}")


if __name__ == "__main__":
    main()
