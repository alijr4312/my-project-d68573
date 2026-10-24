"""Browser smoke tests using a local isolated instance and system Chromium."""
from playwright.sync_api import sync_playwright
import tempfile, subprocess, os, socket, time, shutil
from pathlib import Path
root=Path(__file__).resolve().parent.parent
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
tmp=Path(tempfile.mkdtemp(prefix='halab-browser-v5-'))
proc=subprocess.Popen(['node','server.js'],cwd=root,env={**os.environ,'PORT':str(port),'DATA_DIR':str(tmp),'ADMIN_PASSWORD':'BrowserTestStrongPassword#2026','AUTO_SYNC_IMAGES':'0'},stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
base=f'http://127.0.0.1:{port}'
errors=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
  page=browser.new_page(viewport={'width':1300,'height':900},locale='ar-EG')
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(base+'/admin',wait_until='domcontentloaded',timeout=30000)
  page.locator('#authPass').fill('BrowserTestStrongPassword#2026')
  page.locator('#authSubmit').click()
  page.locator('#sideNav').wait_for(state='visible',timeout=20000)
  assert page.get_by_text('جدولة الأسعار').count()>0
  for tab in ['جدولة الأسعار','التعديل الجماعي','تحليل السلة','النسخ الاحتياطي']:
   page.locator('#sideNav button').filter(has_text=tab).click()
   page.wait_for_timeout(250)
   assert page.locator('#content').inner_text().strip(), tab
  page.locator('#sideNav button').filter(has_text='جدولة الأسعار').click()
  page.get_by_text('جدول جديد').click()
  assert page.locator('#scScope').count() and page.locator('#scStart').count()
  page.locator('[data-close]').click()
  page.locator('#sideNav button').filter(has_text='التعديل الجماعي').click()
  assert page.locator('[data-bulk-item]').count()>100
  page.locator('[data-bulk-item]').first.check()
  assert page.locator('[data-bulk-item]').first.is_checked()
  page.locator('#sideNav button').filter(has_text='النسخ الاحتياطي').click()
  page.locator('[data-backup-create]').click()
  page.locator('[data-backup-restore]').first.wait_for(timeout=15000)
  assert page.locator('[data-backup-restore]').count()>0
  print('Admin UI OK')
  customer=browser.new_page(viewport={'width':420,'height':900},locale='ar-EG')
  customer.on('pageerror',lambda e:errors.append('customer: '+str(e)))
  customer.goto(base+'/',wait_until='domcontentloaded',timeout=30000)
  customer.wait_for_timeout(3200)
  assert customer.locator('#sections').count()>0
  # Check live menu + current shopping cart rendering does not throw JS error.
  customer.evaluate("window.scrollTo(0,500)")
  print('Client UI OK')
  if errors: raise AssertionError('\n'.join(errors[:10]))
  print('ALL V5 BROWSER SMOKE TESTS PASSED')
  browser.close()
finally:
 proc.terminate()
 try:output,_=proc.communicate(timeout=3)
 except subprocess.TimeoutExpired:proc.kill();output,_=proc.communicate()
 if errors:print('BROWSER ERRORS',errors[:10])
 shutil.rmtree(tmp,ignore_errors=True)
