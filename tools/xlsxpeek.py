"""Inspect the SQ-LNS Allocation Tool workbook without loading it into openpyxl.

The workbook is a ~58 MB Google Sheets export whose sheet XML expands to ~495 MB,
so openpyxl is impractically slow. This streams the raw sheet XML instead and
reports formulas alongside Google's cached values.

Usage:
  python xlsxpeek.py sheets
  python xlsxpeek.py rows "Ward Data & Calcs (Allocation)" 1-4
  python xlsxpeek.py cols "Hard-coded Inputs" A,B,C 1-140
  python xlsxpeek.py grep "COUNTUNIQUEIFS"
"""

import re
import sys
import zipfile

WORKBOOK = r"C:\Users\G09jb\Downloads\SQ-LNS Allocation Tool.xlsx"

_ENT = [("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'"), ("&amp;", "&")]


def unescape(text):
    for a, b in _ENT:
        text = text.replace(a, b)
    return text


class Book:
    def __init__(self, path=WORKBOOK):
        self.zip = zipfile.ZipFile(path)
        rels = self.zip.read("xl/_rels/workbook.xml.rels").decode("utf8", "ignore")
        rmap = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels))
        wb = self.zip.read("xl/workbook.xml").decode("utf8", "ignore")
        self.sheets = []
        for m in re.finditer(r"<sheet([^>]*)/>", wb):
            attr = m.group(1)
            name = unescape(re.search(r'name="([^"]*)"', attr).group(1))
            state = re.search(r'state="(\w+)"', attr)
            rid = re.search(r'r:id="(rId\d+)"', attr).group(1)
            self.sheets.append(
                {
                    "name": name,
                    "state": state.group(1) if state else "visible",
                    "path": "xl/" + rmap[rid],
                }
            )
        self.by_name = {s["name"]: s for s in self.sheets}
        self.strings = []
        for m in re.finditer(
            r"<si>(.*?)</si>",
            self.zip.read("xl/sharedStrings.xml").decode("utf8", "ignore"),
            re.S,
        ):
            self.strings.append("".join(re.findall(r"<t[^>]*>(.*?)</t>", m.group(1), re.S)))

    def xml(self, sheet):
        return self.zip.read(self.by_name[sheet]["path"]).decode("utf8", "ignore")

    def formulas(self, sheet):
        """Every formula on the sheet, newline-joined, entities resolved."""
        return unescape("\n".join(re.findall(r"<f[^>]*>([^<]*)</f>", self.xml(sheet))))

    def cells(self, sheet, rows=None, cols=None):
        """Yield (row, col, formula, value) for populated cells."""
        for rm in re.finditer(r'<row r="(\d+)"[^>]*>(.*?)</row>', self.xml(sheet), re.S):
            row = int(rm.group(1))
            if rows and row not in rows:
                continue
            for cm in re.finditer(
                r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', rm.group(2), re.S
            ):
                col, attr, inner = cm.group(1), cm.group(2) or "", cm.group(3) or ""
                if cols and col not in cols:
                    continue
                fm = re.search(r"<f[^>]*>(.*?)</f>", inner, re.S)
                vm = re.search(r"<v>(.*?)</v>", inner, re.S)
                value = None
                if vm:
                    value = unescape(vm.group(1))
                    if re.search(r't="s"', attr):
                        try:
                            value = self.strings[int(value)]
                        except (ValueError, IndexError):
                            pass
                formula = unescape(fm.group(1)) if fm else None
                if formula is not None or value is not None:
                    yield row, col, formula, value


def parse_rows(spec):
    if not spec:
        return None
    out = set()
    for part in spec.split(","):
        if "-" in part:
            a, b = part.split("-")
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(part))
    return out


def main():
    book = Book()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "sheets"

    if cmd == "sheets":
        infos = {i.filename: i for i in book.zip.infolist()}
        for s in book.sheets:
            size = infos[s["path"]].file_size / 1e6
            nf = book.xml(s["name"]).count("<f")
            print(f"[{s['state']:7s}] {size:7.2f} MB  f={nf:7d}  {s['name']}")

    elif cmd == "rows":
        sheet, rows = sys.argv[2], parse_rows(sys.argv[3] if len(sys.argv) > 3 else None)
        last = None
        for row, col, formula, value in book.cells(sheet, rows=rows):
            if row != last:
                print(f"--- row {row} ---")
                last = row
            text = ("=" + formula.replace("\n", " ") if formula else "") + (
                ("  -> " if formula else "") + str(value) if value is not None else ""
            )
            print(f"  {col}{row:<6} {text}")

    elif cmd == "cols":
        sheet = sys.argv[2]
        cols = set(sys.argv[3].split(","))
        rows = parse_rows(sys.argv[4] if len(sys.argv) > 4 else None)
        for row, col, formula, value in book.cells(sheet, rows=rows, cols=cols):
            text = ("=" + formula.replace("\n", " ") if formula else "") + (
                ("  -> " if formula else "") + str(value) if value is not None else ""
            )
            print(f"  {col}{row:<6} {text}")

    elif cmd == "grep":
        needle = sys.argv[2]
        for s in book.sheets:
            hits = [f for f in book.formulas(s["name"]).split("\n") if needle in f]
            if hits:
                print(f"=== {s['name']}  ({len(hits)} hits)")
                for h in hits[:5]:
                    print("   ", h[:240])

    else:
        print(__doc__)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
