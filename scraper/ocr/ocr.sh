#!/bin/sh
# For every PDF in the work folder, write <name>.txt with the text of its first two pages.
# Uses the PDF's own text when it has some; otherwise renders the pages and runs OCR.
WORK="${1:-/work}"
for f in "$WORK"/*.pdf; do
  [ -e "$f" ] || continue
  out="${f%.pdf}.txt"
  [ -s "$out" ] && continue
  pdftotext -l 2 "$f" "$out" 2>/dev/null || : > "$out"
  if [ "$(wc -w < "$out")" -lt 30 ]; then
    rm -f "${f%.pdf}"-p*.png
    pdftoppm -r 200 -l 2 -gray -png "$f" "${f%.pdf}-p" 2>/dev/null
    : > "$out"
    for p in "${f%.pdf}"-p*.png; do
      [ -e "$p" ] && tesseract "$p" - 2>/dev/null >> "$out"
    done
    rm -f "${f%.pdf}"-p*.png
  fi
done
