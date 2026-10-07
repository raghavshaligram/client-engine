"""Clicks through the whole app in a real browser: key gate, products, inboxes, import, website reading,
drafting, approving, Gmail sending, reply checking and answering, results. Google and Gmail are mocked."""
import base64, json, os, re, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp'
PORT = 8899
srv = subprocess.Popen(['node', os.path.join(ROOT, 'test/devserver.mjs'), str(PORT)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
assert 'ready' in srv.stdout.readline()
site_port = urllib.request.urlopen(f'http://127.0.0.1:{PORT}/__siteport').read().decode()
BASE = f'http://127.0.0.1:{PORT}/'
SENDER = 'raghav@getringsparrow.co'

csv_path = os.path.join(OUT, 'results.csv')
with open(csv_path, 'w') as f:
    f.write('input_id,link,title,category,address,website,phone,review_count,review_rating,emails,status,complete_address\n')
    f.write(f'1,https://maps/x,Acme Plumbing,Plumber,"1 Main St, Austin, TX 78701, United States",http://acme.test:{site_port}/acme,(512) 555-0100,120,4.7,"bob@acme.test, noreply@acme.test",,\n')
    f.write(f'2,https://maps/y,Busy HVAC,HVAC contractor,"9 Oak Rd, Austin, TX 78702, United States",http://busy.test:{site_port}/busy,(512) 555-0101,40,4.2,jane@busy.test,,\n')
    f.write('3,https://maps/z,Roto-Rooter Plumbing,Plumber,"5 Elm, Austin, TX 78703, United States",https://rotorooter.com,(512) 555-0102,900,4.1,x@rotorooter.com,,\n')

FAKE_GIS = """window.google={accounts:{oauth2:{initTokenClient(cfg){return{requestAccessToken(){setTimeout(()=>cfg.callback({access_token:'tok-'+cfg.hint,expires_in:3600}),10)}}}}}};"""
sent = []
def b64(s): return base64.urlsafe_b64encode(s.encode()).decode().rstrip('=')

def gmail(route):
    url = route.request.url
    if url.endswith('/profile'):
        return route.fulfill(json={'emailAddress': SENDER})
    if url.endswith('/messages/send'):
        body = json.loads(route.request.post_data)
        raw = base64.urlsafe_b64decode(body['raw'] + '==').decode()
        sent.append({'raw': raw, 'threadId': body.get('threadId')})
        n = len(sent)
        return route.fulfill(json={'id': f'gm{n}', 'threadId': body.get('threadId') or f'th{n}'})
    m = re.search(r'/messages/(\w+)\?format=metadata', url)
    if m:
        return route.fulfill(json={'id': m.group(1), 'threadId': 'th1', 'payload': {'headers': [{'name': 'Message-ID', 'value': f'<{m.group(1)}@mail.gmail.com>'}, {'name': 'Subject', 'value': 'Re: missed calls at Acme'}]}})
    if '/threads/th1' in url:
        return route.fulfill(json={'id': 'th1', 'messages': [
            {'id': 'gm1', 'payload': {'headers': [{'name': 'From', 'value': f'Raghav <{SENDER}>'}]}},
            {'id': 'rp1', 'internalDate': str(int(time.time() * 1000)), 'snippet': 'Sure',
             'payload': {'mimeType': 'text/plain', 'headers': [{'name': 'From', 'value': 'Bob <bob@acme.test>'}, {'name': 'Subject', 'value': 'Re: missed calls at Acme'}],
                         'body': {'data': b64('Sure, send the video please.\n\nOn Tue, Raghav wrote:\n> Hi Bob')}}}]})
    return route.fulfill(status=404, json={'error': {'message': 'not mocked ' + url}})

errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': 1280, 'height': 900})
        pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(body=FAKE_GIS, content_type='text/javascript'))
        pg.route('https://gmail.googleapis.com/**', gmail)
        pg.add_init_script('window.CE_TEST_GAP = 300; window.confirm = () => true;')
        pg.goto(BASE)

        # Gate
        pg.fill('#keyIn', 'wrong'); pg.click('#keyBtn'); expect(pg.locator('#keyErr')).to_contain_text('Wrong app key')
        pg.fill('#keyIn', 'test-key'); pg.click('#keyBtn'); expect(pg.locator('#title')).to_have_text('Today')
        pg.click('#productSeg button[data-p=ringsparrow]')
        expect(pg.locator('.note.warn')).to_contain_text('postal address')
        pg.screenshot(path=f'{OUT}/01-today-empty.png', full_page=True)

        # Product file
        pg.click('nav button[data-view=products]')
        pg.fill('[data-k=from_name]', 'Raghav Shaligram'); pg.fill('[data-k=postal_address]', 'PO Box 1, Austin, TX 78701')
        pg.click('#pSave'); expect(pg.locator('#toast')).to_have_text('Saved.')
        pg.screenshot(path=f'{OUT}/02-products.png', full_page=True)

        # Inbox: refuses a product domain, accepts a sending domain
        pg.click('nav button[data-view=settings]')
        pg.fill('#sTbl [data-f=email]', 'me@ringsparrow.com'); pg.click('#sSave')
        expect(pg.locator('#toast')).to_contain_text("Don't cold-email")
        pg.fill('#sTbl [data-f=email]', SENDER)
        pg.select_option('#sTbl [data-f=product_id]', 'ringsparrow')
        pg.select_option('#sTbl [data-f=segment]', 'trades')
        pg.select_option('#sTbl [data-f=mode]', 'browser')
        pg.check('#sTbl [data-f=warmed]')
        pg.fill('#sTbl [data-f=daily_cap]', '5'); pg.click('#sSave'); expect(pg.locator('#toast')).to_have_text('Saved.')
        expect(pg.locator('#sTbl')).to_contain_text('up to 5 cold emails today')
        pg.screenshot(path=f'{OUT}/03-settings.png', full_page=True)

        # Find: queries file, import, read sites
        pg.click('nav button[data-view=find]')
        pg.select_option('#fSeg', 'trades')
        pg.fill('#fTypes', 'plumber\nhvac contractor'); pg.fill('#fCities', 'Austin, TX\nDenver, CO')
        with pg.expect_download() as dl: pg.click('#fQueries')
        q = open(dl.value.path()).read()
        assert q == 'plumber in Austin, TX\nhvac contractor in Austin, TX\nplumber in Denver, CO\nhvac contractor in Denver, CO\n', q
        pg.click('#fPlan'); expect(pg.locator('#toast')).to_contain_text('4 searches added')
        expect(pg.locator('#fPlanList')).to_contain_text('4 searches in the plan, 4 not run yet')
        pg.set_input_files('#fFile', csv_path)
        expect(pg.locator('#fOut')).to_contain_text('2 people added')
        expect(pg.locator('#fOut')).to_contain_text('chain or franchise')
        pg.click('#fScan'); expect(pg.locator('#fScanLog')).to_contain_text('All read', timeout=15000)
        pg.screenshot(path=f'{OUT}/04-find.png', full_page=True)

        # Prospects
        pg.click('nav button[data-view=prospects]')
        expect(pg.locator('table')).to_contain_text('Acme Plumbing')
        pg.screenshot(path=f'{OUT}/05-prospects.png', full_page=True)

        # Queue: draft, edit, approve
        pg.click('nav button[data-view=queue]')
        pg.select_option('#qN', '5'); pg.click('#qWrite')
        expect(pg.locator('#qLog')).to_contain_text('new draft', timeout=15000)
        expect(pg.locator('.mail-card').first).to_be_visible(timeout=5000)
        pg.screenshot(path=f'{OUT}/06-queue.png', full_page=True)
        n_cards = pg.locator('.mail-card').count()
        assert n_cards == 2, n_cards
        first = pg.locator('.mail-card').first
        first.locator('[data-f=body]').fill(first.locator('[data-f=body]').input_value() + '\nThanks!')
        first.locator('button[data-a=approve]').click()
        expect(pg.locator('.mail-card .pill.good')).to_have_count(1)
        expect(pg.locator('#nQueue')).to_have_text('2')

        # Send
        pg.click('nav button[data-view=send]')
        expect(pg.locator('#view')).to_contain_text('1 approved email waiting')
        pg.click('tr[data-e] button[data-a=start]')
        expect(pg.locator('#sLog')).to_contain_text('sent to Acme Plumbing', timeout=10000)
        expect(pg.locator('#sLog')).to_contain_text('No approved emails waiting', timeout=10000)
        pg.screenshot(path=f'{OUT}/07-send.png', full_page=True)
        assert len(sent) == 1
        raw = sent[0]['raw']
        assert 'To: bob@acme.test' in raw and 'From: Raghav Shaligram <raghav@getringsparrow.co>' in raw, raw[:400]
        body = base64.b64decode(raw.split('\r\n\r\n', 1)[1].replace('\r\n', '')).decode()
        assert 'PO Box 1, Austin, TX 78701' in body and "Reply \"no\" and I won't email you again." in body and 'Thanks!' in body, body
        assert 'utm_' not in body and '<img' not in body

        # Replies
        pg.click('nav button[data-view=replies]')
        pg.click('#rCheck'); expect(pg.locator('#rLog')).to_contain_text('1 new reply', timeout=10000)
        expect(pg.locator('.card[data-id]')).to_contain_text('Sure, send the video please.', timeout=5000)
        assert 'Hi Bob' not in pg.locator('.card[data-id]').inner_text(), 'quoted text should be stripped'
        expect(pg.locator('.card[data-id] .pill')).to_have_text('Interested')
        pg.screenshot(path=f'{OUT}/08-replies.png', full_page=True)
        pg.click('.card[data-id] button[data-a=send]')
        expect(pg.locator('#toast')).to_have_text('Sent.')
        assert len(sent) == 2 and sent[1]['threadId'] == 'th1' and 'In-Reply-To: <rp1@mail.gmail.com>' in sent[1]['raw'], sent[1]['raw'][:500]

        # Results and Today
        pg.click('nav button[data-view=results]')
        expect(pg.locator('#view')).to_contain_text('people emailed')
        pg.screenshot(path=f'{OUT}/09-results.png', full_page=True)
        pg.click('nav button[data-view=today]')
        expect(pg.locator('.stat').first).to_be_visible()
        expect(pg.locator('#view')).to_contain_text('Autopilot: Learning')
        expect(pg.locator('#view')).to_contain_text('approved 1 of 50 first emails')
        pg.click('[data-run="autopilot.research"]'); expect(pg.locator('#apLog')).to_be_visible()
        pg.select_option('#apMode', 'on'); expect(pg.locator('#view')).to_contain_text('Autopilot: On')
        pg.screenshot(path=f'{OUT}/10-today.png', full_page=True)

        # Phone width
        pg.set_viewport_size({'width': 390, 'height': 844})
        pg.click('nav button[data-view=queue]'); pg.wait_for_timeout(500)
        sw = pg.evaluate('document.documentElement.scrollWidth')
        assert sw <= 392, f'horizontal scroll at phone width: {sw}'
        pg.screenshot(path=f'{OUT}/11-queue-phone.png', full_page=True)
        b.close()
finally:
    srv.terminate()

errors = [e for e in errors if 'favicon' not in e and '401' not in e]  # 401 = the deliberate wrong-key check
assert not errors, errors
print('BROWSER TEST PASSED')
