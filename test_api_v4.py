from pathlib import Path
import os,subprocess,tempfile,time,json,urllib.request,urllib.error,uuid,shutil
root=Path(__file__).resolve().parent.parent;tmp=Path(tempfile.mkdtemp(prefix='hsv4-'));shutil.copy2(root/'seed/menu.json',tmp/'menu.json');(tmp/'orders.json').write_text('[]');pw='ThisIsStrongAdmin#2026';port=37549
proc=subprocess.Popen(['node','server.js'],cwd=root,env={**os.environ,'PORT':str(port),'DATA_DIR':str(tmp),'ADMIN_PASSWORD':pw,'AUTO_SYNC_IMAGES':'0'},stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
base=f'http://localhost:{port}'
def req(path,method='GET',body=None,cookie=None):
 data=json.dumps(body).encode() if body is not None else None
 headers={'Content-Type':'application/json','X-Requested-With':'HalabAdmin'}
 if cookie:headers['Cookie']=cookie
 r=urllib.request.Request(base+path,data=data,method=method,headers=headers)
 try:
  with urllib.request.urlopen(r,timeout=10) as x:return x.status,json.loads(x.read()),x.headers
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read()),e.headers
try:
 for _ in range(50):
  try:
   if req('/api/health')[0]==200:break
  except:time.sleep(.2)
 else:raise Exception('Not started')
 status,b,heads=req('/api/admin/login','POST',{'username':'admin','password':pw});assert status==200,(status,b)
 cookie=heads['Set-Cookie'].split(';')[0]
 print('AUTH',req('/api/admin/session',cookie=cookie)[1]);assert req('/api/admin/users',cookie=cookie)[0]==200
 status,b,_=req('/api/admin/users','POST',{'username':'cashier1','password':'SuperCashierPass!','role':'cashier'},cookie);assert status==201,(status,b)
 cstatus,cb,ch=req('/api/admin/login','POST',{'username':'cashier1','password':'SuperCashierPass!'});assert cstatus==200
 cashier=ch['Set-Cookie'].split(';')[0];assert req('/api/admin/menu','PUT',{},cashier)[0]==403
 # configure test addon item
 menu=req('/api/menu')[1];item=next(it for x in menu['sections'] for it in x['items'] if not it.get('variants') and not it.get('off'))
 name=item['name'];print('ITEM',name,item['price']);g={'id':'cheese-test','name':'جبنة','required':True,'options':[{'name':'زيادة جبنة','price':9}]}
 menu['settings']['addonGroups']=[g];item['addonGroups']=['cheese-test'];menu['settings']['upsell']['byProduct']={name:[next(x['name'] for x in menu['sections'][0]['items'] if x['name']!=name)]};menu['settings']['minimumOrder']=0
 status,b,_=req('/api/admin/menu','PUT',menu,cookie);assert status==200,(status,b)
 status,b,_=req('/api/admin/promotions','PUT',{'coupons':[{'code':'SAVE10','type':'percent','value':10,'maxUses':1,'minSubtotal':0,'enabled':True,'expires':''}],'bundles':[]},cookie);assert status==200,(status,b)
 body={'type':'pickup','customer':'تجربة','items':[{'name':name,'weight':'','addons':[{'groupId':'cheese-test','name':'زيادة جبنة'}],'quantity':1,'unitPrice':item['price']+9}],'coupon':'SAVE10','requestId':str(uuid.uuid4())}
 assert req('/api/orders','POST',{**body,'items':[{'name':name,'weight':'','addons':[],'quantity':1,'unitPrice':item['price']}]})[0]==400
 status,b,_=req('/api/pricing','POST',body);assert status==200,(status,b);print('PRICING',b)
 status,b,_=req('/api/orders','POST',body);assert status==201,(status,b);assert b['discount']>0
 status,b2,_=req('/api/orders','POST',body);assert status==200 and b2['alreadySaved'],(status,b2)
 body['requestId']=str(uuid.uuid4());assert req('/api/orders','POST',body)[0]==400 # coupon exhausted
 orderid=b['id'];assert req('/api/admin/orders/'+orderid,'PATCH',{'status':'onway'},cashier)[0]==200
 r=req('/api/admin/report',cookie=cashier);assert r[0]==200,r;print('REPORT',r[1]['summary']);assert r[1]['summary']['revenue']>0

 print('Testing reports.xlsx...')
 rq=urllib.request.Request(base+'/api/admin/report.xlsx',headers={'Cookie':cashier});res=urllib.request.urlopen(rq);payload=res.read()
 from io import BytesIO
 import zipfile,xml.etree.ElementTree as ET
 with zipfile.ZipFile(BytesIO(payload)) as z:
  assert z.testzip() is None
  print('XLSX entries',len(z.namelist()))
  for n in z.namelist():
   if n.endswith('.xml') or n.endswith('.rels'):
    ET.fromstring(z.read(n))
 # disable section then test API
 menu=req('/api/menu')[1];baseitem=next(x for s in menu['sections'] for x in s['items'] if x['name']==name)
 section=next(s for s in menu['sections'] if any(x['name']==name for x in s['items']))
 section['disabled']=True
 assert req('/api/admin/menu','PUT',menu,cookie)[0]==200
 no_coupon={**body,'coupon':'','requestId':str(uuid.uuid4())}
 assert req('/api/orders','POST',no_coupon)[0]==400
 section['disabled']=False
 menu['settings']['schedule']={'enabled':True,'days':{}}
 assert req('/api/admin/menu','PUT',menu,cookie)[0]==200
 assert req('/api/availability')[1]['accepting'] is False
 assert req('/api/orders','POST',no_coupon)[0]==400
 menu['settings']['schedule']['enabled']=False
 assert req('/api/admin/menu','PUT',menu,cookie)[0]==200
 # bundle applies automatically, cannot exceed subtotal
 second=next(x for s in menu['sections'] for x in s['items'] if x['name']!=name and not x.get('variants') and not x.get('off'))
 assert req('/api/admin/promotions','PUT',{'coupons':[],'bundles':[{'id':'bundle1','title':'وجبة توفير','items':[name,second['name']],'type':'fixed','value':10,'enabled':True}]},cookie)[0]==200
 order2={**no_coupon,'requestId':str(uuid.uuid4()),'items':[no_coupon['items'][0],{'name':second['name'],'weight':'','addons':[],'quantity':1,'unitPrice':second['price']}]}
 code,rr,_=req('/api/orders','POST',order2)
 assert code==201 and rr['discount']==10,(code,rr)
 assert req('/api/admin/promotions',cookie=cashier)[0]==403
 print('ALL BACKEND TESTS PASSED')
finally:
 proc.terminate()
 try:print('SERVER TAIL',proc.communicate(timeout=4)[0][-2200:])
 except subprocess.TimeoutExpired: proc.kill()
 shutil.rmtree(tmp,ignore_errors=True)
