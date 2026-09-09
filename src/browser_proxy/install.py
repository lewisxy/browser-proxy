"""Install and remove native-messaging host manifests."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Any


HOST_NAME = "com.browserproxy.native"
FIREFOX_EXTENSION_ID = "browser-proxy@local.invalid"
CHROME_EXTENSION_ID = "gkldokmonobnekdblegmdbfjmjeghdjh"


def host_executable() -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    sibling = Path(sys.argv[0]).absolute().parent / f"browser-proxy-host{suffix}"
    if sibling.is_file():
        return sibling
    discovered = shutil.which("browser-proxy-host")
    if discovered:
        return Path(discovered).absolute()
    return Path(sys.executable).absolute().parent / f"browser-proxy-host{suffix}"


def manifest_location(browser: str) -> Path:
    system = platform.system()
    home = Path.home()
    if system == "Darwin":
        if browser == "chrome":
            return home / "Library/Application Support/Google/Chrome/NativeMessagingHosts" / f"{HOST_NAME}.json"
        return home / "Library/Application Support/Mozilla/NativeMessagingHosts" / f"{HOST_NAME}.json"
    if system == "Linux":
        if browser == "chrome":
            return home / ".config/google-chrome/NativeMessagingHosts" / f"{HOST_NAME}.json"
        return home / ".mozilla/native-messaging-hosts" / f"{HOST_NAME}.json"
    if system == "Windows":
        return home / ".browser-proxy/native-manifests" / browser / f"{HOST_NAME}.json"
    raise RuntimeError(f"Unsupported operating system: {system}")


def manifest_data(browser: str, executable: Path, extension_id: str) -> dict[str, Any]:
    result: dict[str, Any] = {
        "name": HOST_NAME,
        "description": "Browser Proxy local request relay",
        "path": os.fspath(executable),
        "type": "stdio",
    }
    if browser == "chrome":
        result["allowed_origins"] = [f"chrome-extension://{extension_id}/"]
    else:
        result["allowed_extensions"] = [extension_id]
    return result


def windows_registry(browser: str, path: Path | None) -> None:
    import winreg

    vendor = r"Software\Google\Chrome" if browser == "chrome" else r"Software\Mozilla"
    key_path = f"{vendor}\\NativeMessagingHosts\\{HOST_NAME}"
    if path is None:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
        except FileNotFoundError:
            pass
        return
    key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path)
    try:
        winreg.SetValueEx(key, None, 0, winreg.REG_SZ, os.fspath(path))
    finally:
        winreg.CloseKey(key)


def remove(browser: str, destination: Path) -> None:
    destination.unlink(missing_ok=True)
    if platform.system() == "Windows":
        windows_registry(browser, None)
    print(f"Removed {browser} native host manifest: {destination}")


def main() -> int:
    argument_parser = argparse.ArgumentParser(description=__doc__)
    argument_parser.add_argument("--browser", choices=("chrome", "firefox"), required=True)
    argument_parser.add_argument("--extension-id", help="Override the extension ID allowed to connect")
    argument_parser.add_argument("--uninstall", action="store_true", help="Remove the host manifest")
    argument_parser.add_argument("--dry-run", action="store_true", help="Print the manifest without writing it")
    arguments = argument_parser.parse_args()

    destination = manifest_location(arguments.browser)
    if arguments.uninstall:
        if not arguments.dry_run:
            remove(arguments.browser, destination)
        else:
            print(f"Would remove {destination}")
        return 0

    executable = host_executable()
    if not executable.is_file():
        argument_parser.error(f"native host executable not found: {executable}; install the project into .venv first")
    if arguments.extension_id:
        extension_id = arguments.extension_id
    elif arguments.browser == "chrome":
        extension_id = CHROME_EXTENSION_ID
    else:
        extension_id = FIREFOX_EXTENSION_ID
    data = manifest_data(arguments.browser, executable, extension_id)
    if arguments.dry_run:
        print(json.dumps(data, indent=2))
        print(f"Destination: {destination}")
        return 0

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    if platform.system() == "Windows":
        windows_registry(arguments.browser, destination)
    print(f"Installed {arguments.browser} native host manifest: {destination}")
    print(f"Allowed extension ID: {extension_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
