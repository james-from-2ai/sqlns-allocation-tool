"""Move the browser's most recent download into dist/parity_runs under a real name.

    python tools/claim_download.py <target-filename>          # claim newest
    python tools/claim_download.py --clear                    # drop stale partials

Chrome leaves these downloads as GUID-named `.tmp` files: the sheet data is
fetched by an extension-driven click, and Chrome does not finalize the name
without a user gesture. The bytes are complete, so this claims the newest one
and verifies it parses as the expected CSV before accepting it.
"""

import csv
import glob
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOWNLOADS = os.path.join(os.path.expanduser("~"), "Downloads")
RUNS = os.path.join(ROOT, "dist", "parity_runs")


def candidates():
    pats = ["*.tmp", "data*.csv", "*.crdownload"]
    out = []
    for p in pats:
        out += glob.glob(os.path.join(DOWNLOADS, p))
    return sorted(out, key=os.path.getmtime, reverse=True)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    if sys.argv[1] == "--clear":
        for f in candidates():
            os.remove(f)
            print(f"removed {os.path.basename(f)}")
        return

    target = os.path.basename(sys.argv[1])
    found = candidates()
    if not found:
        sys.exit("no pending download found in Downloads")
    src = found[0]

    with open(src, encoding="utf8", errors="replace") as fh:
        rows = list(csv.reader(fh))
    if len(rows) < 10:
        sys.exit(f"{os.path.basename(src)} has only {len(rows)} rows; refusing to claim it")

    os.makedirs(RUNS, exist_ok=True)
    dst = os.path.join(RUNS, target)
    shutil.move(src, dst)
    print(f"{target}: {len(rows)} rows, {os.path.getsize(dst):,} bytes")
    for f in candidates():
        os.remove(f)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
