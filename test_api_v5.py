"""V5 integration tests. All data goes into a temporary directory; never touches live data."""
import os, json, subprocess, tempfile, time, socket, urllib.request, urllib.error, uuid, shutil, base64
from pathlib import Path
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
root=Path(__file__).resolve().parent.parent
with socket.socket() as x:
 x.bind(('127.0.0.1',0)); port=x.getsockname()[1]
pw='TestPassword2026-Long!'
tmp=Path(tempfile.mkdtemp(prefix='halabv5-test-'))
proc=subprocess.Popen(['node','server.js'],cwd=root,env={**os.environ,'PORT':str(port),'DATA_DIR':str(tmp),'ADMIN_PASSWORD':pw,'AUTO_SYNC_IMAGES':'0'},stdout=subprocess.PIPE,stderr=subprocess.STDOUT, text=True)
base='http://127.0.0.1:'+str(port)

def req(endpoint, method='GET', body=None, cookie=None):
 headers={'X-Requested-With':'HalabAdmin'}
 if body is not None: headers['Content-Type']='application/json'
 if cookie: headers['Cookie']=cookie
 r=urllib.request.Request(base+endpoint,method=method,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),headers=headers)
 try:
  with urllib.request.urlopen(r,timeout=20) as resp:return resp.status,json.loads(resp.read()),resp.headers
 except urllib.error.HTTPError as e:
  return e.code,json.loads(e.read()),e.headers

def success(endpoint,method='GET',body=None,cookie=None,status=200):
 code,obj,headers=req(endpoint,method,body,cookie)
 assert code==status,(endpoint,code,obj)
 return obj

def blocked(endpoint,method='GET',body=None,cookie=None, codes=(400,403,409)):
 code,obj,_=req(endpoint,method,body,cookie)
 assert code in codes,(endpoint,code,obj)
 return obj

