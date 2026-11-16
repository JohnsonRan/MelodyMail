#!/usr/bin/env python3
"""Fail when the Telegram card HTML breaks a sendWidget limit (docs/M5b-telegram.md).

Limits (Bot API, sendWidget; widgets guide, "Limits"): 1-32768 bytes of UTF-8, at most 4096
bytes after zlib at level 9, valid UTF-8 without U+0000. The guide says Python's zlib counts as
the server does, so this check is written in Python.

Usage: check-widget-size.py [path]   (default: worker/src/telegram/card.html)
Exit 0: within the limits. Exit 1: a limit is broken. Exit 2: the file cannot be read or is empty.
"""

import sys
import zlib
from pathlib import Path

RAW_MAX = 32768
COMPRESSED_MAX = 4096
DEFAULT = Path(__file__).resolve().parent.parent / "worker" / "src" / "telegram" / "card.html"


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    try:
        data = path.read_bytes()
    except OSError as err:
        print(f"check-widget-size: cannot read {path}: {err.strerror}", file=sys.stderr)
        return 2
    if not data:
        print(f"check-widget-size: {path} is empty", file=sys.stderr)
        return 2
    compressed = len(zlib.compress(data, 9))
    problems = []
    if len(data) > RAW_MAX:
        problems.append(f"{len(data)} bytes of HTML, over {RAW_MAX}")
    if compressed > COMPRESSED_MAX:
        problems.append(f"{compressed} bytes after zlib level 9, over {COMPRESSED_MAX}")
    if b"\x00" in data:
        problems.append("contains U+0000")
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        problems.append("is not valid UTF-8")
    for problem in problems:
        print(f"check-widget-size: {path.name} {problem}", file=sys.stderr)
    if problems:
        return 1
    print(f"check-widget-size: {path.name} {len(data)} bytes, {compressed} compressed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
