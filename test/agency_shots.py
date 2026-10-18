"""Screenshots of the client-facing agency pages at phone and desktop widths."""
import os, subprocess, sys
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1]
subprocess.run(['node', os.path.join(ROOT, 'test/agency_shots.mjs'), OUT], check=True)
with sync_playwright() as p:
    b = p.chromium.launch()
    for name in sorted(f for f in os.listdir(OUT) if f.endswith('.html')):
        for w, h, tag in [(1280, 900, 'desktop'), (390, 844, 'phone')]:
            pg = b.new_page(viewport={'width': w, 'height': h})
            pg.route('**/fonts.googleapis.com/**', lambda r: r.abort())
            pg.goto('file://' + os.path.join(OUT, name))
            pg.screenshot(path=os.path.join(OUT, f'{name[:-5]}-{tag}.png'), full_page=True)
            pg.close()
    b.close()
print('shots done')