try:
 for _ in range(60):
  try:
   if req('/api/health')[0]==200:break
  except (ConnectionRefusedError, OSError):time.sleep(.12)
 else:raise RuntimeError('Server not started')
 _,_,head=req('/api/admin/login','POST',{'username':'admin','password':pw});admin=head['Set-Cookie'].split(';')[0]
 success('/api/admin/users','POST',{'username':'cashier5','password':'CashierLong2026Pass','role':'cashier'},admin,201)
 _,_,head=req('/api/admin/login','POST',{'username':'cashier5','password':'CashierLong2026Pass'});cashier=head['Set-Cookie'].split(';')[0]
 raw=success('/api/admin/menu',cookie=admin);public=success('/api/menu');assert raw['sections']==public['sections']
 available=[(s,it) for s in raw['sections'] for it in s['items'] if not it.get('off') and not it.get('hidden') and not s.get('disabled') and not s.get('hidden') and not it.get('variants') and it['price']>=10]
 (sec,product),(sec2,p2)=available[:2];baseprice=product['price']
 print('Catalog:',len(available),'sample',product['name'],baseprice)
 blocked('/api/admin/bulk','POST',{'section':sec['name'],'action':'raise_percent','percent':10},cashier,codes=(403,))
 blocked('/api/admin/pricing-schedules','PUT',{'schedules':[]},cashier,codes=(403,))
 blocked('/api/admin/backups','POST',{},cashier,codes=(403,))
 blocked('/api/admin/backups/download?name=../../data/users.json','GET',cookie=admin,codes=(400,))
 print('Roles OK')
 # Bulk: increasing a section modifies both base and variant prices.
 before={it['name']:(it['price'],dict(it.get('variants') or {})) for it in sec['items']}
 bulk=success('/api/admin/bulk','POST',{'section':sec['name'],'action':'raise_percent','percent':12.5},admin)
 assert bulk['changed']==len(sec['items'])
 updated=success('/api/admin/menu',cookie=admin)
 newsec=next(s for s in updated['sections'] if s['name']==sec['name'])
 for it in newsec['items']:
  old,variants=before[it['name']]
  assert it['price']==round(old*1.125+1e-7,2),it['name']
  for k,v in variants.items():assert it['variants'][k]==round(v*1.125+1e-7,2)
 changedPrice=next(it for it in newsec['items'] if it['name']==product['name'])['price']
 print('Bulk price changes:',bulk['changed'])
 blocked('/api/admin/bulk','POST',{'items':[product['name'],'NOTEXIST'],'action':'availability','state':'off'},admin)
 success('/api/admin/bulk','POST',{'items':[product['name']],'action':'availability','state':'off'},admin)
 blocked('/api/orders','POST',{'type':'pickup','items':[{'name':product['name'],'quantity':1,'unitPrice':changedPrice}]},codes=(400,))
 success('/api/admin/bulk','POST',{'items':[product['name']],'action':'availability','state':'available'},admin)
 
 # Schedules - dynamically applied at server request time, base persisted unchanged.
 cairo=ZoneInfo('Africa/Cairo');now=datetime.now(cairo)
 start=(now-timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M');end=(now+timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M')
 future=(now+timedelta(days=1)).strftime('%Y-%m-%dT%H:%M');future_end=(now+timedelta(days=2)).strftime('%Y-%m-%dT%H:%M')
 pid=str(uuid.uuid4())
 scheduled={'id':pid,'scope':'product','target':product['name'],'variant':'','type':'percent_off','value':20,'startAt':start,'endAt':end,'enabled':True}
 future_rule={'id':str(uuid.uuid4()),'scope':'product','target':p2['name'],'variant':'','type':'percent_off','value':70,'startAt':future,'endAt':future_end,'enabled':True}
 success('/api/admin/pricing-schedules','PUT',{'schedules':[scheduled,future_rule]},admin)
 effective=success('/api/menu');it=next(it for s in effective['sections'] for it in s['items'] if it['name']==product['name']);discounted=round(changedPrice*.8+1e-8,2)
 assert it['price']==discounted,(it['price'],discounted)
 assert next(it for s in effective['sections'] for it in s['items'] if it['name']==p2['name'])['price']!=round(p2['price']*.3,2)
 assert next(it for s in success('/api/admin/menu',cookie=admin)['sections'] for it in s['items'] if it['name']==product['name'])['price']==changedPrice
 blocked('/api/admin/pricing-schedules','PUT',{'schedules':[{**scheduled,'endAt':start}]},admin)
 blocked('/api/admin/pricing-schedules','PUT',{'schedules':[{**scheduled,'target':'invalid name'}]},admin)
 blocked('/api/admin/pricing-schedules','PUT',{'schedules':[{**scheduled,'value':140}]},admin)
 print('Schedules active/future and raw menu protection OK')
 # Price check must use server scheduled price, client cannot send stale price.
 def makeitem(name,price,source=''):
  return {'name':name,'weight':'','quantity':1,'unitPrice':price,'addons':[],'suggestedBy':source}
 preview={'type':'pickup','customer':'اختبار','items':[makeitem(product['name'],changedPrice)]}
 blocked('/api/pricing','POST',preview,codes=(409,))
 success('/api/pricing','POST',{**preview,'items':[makeitem(product['name'],discounted)]})
 
 # Store recommendation mapping, then record an attributed sale and a co-purchase.
 menu=success('/api/admin/menu',cookie=admin)
 setting=menu.setdefault('settings',{}).setdefault('upsell',{'enabled':True,'limit':3,'items':[]})
 setting.setdefault('items',[]);setting['byProduct']={p2['name']:[product['name']]}
 success('/api/admin/menu','PUT',menu,admin)
 second=next(i for s in success('/api/menu')['sections'] for i in s['items'] if i['name']==p2['name'])
 order={'type':'pickup','customer':'تحليل تجريبي','items':[makeitem(p2['name'],second['price']),makeitem(product['name'],discounted,p2['name'])],'requestId':str(uuid.uuid4())}
 result=success('/api/orders','POST',order,status=201)
 success('/api/admin/orders/'+result['id'],'PATCH',{'status':'delivered'},cashier)
 analytic=success('/api/admin/basket-analytics',cookie=cashier)
 assert analytic['count']==1 and analytic['upsell']['orders']==1 and analytic['upsell']['units']==1
 assert analytic['suggestions'][0]['name']==product['name'] and analytic['sources'][0]['source']==p2['name']
 assert any(set(z['products'])=={product['name'],p2['name']} for z in analytic['pairs'])
 print('Attribution and co-purchase OK')
 # a falsified attribution should not be accepted as upsell
 order2={'type':'pickup','customer':'تزييف إسناد','items':[makeitem(product['name'],discounted,'لا يوجد')],'requestId':str(uuid.uuid4())}
 r=success('/api/orders','POST',order2,status=201)
 success('/api/admin/orders/'+r['id'],'PATCH',{'status':'delivered'},cashier)
 analytic=success('/api/admin/basket-analytics',cookie=admin)
 assert analytic['count']==2 and analytic['upsell']['orders']==1
 print('Unverified attribution filtered')
 # Snapshot restore covers orders, menu, promotions, pricing schedules; keeps user credentials.
 png=b'\x89PNG\r\n\x1a\n'+b'x'*42
 upload=success('/api/admin/upload','POST',{'data':'data:image/png;base64,'+base64.b64encode(png).decode()},admin,status=201)
 assert upload['url'].startswith('/assets/uploads/')
 backup=success('/api/admin/backups','POST',{},admin,status=201)
 listed=success('/api/admin/backups',cookie=admin)['backups']
 assert any(x['name']==backup['name'] for x in listed)
 rq=urllib.request.Request(base+'/api/admin/backups/download?name='+backup['name'],headers={'Cookie':admin})
 saved=json.loads(urllib.request.urlopen(rq).read())
 assert saved['format']=='halab-v5-backup' and saved['files']['orders.json'] and saved['uploads']
 success('/api/admin/bulk','POST',{'items':[product['name']],'action':'availability','state':'hidden'},admin)
 success('/api/admin/pricing-schedules','PUT',{'schedules':[]},admin)
 result=success('/api/admin/backups/restore','POST',{'name':backup['name'],'confirm':'RESTORE'},admin)
 assert result['safetyBackup']
 assert len(success('/api/admin/pricing-schedules',cookie=admin)['schedules'])==2
 assert not next(it for s in success('/api/admin/menu',cookie=admin)['sections'] for it in s['items'] if it['name']==product['name']).get('hidden',False)
 assert len(success('/api/admin/orders',cookie=admin)['orders'])==2
 # imported backup and admin login still works
 success('/api/admin/backups/restore','POST',{'backup':saved,'confirm':'RESTORE'},admin)
 _,body,h=req('/api/admin/login','POST',{'username':'cashier5','password':'CashierLong2026Pass'});assert body['ok']
 bad= json.loads(json.dumps(saved));bad['files']['menu.json']['sections'][0]['items'][0]['price']=-123
 blocked('/api/admin/backups/restore','POST',{'backup':bad,'confirm':'RESTORE'},admin)
 assert next(it for s in success('/api/admin/menu',cookie=admin)['sections'] for it in s['items'] if it['name']==product['name'])['price']==changedPrice
 print('Backup export/list/restore/upload-images/safety-snapshot/invalid-restores OK')
 print('ALL V5 API TESTS PASSED')
finally:
 proc.terminate()
 try:out,_=proc.communicate(timeout=5)
 except subprocess.TimeoutExpired:proc.kill();out,_=proc.communicate()
 if 'ALL V5' not in locals().get('message','') and 'Traceback' in out:print(out[-3000:])
 shutil.rmtree(tmp,ignore_errors=True)
