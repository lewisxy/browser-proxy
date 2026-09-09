#!/usr/bin/env python3
"""Local endpoint used for the interactive Firefox integration test."""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/login":
            body = b"<!doctype html><title>Browser Proxy test</title><h1>Firefox cookie is ready</h1>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Set-Cookie", "firefox_session=browser-secret; HttpOnly; SameSite=Lax; Path=/")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.respond()

    def do_POST(self) -> None:
        self.respond()

    def respond(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        request_body = self.rfile.read(length).decode("utf-8", "replace")
        body = json.dumps(
            {
                "method": self.command,
                "cookie": self.headers.get("Cookie", ""),
                "testHeader": self.headers.get("X-Test", ""),
                "body": request_body,
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_arguments: object) -> None:
        pass


def main() -> None:
    argument_parser = argparse.ArgumentParser()
    argument_parser.add_argument("--port", type=int, required=True)
    arguments = argument_parser.parse_args()
    ThreadingHTTPServer(("127.0.0.1", arguments.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
