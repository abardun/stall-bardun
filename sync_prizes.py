#!/usr/bin/env python3
"""
sync_prizes.py — Bardun Stall AB
Reads earnings from each horse's profile page and updates the prize money
boxes in stallbardun.html automatically.

Run: python3 sync_prizes.py
"""

import re
import os

FOLDER = os.path.dirname(os.path.abspath(__file__))

# Map: horse id in stallbardun.html → source profile file
HORSES = {
    "metarie-prize":  "metarie.html",
    "floripa-prize":  "floripa.html",
    "bandida-prize":  "bandida.html",
}

def fmt_sek(amount):
    """Format integer as Swedish kronor, e.g. 356000 → '356 000 kr'"""
    if not amount:
        return "—"
    # Swedish thousands separator is a space
    s = f"{int(amount):,}".replace(",", "\u00a0")  # non-breaking space
    return f"{s}\u00a0kr"

def extract_earnings(filepath):
    """Pull the earnings figure from the horse's summary JS object."""
    try:
        with open(filepath, encoding="utf-8") as f:
            content = f.read()
        m = re.search(r'"earnings"\s*:\s*(\d+)', content)
        return int(m.group(1)) if m else 0
    except FileNotFoundError:
        return 0

def update_stallbardun(prizes):
    """Replace the text content of each prize span in stallbardun.html."""
    path = os.path.join(FOLDER, "stallbardun.html")
    with open(path, encoding="utf-8") as f:
        html = f.read()

    for span_id, value in prizes.items():
        # Match: id="metarie-prize">...< and replace inner text
        pattern = rf'(<span[^>]*id="{re.escape(span_id)}"[^>]*>)[^<]*(</span>)'
        replacement = rf'\g<1>{value}\g<2>'
        html, n = re.subn(pattern, replacement, html)
        status = "updated" if n else "NOT FOUND"
        print(f"  {span_id}: {value}  [{status}]")

    with open(path, "w", encoding="utf-8") as f:
        f.write(html)

def main():
    print("Bardun prize sync — starting\n")
    prizes = {}
    for span_id, filename in HORSES.items():
        filepath = os.path.join(FOLDER, filename)
        earnings = extract_earnings(filepath)
        prizes[span_id] = fmt_sek(earnings)
        print(f"  {filename}: {earnings} → {prizes[span_id]}")

    print("\nWriting to stallbardun.html...")
    update_stallbardun(prizes)
    print("\nDone.")

if __name__ == "__main__":
    main()
