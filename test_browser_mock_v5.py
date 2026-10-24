"""Offline Chromium UI test (mock network; real server API tested separately)."""
from playwright.sync_api import sync_playwright
from pathlib import Path
import json,re
root=Path(__file__).resolve().parent.parent
html=re.sub(r'<script src="/admin.js" defer></script>','', (root/'public/admin.html').read_text())
script=(root/'public/admin.js').read_text()
menu=json.loads((root/'seed/menu.json').read_text())
with sync_playwright() as pl:
 browser=pl.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 page=browser.new_page(viewport={'width':1280,'height':840})
 errors=[]
 page.on('pageerror',lambda e: errors.append(str(e)))
 page.set_content(html,wait_until='domcontentloaded')
 page.evaluate('''(initialMenu)=>{
  window.__fake={menu:initialMenu,schedules:[],backups:[]};
  window.fetch=async (url,opts={})=>{
   const method=opts.method||'GET',db=window.__fake;
   let body=opts.body?JSON.parse(opts.body):null,result={ok:true};
   if(url==='/api/admin/session')result={authenticated:true,role:'admin',username:'admin'};
   else if(url==='/api/admin/menu'&&method==='GET'||url==='/api/menu')result=db.menu;
   else if(url==='/api/admin/users')result={users:[{id:'a',username:'admin',role:'admin'}]};
   else if(url==='/api/admin/orders')result={orders:[]};
   else if(url==='/api/admin/report')result={summary:{orders:0,cancelled:0,revenue:0},daily:{},monthly:{},items:{},orders:[]};
   else if(url==='/api/admin/basket-analytics')result={count:0,upsell:{orders:0,units:0,revenue:0},suggestions:[],sources:[],pairs:[]};
   else if(url==='/api/admin/pricing-schedules'){
    if(method==='GET')result={schedules:db.schedules};else{db.schedules=body.schedules;result={ok:true};}
   }
   else if(url==='/api/admin/backups'){
    if(method==='GET')result={backups:db.backups};else{db.backups.push({name:'halab-2026-10-24T00-00-00-000Z-abcdef.json',size:100});}
   }
   else if(url==='/api/admin/images')result={cached:0,total:0};
   else if(url==='/api/admin/promotions')result={coupons:[],bundles:[],usage:{}};
   return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
  };
 }''',menu)
 page.add_script_tag(content=script)
 page.locator('#sideNav button').first.wait_for(timeout=10000)
 for label in ['جدولة الأسعار','التعديل الجماعي','تحليل السلة','النسخ الاحتياطي']:
  page.locator('#sideNav button').filter(has_text=label).click()
  assert page.locator('#content').inner_text().strip(),label
 page.locator('#sideNav button').filter(has_text='جدولة الأسعار').click()
 page.locator('[data-schedule-edit=new]').click()
 assert page.locator('#scScope').count()
 page.locator('#scTarget').select_option(label='ساندوتش زنجر')
 page.locator('#scValue').fill('10')
 page.locator('#scEnd').fill('2027-12-30T22:00')
 page.locator('#scheduleForm .btn.primary').click()
 page.wait_for_timeout(350)
 assert page.locator('#content').inner_text().find('ساندوتش زنجر')!=-1
 page.locator('#sideNav button').filter(has_text='التعديل الجماعي').click()
 assert page.locator('[data-bulk-item]').count()>100
 page.locator('[data-bulk-item]').first.check()
 assert page.locator('[data-bulk-item]').first.is_checked()
 page.locator('#sideNav button').filter(has_text='النسخ الاحتياطي').click()
 page.locator('[data-backup-create]').click()
 page.wait_for_timeout(350)
 assert page.locator('[data-backup-restore]').count()>0
 assert not errors,errors
 print('ALL ADMIN V5 MOCKED BROWSER TESTS PASSED')
 browser.close()
