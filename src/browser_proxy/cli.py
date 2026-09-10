"""curl-like command-line client for Browser Proxy."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import uuid
from contextlib import ExitStack, closing
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import quote_plus, urlsplit, urlunsplit

from . import __version__
from .protocol import PROTOCOL_NAME, PROTOCOL_VERSION, ProtocolError, default_socket_path, exchange_local, stream_local


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        prog="browser-proxy",
        description="Make an allowlisted HTTP request through a browser session.",
    )
    result.add_argument("url", nargs="?", help="HTTP or HTTPS URL")
    result.add_argument("-X", "--request", metavar="METHOD", help="HTTP method")
    result.add_argument("-I", "--head", action="store_true", help="Send a HEAD request")
    result.add_argument("-H", "--header", action="append", default=[], metavar="HEADER", help="Request header")
    result.add_argument("-d", "--data", action="append", default=[], metavar="DATA", help="Request body data")
    result.add_argument("--data-raw", action="append", default=[], metavar="DATA", help="Body data without @ expansion")
    result.add_argument("--data-binary", action="append", default=[], metavar="DATA", help="Binary body data")
    result.add_argument(
        "--data-urlencode", action="append", default=[], metavar="DATA", help="URL-encode body data"
    )
    result.add_argument("--json", metavar="JSON", help="JSON request body; @file reads a file")
    result.add_argument("-F", "--form", action="append", default=[], metavar="FORM", help="Multipart field NAME=VALUE")
    result.add_argument("-G", "--get", action="store_true", help="Put data in the URL query and use GET")
    result.add_argument("--url-query", action="append", default=[], metavar="QUERY", help="Append a URL query item")
    result.add_argument("--max-time", type=float, default=30.0, metavar="SECONDS", help="Request timeout")
    result.add_argument("--connect-timeout", type=float, default=2.0, metavar="SECONDS", help="Relay connect timeout")
    result.add_argument("--no-cache", action="store_true", help="Ask the browser to bypass its HTTP cache")
    result.add_argument("--compressed", action="store_true", help="Accept browser-managed response compression")
    result.add_argument("-L", "--location", action="store_true", help="Follow redirects (intentionally unsupported)")
    result.add_argument("-i", "--include", action="store_true", help="Include response status and headers")
    result.add_argument("-D", "--dump-header", metavar="FILE", help="Write response status and headers to a file")
    result.add_argument("-o", "--output", metavar="FILE", help="Write response body to a file")
    result.add_argument("-f", "--fail", action="store_true", help="Fail without body on HTTP errors")
    result.add_argument("--fail-with-body", action="store_true", help="Fail but keep body on HTTP errors")
    result.add_argument("-s", "--silent", action="store_true", help="Suppress error messages")
    result.add_argument("-S", "--show-error", action="store_true", help="Show errors even with --silent")
    result.add_argument("-v", "--verbose", action="store_true", help="Print request and response metadata")
    result.add_argument(
        "--browser",
        choices=("chrome", "firefox"),
        default=os.environ.get("BROWSER_PROXY_BROWSER", "chrome"),
        help="Browser channel (default: chrome)",
    )
    result.add_argument("--socket", type=Path, help="Override the local relay socket")
    result.add_argument("--response-json", action="store_true", help="Print a buffered protocol response as JSON (32 MiB body limit)")
    result.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return result


def read_value(value: str, expand_at: bool) -> bytes:
    if expand_at and value.startswith("@"):
        if value == "@-":
            return sys.stdin.buffer.read()
        return Path(value[1:]).expanduser().read_bytes()
    return value.encode("utf-8")


def has_header(headers: list[list[str]], name: str) -> bool:
    return any(header_name.lower() == name.lower() for header_name, _ in headers)


def parse_headers(values: list[str]) -> list[list[str]]:
    headers: list[list[str]] = []
    expanded: list[str] = []
    for value in values:
        if value.startswith("@"):
            expanded.extend(Path(value[1:]).expanduser().read_text(encoding="utf-8").splitlines())
        else:
            expanded.append(value)
    for value in expanded:
        if ":" not in value:
            raise ValueError(f"Header must contain a colon: {value!r}")
        name, header_value = value.split(":", 1)
        name = name.strip()
        header_value = header_value.strip()
        if not name or "\n" in header_value or "\r" in header_value:
            raise ValueError(f"Invalid header: {value!r}")
        headers.append([name, header_value])
    return headers


def urlencoded_value(value: str) -> bytes:
    if "=" in value:
        name, item = value.split("=", 1)
        return f"{name}={quote_plus(read_value(item, True).decode('utf-8'))}".encode()
    if value.startswith("@"):
        return quote_plus(read_value(value, True).decode("utf-8")).encode()
    return quote_plus(value).encode()


def multipart_body(values: list[str]) -> tuple[bytes, str]:
    boundary = f"browser-proxy-{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for value in values:
        if "=" not in value:
            raise ValueError(f"Form value must be NAME=VALUE: {value!r}")
        name, item = value.split("=", 1)
        if not name or any(character in name for character in '"\r\n'):
            raise ValueError(f"Invalid form field name: {name!r}")
        prefix = [f"--{boundary}\r\n"]
        if item.startswith("@"):
            file_spec = item[1:]
            media_type = None
            if ";type=" in file_spec:
                file_spec, media_type = file_spec.rsplit(";type=", 1)
            path = Path(file_spec).expanduser()
            filename = path.name.replace('"', "")
            media_type = media_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
            prefix.append(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n')
            prefix.append(f"Content-Type: {media_type}\r\n\r\n")
            content = path.read_bytes()
        else:
            prefix.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n')
            content = item.encode("utf-8")
        parts.append("".join(prefix).encode("utf-8") + content + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def append_query(url: str, values: list[bytes]) -> str:
    parsed = urlsplit(url)
    addition = b"&".join(values).decode("utf-8")
    query = "&".join(part for part in (parsed.query, addition) if part)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment))


def build_request(arguments: argparse.Namespace) -> dict[str, Any]:
    headers = parse_headers(arguments.header)
    body_sources = bool(arguments.data or arguments.data_raw or arguments.data_binary or arguments.data_urlencode)
    selected_types = sum((body_sources, arguments.json is not None, bool(arguments.form)))
    if selected_types > 1:
        raise ValueError("Use only one of data, --json, or --form")

    body = b""
    content_type = None
    query_items = [urlencoded_value(item) for item in arguments.url_query]
    if arguments.json is not None:
        body = read_value(arguments.json, True)
        content_type = "application/json"
        if not has_header(headers, "accept"):
            headers.append(["Accept", "application/json"])
    elif arguments.form:
        body, content_type = multipart_body(arguments.form)
    elif body_sources:
        ordinary = [read_value(value, True) for value in arguments.data]
        ordinary.extend(value.encode("utf-8") for value in arguments.data_raw)
        ordinary.extend(urlencoded_value(value) for value in arguments.data_urlencode)
        binary = [read_value(value, True) for value in arguments.data_binary]
        if binary and ordinary:
            raise ValueError("--data-binary cannot be combined with other data options")
        body = b"&".join(binary) if binary else b"&".join(ordinary)
        content_type = "application/x-www-form-urlencoded"

    url = arguments.url
    if arguments.get:
        if arguments.form or arguments.json is not None or arguments.data_binary:
            raise ValueError("-G supports text data options, not --form, --json, or --data-binary")
        if body:
            query_items.append(body)
            body = b""
    if query_items:
        url = append_query(url, query_items)

    if content_type and not arguments.get and not has_header(headers, "content-type"):
        headers.append(["Content-Type", content_type])
    method = arguments.request or (
        "HEAD" if arguments.head else "POST" if selected_types else "GET"
    )
    if arguments.get and not arguments.request:
        method = "GET"

    return {
        "url": url,
        "method": method.upper(),
        "headers": headers,
        "body": {"encoding": "base64", "data": base64.b64encode(body).decode("ascii")},
        "timeout_ms": round(arguments.max_time * 1000),
        "cache": "no-cache" if arguments.no_cache else "default",
    }


def response_head(response: dict[str, Any]) -> bytes:
    status = response.get("status", 0)
    status_text = response.get("status_text", "")
    lines = [f"HTTP/1.1 {status} {status_text}".rstrip()]
    lines.extend(f"{name}: {value}" for name, value in response.get("headers", []))
    return ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8")


def show_error(arguments: argparse.Namespace, text: str) -> None:
    if not arguments.silent or arguments.show_error:
        print(f"browser-proxy: {text}", file=sys.stderr)


def write_output(output: BinaryIO, data: bytes) -> None:
    remaining = memoryview(data)
    while remaining:
        written = output.write(remaining)
        if written is None or written <= 0:
            raise OSError("Output closed while writing")
        remaining = remaining[written:]
    output.flush()


def stream_download(arguments: argparse.Namespace, message: dict[str, Any], socket_path: Path) -> int:
    """Write each response chunk before acknowledging it, including stdout pipes."""
    started = False
    fail_status = False
    status = 0
    # Write pipes directly: a failed BufferedWriter.flush() can retain bytes and
    # fail again during interpreter shutdown, replacing exit status 23 with 120.
    stdout = getattr(sys.stdout.buffer, "raw", sys.stdout.buffer)
    try:
        with ExitStack() as outputs, closing(stream_local(
            message, socket_path, arguments.connect_timeout, arguments.max_time + 7,
        )) as messages:
            output = None
            while True:
                try:
                    event = next(messages)
                except StopIteration:
                    show_error(arguments, "download ended without response_end; output may be incomplete")
                    return 1
                except (EOFError, OSError, ProtocolError, ValueError) as error:
                    show_error(arguments, f"{'incomplete download' if started else 'relay request failed'}: {error}")
                    if isinstance(error, TimeoutError):
                        return 28
                    return 1 if started or isinstance(error, ProtocolError) else 7
                kind = event["type"]
                if kind in {"response_error", "response"}:
                    error = event["error"]
                    suffix = "; output may be incomplete" if started else ""
                    show_error(arguments, f"{error.get('code', 'ERROR')}: {error.get('message', 'Request failed')}{suffix}")
                    return 28 if error.get("code") in {"TIMEOUT", "BROWSER_TIMEOUT"} else 1
                if kind == "response_start":
                    started = True
                    response = event["response"]
                    status = int(response.get("status", 0))
                    header = response_head(response)
                    fail_status = status >= 400 and (arguments.fail or arguments.fail_with_body)
                    if arguments.verbose:
                        for line in header.decode("utf-8").splitlines():
                            print(f"< {line}", file=sys.stderr)
                    if arguments.dump_header:
                        if arguments.dump_header == "-":
                            write_output(stdout, header)
                        else:
                            with Path(arguments.dump_header).expanduser().open("wb") as headers:
                                headers.write(header)
                    output = (
                        outputs.enter_context(Path(arguments.output).expanduser().open("wb"))
                        if arguments.output and arguments.output != "-" else stdout
                    )
                    if arguments.include or arguments.head:
                        write_output(output, header)
                    output.flush()
                    if fail_status and arguments.fail:
                        show_error(arguments, f"HTTP {status}")
                        return 22
                elif kind == "response_chunk":
                    # Flush stdout too before advancing the iterator and acknowledging.
                    write_output(output, event["data"])
                elif kind == "response_end":
                    if fail_status:
                        show_error(arguments, f"HTTP {status}")
                        return 22
                    return 0
    except (BrokenPipeError, OSError) as error:
        show_error(arguments, f"could not write output: {error}")
        return 23


def main() -> int:
    arguments = parser().parse_args()
    if not arguments.url:
        parser().error("the following arguments are required: url")
    if arguments.location:
        parser().error("-L/--location is disabled because redirects could escape the origin allowlist")
    if arguments.max_time <= 0 or arguments.max_time > 300:
        parser().error("--max-time must be greater than 0 and no more than 300 seconds")
    if arguments.connect_timeout <= 0:
        parser().error("--connect-timeout must be greater than 0")
    if arguments.fail and arguments.fail_with_body:
        parser().error("--fail and --fail-with-body are mutually exclusive")

    try:
        request = build_request(arguments)
    except (OSError, UnicodeError, ValueError) as error:
        parser().error(str(error))

    request_id = uuid.uuid4().hex
    message = {
        "protocol": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "type": "request" if arguments.response_json else "request_stream",
        "id": request_id,
        "request": request,
    }
    socket_path = (arguments.socket or default_socket_path(arguments.browser)).expanduser().resolve()

    if arguments.verbose:
        print(f"> {request['method']} {request['url']}", file=sys.stderr)
        for name, value in request["headers"]:
            print(f"> {name}: {value}", file=sys.stderr)
        print("> [Browser cookies are included but never displayed]", file=sys.stderr)

    if not arguments.response_json:
        return stream_download(arguments, message, socket_path)

    try:
        result = exchange_local(
            message,
            socket_path,
            arguments.connect_timeout,
            arguments.max_time + 7,
        )
    except (EOFError, OSError, ProtocolError, ValueError) as error:
        show_error(arguments, f"cannot connect to {arguments.browser} relay at {socket_path}: {error}")
        return 7

    print(json.dumps(result, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
