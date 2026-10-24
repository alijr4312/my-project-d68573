'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const MENU_FILE = path.join(DATA, 'menu.json');
const ORDERS_FILE = path.join(DATA, 'orders.json');
const PROMO_FILE = path.join(DATA, 'promotions.json');
const USERS_FILE = path.join(DATA, 'users.json');
const PRICE_FILE = path.join(DATA, 'price-schedules.json');
const BACKUP_DIR = path.join(DATA,'backups');
const MAX_BACKUP_BYTES=50_000_000;
let restoring=false;
const UPLOAD_DIR = path.join(DATA, 'uploads');
const CATALOG_DIR = path.join(DATA, 'catalog');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed/catalog-manifest.json'), 'utf8'));
const CATALOG_FALLBACK = path.join(PUBLIC, 'assets/product-placeholder.webp');
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DEMO = process.env.HALAB_PUBLIC_DEMO === '1'; // test orders only; never collect or retain personal details
// An explicit, localhost-only convenience mode for testing on a personal computer.
// It is intentionally unavailable on publicly deployed production servers.
const LOCAL_1234_REQUESTED = process.env.HALAB_LOCAL_1234 === '1';
if (IS_PROD && LOCAL_1234_REQUESTED) {
  console.error('Refusing HALAB_LOCAL_1234 in production. Use an ADMIN_PASSWORD of 12+ characters.');
  process.exit(1);
}
const LOCAL_1234 = LOCAL_1234_REQUESTED && !IS_PROD;
const PASSWORD = process.env.ADMIN_PASSWORD || (LOCAL_1234 ? '1234' : '');
const HOST = LOCAL_1234 ? '127.0.0.1' : '0.0.0.0';
const MAX_ORDER = 30_000, MAX_MENU = 2_000_000, MAX_UPLOAD = 5_700_000;
const SESSION_AGE = 12 * 60 * 60 * 1000;
if (PASSWORD.length < 12 && !(LOCAL_1234 && PASSWORD === '1234')) {
  console.error('ADMIN_PASSWORD must be at least 12 characters. The 1234 demo is only allowed with HALAB_LOCAL_1234=1 in non-production mode.');
  process.exit(1);
}
fs.mkdirSync(DATA, {recursive:true});
fs.mkdirSync(UPLOAD_DIR, {recursive:true});
fs.mkdirSync(CATALOG_DIR, {recursive:true});
fs.mkdirSync(BACKUP_DIR,{recursive:true});
if (!fs.existsSync(MENU_FILE)) {
  const seed = path.join(ROOT,'seed','menu.json');
  if (!fs.existsSync(seed)) throw Error('Missing seed/menu.json');
  fs.copyFileSync(seed, MENU_FILE);
}
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE,'[]\n', {flag:'wx'});
if (!fs.existsSync(PROMO_FILE)) fs.writeFileSync(PROMO_FILE,JSON.stringify({coupons:[],bundles:[]},null,2),{flag:'wx'});
if (!fs.existsSync(PRICE_FILE)) fs.writeFileSync(PRICE_FILE,'[]\n',{flag:'wx'});
const hashPassword=password=>{const salt=crypto.randomBytes(16).toString('hex');return salt+':'+crypto.scryptSync(password,salt,64).toString('hex');};
const passwordMatches=(password,hash)=>{try{const [salt,key]=hash.split(':');return crypto.timingSafeEqual(crypto.scryptSync(password,salt,64),Buffer.from(key,'hex'));}catch{return false;}};
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE,JSON.stringify([{id:crypto.randomUUID(),username:'admin',role:'admin',passwordHash:hashPassword(PASSWORD)}],null,2),{flag:'wx',mode:0o600});
// Never serve a publicly accessible site with the local demo password, including
// when an old data directory (users.json) gets copied to a new production host.
if (IS_PROD) {
  let usersForSafetyCheck;
  try { usersForSafetyCheck = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch (err) { console.error('Cannot verify users.json:', err.message); process.exit(1); }
  if (!Array.isArray(usersForSafetyCheck) || usersForSafetyCheck.some(u => typeof u.passwordHash === 'string' && passwordMatches('1234', u.passwordHash))) {
    console.error('Production login disabled: users.json contains the local 1234 password or is invalid. Reset that password to a strong one before publishing.');
    process.exit(1);
  }
}
const sessions=new Map(), attempts=new Map(), submissions=new Map();
const imageFailures=new Map(), imageJobs=new Map(), imageQueue=[];
let imageDownloads=0, imageOutageUntil=0, imageFailuresInRow=0;
const IMAGE_MAX_BYTES=4_000_000;
const imageSync={running:false,processed:0,downloaded:0,failed:0,startedAt:null,finishedAt:null};
const catalogPath=name=>path.join(CATALOG_DIR,name);
function catalogStats(){
  const names=Object.keys(CATALOG), cached=names.filter(n=>fs.existsSync(catalogPath(n))).length;
  return {...imageSync,total:names.length,cached,remaining:names.length-cached};
}
async function runImageQueue(){
  if(imageDownloads>=4||!imageQueue.length)return;
  const job=imageQueue.shift();imageDownloads++;
  try{job.resolve(await job.fn());}catch(e){job.reject(e);}
  finally{imageDownloads--;runImageQueue();}
}
function boundedImageFetch(fn){return new Promise((resolve,reject)=>{imageQueue.push({fn,resolve,reject});runImageQueue();});}
async function fetchCatalogImage(name){
  if(!Object.hasOwn(CATALOG,name))throw Error('Unknown catalog image');
  if(process.env.DISABLE_EXTERNAL_IMAGE_DOWNLOAD==='1')throw Error('External image fetch disabled');
  if(fs.existsSync(catalogPath(name)))return true;
  if(imageOutageUntil>Date.now())throw Error('Image origin temporarily unavailable');
  const failedAt=imageFailures.get(name)||0;
  if(failedAt>Date.now()-10*60*1000)throw Error('Image not yet available');
  if(imageJobs.has(name))return imageJobs.get(name);
  const work=boundedImageFetch(async()=>{
    if(fs.existsSync(catalogPath(name)))return true;
    if(imageOutageUntil>Date.now())throw Error('Image origin temporarily unavailable');
    let tmp='';
    try{
      // Only fetch URLs from the pre-generated allowlist; never accept user-controlled upstream URLs.
      const r=await fetch(CATALOG[name],{redirect:'error',signal:AbortSignal.timeout(7000),headers:{'Accept':'image/webp'}});
      if(!r.ok||Number(r.headers.get('content-length')||0)>IMAGE_MAX_BYTES)throw Error('Image source returned '+r.status);
      const reader=r.body.getReader();const chunks=[];let bytes=0;
      while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>IMAGE_MAX_BYTES){reader.cancel().catch(()=>{});throw Error('Image too large');}chunks.push(Buffer.from(value));}
      const b=Buffer.concat(chunks);
      if(b.length<20||b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WEBP')throw Error('Invalid WEBP image');
      tmp=catalogPath(name)+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
      await fs.promises.writeFile(tmp,b,{flag:'wx',mode:0o600});
      await fs.promises.rename(tmp,catalogPath(name));
      imageFailuresInRow=0;imageFailures.delete(name);return true;
    }catch(e){
      imageFailures.set(name,Date.now());imageFailuresInRow++;
      if(imageFailuresInRow>=4)imageOutageUntil=Date.now()+5*60*1000;
      throw e;
    }finally{if(tmp)await fs.promises.rm(tmp,{force:true}).catch(()=>{});}
  });
  imageJobs.set(name,work);
  try{return await work;}finally{imageJobs.delete(name);}
}
async function syncCatalog(){
  if(imageSync.running)return;
  imageSync.running=true;imageSync.processed=0;imageSync.downloaded=0;imageSync.failed=0;
  imageSync.startedAt=new Date().toISOString();imageSync.finishedAt=null;
  // Clear negative caches when an administrator explicitly requests a retry.
  imageFailures.clear();imageOutageUntil=0;imageFailuresInRow=0;
  const targets=Object.keys(CATALOG).filter(n=>!fs.existsSync(catalogPath(n)));
  let next=0;
  await Promise.all(Array.from({length:3},async()=>{
    while(next<targets.length){
      const name=targets[next++];
      try{await fetchCatalogImage(name);imageSync.downloaded++;}catch{imageSync.failed++;}
      imageSync.processed++;
    }
  }));
  imageSync.running=false;imageSync.finishedAt=new Date().toISOString();
  console.log(`[catalog] locally saved ${catalogStats().cached}/${catalogStats().total} images`);
}

const readJSON=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const serialize = new Map();
function queuedUpdate(file, updater) {
  const prior = serialize.get(file) || Promise.resolve();
  const next = prior.catch(()=>{}).then(async()=>{
    const val=updater(readJSON(file));
    const tmp=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
    try {await fs.promises.writeFile(tmp,JSON.stringify(val,null,2)+'\n',{mode:0o600}); await fs.promises.rename(tmp,file);}
    finally { await fs.promises.rm(tmp,{force:true}).catch(()=>{}); }
    return val;
  });
  serialize.set(file,next);
  return next;
}
const reply=(res,code,json)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(json));};
const bad=(res,code,msg)=>reply(res,code,{ok:false,error:msg});
function clientIp(req){return (req.socket.remoteAddress||'unknown');}
function limited(map,id,limit,windowMs){const now=Date.now(),record=map.get(id)||{t:now,n:0};if(now-record.t>=windowMs){record.t=now;record.n=0;}record.n++;map.set(id,record);return record.n>limit;}
function purge(){const now=Date.now();for(const [k,v] of sessions)if(v.expires<now)sessions.delete(k);for(const map of [attempts,submissions])for(const [k,v] of map)if(now-v.t>3600000)map.delete(k);}
setInterval(purge,15*60*1000).unref();
function session(req){const token=/\bhs_session=([0-9a-f]{64})\b/.exec(req.headers.cookie||'')?.[1];if(!token)return null;const state=sessions.get(crypto.createHash('sha256').update(token).digest('hex'));return state&&state.expires>Date.now()?token:null;}
function currentUser(req){const token=session(req);if(!token)return null;const data=sessions.get(crypto.createHash('sha256').update(token).digest('hex'));return readJSON(USERS_FILE).find(u=>u.id===data.userId)||null;}
function mustAdmin(req,res,allowed=['admin','cashier','staff']){const user=currentUser(req);if(!user){bad(res,401,'غير مصرح. سجّل الدخول أولاً.');return false;}if(!allowed.includes(user.role)){bad(res,403,'لا توجد صلاحية لهذا الإجراء');return false;}return true;}
function adminOnly(req,res){return mustAdmin(req,res,['admin']);}
function validOrigin(req){const origin=req.headers.origin;if(!origin)return true;try{return new URL(origin).host===req.headers.host;}catch{return false;}}
function adminWrite(req,res,allowed=['admin','cashier','staff']){if(req.headers['x-requested-with']!=='HalabAdmin'||!validOrigin(req)){bad(res,403,'طلب غير موثوق');return false;}return mustAdmin(req,res,allowed);}
function getBody(req,max){return new Promise((resolve,reject)=>{let count=0,chunks=[];req.on('data',c=>{count+=c.length;if(count>max){reject(Object.assign(Error('البيانات كبيرة جداً'),{status:413}));req.destroy();return;}chunks.push(c);});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Object.assign(Error('JSON غير صالح'),{status:400}));}});req.on('error',reject);});}
function validateMenu(m){
  if(!m||typeof m!=='object'||Array.isArray(m)||typeof m.name!=='string'||!m.name.trim()||m.name.length>150||!Array.isArray(m.sections)||m.sections.length>100)throw Object.assign(Error('بيانات المنيو غير صالحة'),{status:400});
  const allNames=new Set();let n=0;
  const goodPrice=v=>Number.isFinite(v)&&v>=0&&v<=1000000;
  for(const section of m.sections){
    if(!section||typeof section.name!=='string'||!section.name.trim()||section.name.length>160||!Array.isArray(section.items)||section.items.length>500)throw Object.assign(Error('راجع اسم القسم والأصناف'),{status:400});
    if(section.hidden!==undefined&&typeof section.hidden!=='boolean')throw Object.assign(Error('حالة إخفاء القسم غير صالحة'),{status:400});
    if(section.disabled!==undefined&&typeof section.disabled!=='boolean')throw Object.assign(Error('حالة إيقاف القسم غير صالحة'),{status:400});
    for(const item of section.items){
      if(!item||typeof item.name!=='string'||!item.name.trim()||item.name.length>200||typeof item.price!=='number'||!Number.isFinite(item.price)||item.price<0||item.price>1000000)throw Object.assign(Error('راجع أسماء وأسعار الأصناف'),{status:400});
      if(item.variants!=null){if(typeof item.variants!=='object'||Array.isArray(item.variants)||Object.entries(item.variants).length>50||Object.entries(item.variants).some(([k,v])=>!k||k.length>90||!Number.isFinite(v)||v<0||v>1000000))throw Object.assign(Error('أسعار الأحجام غير صالحة'),{status:400});}
      if(item.hidden!==undefined&&typeof item.hidden!=='boolean')throw Object.assign(Error('حالة إخفاء الصنف غير صالحة'),{status:400});
      if(item.addonGroups!==undefined&&(!Array.isArray(item.addonGroups)||item.addonGroups.length>15||item.addonGroups.some(x=>typeof x!=='string'||x.length>80)||new Set(item.addonGroups).size!==item.addonGroups.length))throw Object.assign(Error('مجموعات الإضافات غير صالحة'),{status:400});
      if(allNames.has(item.name))throw Object.assign(Error('اسم الصنف مكرر: '+item.name),{status:400});
      allNames.add(item.name);n++;
    }
  }
  if(n>10000)throw Object.assign(Error('عدد الأصناف كبير جداً'),{status:400});
  const s=m.settings;
  if(s&&typeof s==='object'&&!Array.isArray(s)){
    const listCheck=(items,label)=>{
      if(!Array.isArray(items)||items.length>40||items.some(x=>typeof x!=='string'||!allNames.has(x))||new Set(items).size!==items.length)throw Object.assign(Error('راجع قائمة '+label+'؛ يلزم اختيار أصناف موجودة بدون تكرار'),{status:400});
    };
    if(s.offers!==undefined){
      // Older menus can contain image-overridden offers; validate their references too.
      if(!Array.isArray(s.offers)||s.offers.length>40)throw Object.assign(Error('قائمة العروض غير صالحة'),{status:400});
      const names=s.offers.map(x=>typeof x==='string'?x:x&&typeof x==='object'?x.ref:null);
      // Old stored menus can contain discontinued offers. Remove those safely on save.
      const seen=new Set();
      s.offers=s.offers.filter((x,i)=>{const name=names[i];if(typeof name!=='string'||!allNames.has(name)||seen.has(name))return false;seen.add(name);return true;});
    }
    if(s.offersEnabled!==undefined&&typeof s.offersEnabled!=='boolean')throw Object.assign(Error('حالة العروض غير صالحة'),{status:400});
    if(s.offersTitle!==undefined&&(typeof s.offersTitle!=='string'||s.offersTitle.length>60))throw Object.assign(Error('عنوان العروض طويل أو غير صالح'),{status:400});
    if(s.addonGroups!==undefined){
      if(!Array.isArray(s.addonGroups)||s.addonGroups.length>80)throw Object.assign(Error('عدد مجموعات الإضافات كبير'),{status:400});
      const ids=new Set();
      for(const g of s.addonGroups){
        if(!g||typeof g.id!=='string'||!g.id||g.id.length>80||ids.has(g.id)||typeof g.name!=='string'||!g.name.trim()||g.name.length>90||typeof g.required!=='boolean'||!Array.isArray(g.options)||!g.options.length||g.options.length>40)throw Object.assign(Error('مجموعات الإضافات غير صالحة'),{status:400});
        ids.add(g.id);const names=new Set();
        for(const o of g.options){if(!o||typeof o.name!=='string'||!o.name.trim()||o.name.length>90||names.has(o.name)||!goodPrice(o.price))throw Object.assign(Error('راجع أسعار الإضافات'),{status:400});names.add(o.name);}
      }
      for(const section of m.sections)for(const item of section.items)if((item.addonGroups||[]).some(id=>!ids.has(id)))throw Object.assign(Error('الصنف مرتبط بإضافة محذوفة'),{status:400});
    }
    if(s.upsell!==undefined){
      const u=s.upsell;
      if(!u||typeof u!=='object'||Array.isArray(u)||typeof u.enabled!=='boolean'||!Number.isInteger(u.limit)||u.limit<1||u.limit>6)throw Object.assign(Error('إعدادات كمّل وجبتك غير صالحة'),{status:400});
      listCheck(u.items,'كمّل وجبتك');
      if(u.byProduct!==undefined){if(!u.byProduct||typeof u.byProduct!=='object'||Array.isArray(u.byProduct)||Object.keys(u.byProduct).length>10000)throw Object.assign(Error('اقتراحات الأصناف غير صالحة'),{status:400});for(const [name,items] of Object.entries(u.byProduct)){if(!allNames.has(name))throw Object.assign(Error('صنف الاقتراح محذوف: '+name),{status:400});listCheck(items,'اقتراحات '+name);if(items.includes(name))throw Object.assign(Error('الصنف لا يقترح نفسه'),{status:400});}}
    }
    if(s.minimumOrder!==undefined&&(!goodPrice(s.minimumOrder)))throw Object.assign(Error('الحد الأدنى للطلب غير صالح'),{status:400});
    if(s.schedule!==undefined){const h=s.schedule;if(!h||typeof h!=='object'||typeof h.enabled!=='boolean'||!h.days||typeof h.days!=='object')throw Object.assign(Error('مواعيد العمل غير صالحة'),{status:400});for(let i=0;i<7;i++){const d=h.days[i];if(d!==undefined&&(!d||typeof d.open!=='string'||typeof d.close!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.open)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.close)))throw Object.assign(Error('ساعات العمل غير صالحة'),{status:400});}}
    if(s.theme!==undefined){const t=s.theme;if(!t||typeof t!=='object'||Object.values(t).some(v=>typeof v!=='string'||v.length>250)||['primary','accent'].some(k=>t[k]&&!/^#[0-9a-f]{6}$/i.test(t[k])))throw Object.assign(Error('ألوان وتصميم الموقع غير صالح'),{status:400});}
    if(s.banners!==undefined){if(!Array.isArray(s.banners)||s.banners.length>12||s.banners.some(x=>!x||typeof x.title!=='string'||x.title.length>100||typeof x.image!=='string'||x.image.length>500||!(/^(https:\/\/|\/assets\/)/i.test(x.image))))throw Object.assign(Error('صور البانرات غير صالحة'),{status:400});}
    if(s.minimumOrder!==undefined&&!Number.isFinite(s.minimumOrder))throw Object.assign(Error('الحد الأدنى غير صالح'),{status:400});
    if(s.zones!==undefined&&(!Array.isArray(s.zones)||s.zones.length>120||s.zones.some(z=>typeof z.name!=='string'||!z.name.trim()||!goodPrice(z.fee))))throw Object.assign(Error('المناطق غير صالحة'),{status:400});
    if(s.freeDeliveryThreshold!=null&&!goodPrice(s.freeDeliveryThreshold))throw Object.assign(Error('حد التوصيل المجاني غير صالح'),{status:400});
  }
  if(!m.contact||typeof m.contact!=='object'||Array.isArray(m.contact))m.contact={};
  return m;
}
function cairoClock(){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
 return {day:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday),min:Number(parts.hour)*60+Number(parts.minute)};
}
function acceptingOrders(menu){
 if(menu.contact?.orders===false)return false;
 const schedule=menu.settings?.schedule;if(!schedule?.enabled)return true;
 const {day,min}=cairoClock();
 for(const [n,yesterday] of [[day,false],[(day+6)%7,true]]){
  const d=schedule.days?.[n];if(!d)continue;
  const a=Number(d.open.slice(0,2))*60+Number(d.open.slice(3));
  const b=Number(d.close.slice(0,2))*60+Number(d.close.slice(3));
  if(a===b)return true;
  if(!yesterday && (a<b?min>=a&&min<b:min>=a))return true;
  if(yesterday&&a>b&&min<b)return true;
 }
 return false;
}
function validPromotions(p,candidateMenu=readJSON(MENU_FILE)){
 if(!p||!Array.isArray(p.coupons)||!Array.isArray(p.bundles)||p.coupons.length>150||p.bundles.length>150)throw Object.assign(Error('العروض غير صالحة'),{status:400});
 const names=new Set(candidateMenu.sections.flatMap(s=>s.items.map(i=>i.name)));
 const check=v=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=1000000;
 const codeSet=new Set();
 for(const c of p.coupons){if(!c||!/^[-A-Z0-9_]{3,25}$/.test(c.code)||codeSet.has(c.code)||!['percent','fixed'].includes(c.type)||!check(c.value)||(c.type==='percent'&&c.value>100)||!Number.isInteger(c.maxUses)||c.maxUses<0||c.maxUses>1000000||typeof c.enabled!=='boolean'||(c.expires&&isNaN(Date.parse(c.expires)))||!Number.isFinite(c.minSubtotal??0)||c.minSubtotal<0)throw Object.assign(Error('كوبون غير صالح'),{status:400});codeSet.add(c.code);}
 for(const b of p.bundles){if(!b||typeof b.id!=='string'||!b.id||typeof b.title!=='string'||b.title.length>120||!Array.isArray(b.items)||b.items.length<2||b.items.length>12||new Set(b.items).size!==b.items.length||b.items.some(n=>!names.has(n))||!['percent','fixed'].includes(b.type)||!check(b.value)||(b.type==='percent'&&b.value>100)||typeof b.enabled!=='boolean')throw Object.assign(Error('عرض وجبة غير صالح'),{status:400});}
 if(new Set(p.bundles.map(b=>b.id)).size!==p.bundles.length)throw Object.assign(Error('رقم عرض مكرر'),{status:400});
 return p;
}

// V5: all scheduled times are local Cairo wall-clock datetimes (not the browser's timezone).
const cairoFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function cairoLocalToEpoch(s){
 if(typeof s!=='string'||!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/.test(s))return NaN;
 const utc=Date.parse(s+':00Z');if(!Number.isFinite(utc))return NaN;
 for(const offset of [3,2]){const t=utc-offset*3600000;const parts=Object.fromEntries(cairoFormatter.formatToParts(new Date(t)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));if(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`===s)return t;}
 return NaN;
}
function validateSchedules(rows,menu=readJSON(MENU_FILE)){
 if(!Array.isArray(rows)||rows.length>300)throw Object.assign(Error('عدد جداول الأسعار كبير'),{status:400});
 const names=new Map(menu.sections.flatMap(sec=>sec.items.map(it=>[it.name,it]))),sections=new Set(menu.sections.map(x=>x.name));const ids=new Set();
 for(const r of rows){
  if(!r||typeof r!=='object'||typeof r.id!=='string'||!/^[a-zA-Z0-9-]{6,80}$/.test(r.id)||ids.has(r.id)||!['product','section'].includes(r.scope)||typeof r.target!=='string'||!['price','percent_off','amount_off'].includes(r.type)||typeof r.enabled!=='boolean'||typeof r.value!=='number'||!Number.isFinite(r.value)||r.value<0||r.value>1000000)throw Object.assign(Error('جدول أسعار غير صالح'),{status:400});
  ids.add(r.id);
  if(r.scope==='product'&&!names.has(r.target)||r.scope==='section'&&!sections.has(r.target))throw Object.assign(Error('الصنف أو القسم غير موجود في جدول الأسعار: '+r.target),{status:400});
  if(r.type==='percent_off'&&r.value>100)throw Object.assign(Error('نسبة الخصم أكبر من 100%'),{status:400});
  if(r.type==='price'&&r.scope!=='product')throw Object.assign(Error('السعر الثابت لصنف محدد فقط'),{status:400});
  if(typeof r.startAt!=='string'||typeof r.endAt!=='string'||!Number.isFinite(cairoLocalToEpoch(r.startAt))||!Number.isFinite(cairoLocalToEpoch(r.endAt))||cairoLocalToEpoch(r.endAt)<=cairoLocalToEpoch(r.startAt))throw Object.assign(Error('بداية ونهاية الجدول غير صحيحتين بتوقيت القاهرة'),{status:400});
  if(r.variant!=null&&r.variant!==''&&(typeof r.variant!=='string'||r.variant.length>80||r.scope!=='product'||r.type!=='price'||!Object.hasOwn(names.get(r.target).variants||{},r.variant)))throw Object.assign(Error('الحجم المختار غير موجود'),{status:400});
  if(r.type==='price'&&!r.variant&&Object.keys(names.get(r.target).variants||{}).length)throw Object.assign(Error('الصنف له أحجام: اختر حجماً محدداً للسعر الثابت، أو استخدم خصماً نسبياً'),{status:400});
 }
 return rows;
}
const roundMoney=v=>Math.round((v+Number.EPSILON)*100)/100;
function effectiveMenu(){
 const menu=readJSON(MENU_FILE),now=Date.now(),schedules=readJSON(PRICE_FILE);
 // Prioritize product rules over category rules, and newest starting rule over older ones.
 const active=schedules.filter(x=>x.enabled&&cairoLocalToEpoch(x.startAt)<=now&&cairoLocalToEpoch(x.endAt)>now)
   .sort((a,b)=>(a.scope==='product'?1:0)-(b.scope==='product'?1:0)||cairoLocalToEpoch(a.startAt)-cairoLocalToEpoch(b.startAt)||a.id.localeCompare(b.id));
 for(const section of menu.sections)for(const item of section.items){
  const applied=active.filter(x=>x.scope==='product'?x.target===item.name:x.target===section.name);
  if(!applied.length)continue;
  const normal={base:item.price,variants:structuredClone(item.variants||{})};
  // One winning rule per variant: explicit variant rule wins over general, product over section.
  const calculate=(original,variant)=>{
   const candidates=applied.filter(x=>x.type!=='price'||(!variant?!x.variant:x.variant===variant));
   if(!candidates.length)return original;
   const chosen=candidates.sort((a,b)=>Number(a.scope==='product')-Number(b.scope==='product')||Number(!!a.variant)-Number(!!b.variant)||cairoLocalToEpoch(a.startAt)-cairoLocalToEpoch(b.startAt)||a.id.localeCompare(b.id)).at(-1);
   return roundMoney(Math.max(0,Math.min(1000000,chosen.type==='price'?chosen.value:chosen.type==='percent_off'?original*(1-chosen.value/100):original-chosen.value)));
  };
  item.price=calculate(item.price,null);
  if(item.variants)for(const v of Object.keys(item.variants))item.variants[v]=calculate(item.variants[v],v);
  item._scheduled=applied.some(r=>r.type!=='price'||!r.variant||Object.hasOwn(item.variants||{},r.variant));
  item._basePrice=normal.base;
 }
 return menu;
}
function coPurchaseAnalytics(orders){
 const completed=orders.filter(o=>!['new','cancelled'].includes(o.status));
 const products=new Map(),pairs=new Map(),suggestions=new Map(),sources=new Map();let attributedRevenue=0,attributedUnits=0;
 for(const o of completed){
  const names=[...new Set(o.items.map(i=>i.name))].sort((a,b)=>a.localeCompare(b,'ar'));
  for(const name of names)products.set(name,(products.get(name)||0)+1);
  for(let i=0;i<names.length;i++)for(let j=i+1;j<names.length;j++){const key=JSON.stringify([names[i],names[j]]);pairs.set(key,(pairs.get(key)||0)+1);}
  for(const i of o.items){if(!i.viaUpsell)continue;const key=i.name,src=i.suggestedBy||'عام',entry=suggestions.get(key)||{name:key,orders:0,units:0,revenue:0};entry.orders++;entry.units+=i.quantity;entry.revenue=roundMoney(entry.revenue+i.unitPrice*i.quantity);suggestions.set(key,entry);
   const sk=JSON.stringify([src,key]),se=sources.get(sk)||{source:src,product:key,orders:0,units:0,revenue:0};se.orders++;se.units+=i.quantity;se.revenue=roundMoney(se.revenue+i.quantity*i.unitPrice);sources.set(sk,se);attributedRevenue=roundMoney(attributedRevenue+i.unitPrice*i.quantity);attributedUnits+=i.quantity;
  }
 }
 const sorted=(map,fn)=>[...map.values()].sort(fn);
 return {count:completed.length,upsell:{orders:completed.filter(o=>o.items.some(i=>i.viaUpsell)).length,units:attributedUnits,revenue:attributedRevenue},suggestions:sorted(suggestions,(a,b)=>b.revenue-a.revenue).slice(0,100),sources:sorted(sources,(a,b)=>b.revenue-a.revenue).slice(0,100),pairs:[...pairs.entries()].map(([key,orders])=>({products:JSON.parse(key),orders})).sort((a,b)=>b.orders-a.orders).slice(0,100),productOrders:Object.fromEntries(products)};
}
const SNAPSHOT_FILES={'menu.json':MENU_FILE,'orders.json':ORDERS_FILE,'promotions.json':PROMO_FILE,'price-schedules.json':PRICE_FILE};
function createBackupPayload(){
 const files=Object.fromEntries(Object.entries(SNAPSHOT_FILES).map(([name,p])=>[name,readJSON(p)]));
 const uploads={};let size=JSON.stringify(files).length;
 for(const name of fs.readdirSync(UPLOAD_DIR)){
  if(!/^[a-f0-9-]{36}\.(?:jpg|png|webp)$/.test(name))continue;
  const f=path.join(UPLOAD_DIR,name),st=fs.statSync(f);if(!st.isFile())continue;
  size+=Math.ceil(st.size*4/3);if(size>MAX_BACKUP_BYTES)throw Object.assign(Error('حجم الصور كبير للنسخ الاحتياطي الكامل. احفظ الصور والبيانات خارج السيرفر بشكل منفصل.'),{status:413});
  uploads[name]=fs.readFileSync(f).toString('base64');
 }
 return {format:'halab-v5-backup',version:1,createdAt:new Date().toISOString(),files,uploads};
}
async function writeAtomic(dest,buf){const tmp=dest+'.'+crypto.randomBytes(5).toString('hex')+'.tmp';try{await fs.promises.writeFile(tmp,buf,{mode:0o600});await fs.promises.rename(tmp,dest);}finally{await fs.promises.rm(tmp,{force:true}).catch(()=>{});}}
async function createBackup(){
 const payload=JSON.stringify(createBackupPayload());if(Buffer.byteLength(payload)>MAX_BACKUP_BYTES)throw Object.assign(Error('النسخة الاحتياطية كبيرة جداً'),{status:413});
 const name='halab-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex')+'.json';await writeAtomic(path.join(BACKUP_DIR,name),payload);
 const files=fs.readdirSync(BACKUP_DIR).filter(x=>/^halab-.*\.json$/.test(x)).sort().reverse();for(const old of files.slice(10))await fs.promises.unlink(path.join(BACKUP_DIR,old)).catch(()=>{});
 return {name,bytes:Buffer.byteLength(payload)};
}
function verifyBackup(snapshot){
 if(!snapshot||snapshot.format!=='halab-v5-backup'||snapshot.version!==1||!snapshot.files||typeof snapshot.files!=='object'||Array.isArray(snapshot.files)||!snapshot.uploads||typeof snapshot.uploads!=='object'||Array.isArray(snapshot.uploads))throw Object.assign(Error('هذه ليست نسخة احتياطية صالحة من V5'),{status:400});
 const {files,uploads}=snapshot;
 for(const n of Object.keys(SNAPSHOT_FILES))if(!Object.hasOwn(files,n))throw Object.assign(Error('النسخة ناقصة الملف: '+n),{status:400});
 validateMenu(structuredClone(files['menu.json']));
 validPromotions(files['promotions.json'],files['menu.json']);
 validateSchedules(files['price-schedules.json'],files['menu.json']);
 if(!Array.isArray(files['orders.json'])||files['orders.json'].length>100000||files['orders.json'].some(o=>!o||typeof o.id!=='string'||o.id.length>100||!Array.isArray(o.items)||o.items.length>60||!Number.isFinite(o.total)||o.total<0))throw Object.assign(Error('بيانات الطلبات داخل النسخة غير صالحة'),{status:400});
 if(Object.keys(uploads).length>2000)throw Object.assign(Error('عدد صور النسخة كبير'),{status:400});
 for(const [n,val] of Object.entries(uploads))if(!/^[a-f0-9-]{36}\.(?:jpg|png|webp)$/.test(n)||typeof val!=='string'||val.length>5_400_000||!/^[a-zA-Z0-9+/]*={0,2}$/.test(val))throw Object.assign(Error('ملف صورة غير آمن في النسخة'),{status:400});
 return snapshot;
}
async function restoreBackup(snapshot){
 if(restoring)throw Object.assign(Error('استرجاع آخر قيد التنفيذ'),{status:409});
 restoring=true;
 try{
  await Promise.all([...serialize.values()].map(p=>p.catch(()=>{})));
  const clean=verifyBackup(snapshot);
  // Preserve the previous state before any writes. User accounts/passwords are deliberately not included.
  const prior=await createBackup();
  const originals=Object.fromEntries(Object.entries(SNAPSHOT_FILES).map(([name,filename])=>[name,fs.readFileSync(filename)]));
  try{
   for(const [name,dest] of Object.entries(SNAPSHOT_FILES))await writeAtomic(dest,JSON.stringify(clean.files[name],null,2)+'\n');
   for(const [name,base64] of Object.entries(clean.uploads)){const buf=Buffer.from(base64,'base64');if(buf.length>4_000_000)throw Error('Image too large');await writeAtomic(path.join(UPLOAD_DIR,name),buf);}
  }catch(e){for(const [name,dest] of Object.entries(SNAPSHOT_FILES))await writeAtomic(dest,originals[name]);throw e;}
  return {ok:true,safetyBackup:prior.name,orders:clean.files['orders.json'].length};
 }finally{restoring=false;}
}
setInterval(()=>{if(!restoring)createBackup().catch(e=>console.error('[automatic backup]',e.message));},6*60*60*1000).unref();
// First automatic snapshot shortly after start. Subsequent snapshots every six hours.
setTimeout(()=>createBackup().catch(e=>console.error('[initial backup]',e.message)),12000).unref();

function orderPayload(body,orders=[]){
 const type=String(body?.type||'');
 if(!['pickup','delivery','dine'].includes(type)||!Array.isArray(body?.items)||!body.items.length||body.items.length>60)throw Object.assign(Error('طلب غير صالح'),{status:400});
 const str=(v,max)=>String(v??'').slice(0,max).trim();
 const menu=effectiveMenu();
 if(!acceptingOrders(menu))throw Object.assign(Error('استقبال الطلبات مغلق حالياً حسب مواعيد العمل'),{status:400});
 const byName=new Map(menu.sections.flatMap(s=>s.items.map(i=>[i.name,{...i,section:s}])));
 const groups=new Map((menu.settings?.addonGroups||[]).map(g=>[g.id,g]));
 const items=body.items.map(x=>({name:str(x.name,200),weight:str(x.weight,80),quantity:Number(x.quantity),unitPrice:Number(x.unitPrice),addons:Array.isArray(x.addons)?x.addons:[],suggestedBy:String(x.suggestedBy||'').slice(0,200)}));
 if(items.some(i=>!i.name||!Number.isInteger(i.quantity)||i.quantity<1||i.quantity>99||!Number.isFinite(i.unitPrice)||i.unitPrice<0||i.unitPrice>1000000||i.addons.length>15))throw Object.assign(Error('أصناف الطلب غير صالحة'),{status:400});
 for(const i of items){
  const product=byName.get(i.name);
  if(!product||product.off||product.hidden||product.section.disabled||product.section.hidden)throw Object.assign(Error('الصنف غير متوفر: '+i.name),{status:400});
  const variants=product.variants&&Object.keys(product.variants).length?product.variants:null;
  if(variants&&(!i.weight||!Object.hasOwn(variants,i.weight)))throw Object.assign(Error('اختيار الحجم غير صالح: '+i.name),{status:400});
  if(!variants&&i.weight)throw Object.assign(Error('هذا الصنف ليس له أحجام: '+i.name),{status:400});
  let price=variants?Number(variants[i.weight]):Number(product.price);
  const allowed=product.addonGroups||[],chosen=new Set();
  for(const a of i.addons){
   if(!a||typeof a.groupId!=='string'||typeof a.name!=='string'||!allowed.includes(a.groupId)||chosen.has(a.groupId))throw Object.assign(Error('إضافة غير صالحة للصنف'),{status:400});
   const g=groups.get(a.groupId),option=g?.options.find(o=>o.name===a.name);
   if(!option)throw Object.assign(Error('الإضافة غير متاحة: '+a.name),{status:400});
   chosen.add(a.groupId);price+=option.price;
  }
  for(const id of allowed)if(groups.get(id)?.required&&!chosen.has(id))throw Object.assign(Error('اختار الإضافة المطلوبة للصنف: '+i.name),{status:400});
  price=Math.round(price*100)/100;
  if(Math.abs(i.unitPrice-price)>.009)throw Object.assign(Error('سعر الصنف تغيّر: '+i.name+'. حدّث الصفحة ثم أعد الطلب.'),{status:409});
  i.unitPrice=price;
  const u=menu.settings?.upsell||{};
  i.viaUpsell=!!i.suggestedBy&&((i.suggestedBy==='عام'&&(u.items||[]).includes(i.name))||(items.some(x=>x.name===i.suggestedBy)&&(u.byProduct?.[i.suggestedBy]||[]).includes(i.name)));
  if(!i.viaUpsell)i.suggestedBy='';
 }
 const subtotal=Math.round(items.reduce((t,i)=>t+i.quantity*i.unitPrice,0)*100)/100;
 if(subtotal<Number(menu.settings?.minimumOrder||0))throw Object.assign(Error('الحد الأدنى للطلب '+menu.settings.minimumOrder+' ج.م'),{status:400});
 const zone=str(body.zone,120);let deliveryFee=0;
 if(type==='delivery'){
  const selected=(menu.settings?.zones||[]).find(z=>z.name===zone);
  if(!selected||!str(body.address,600))throw Object.assign(Error('اختر منطقة توصيل وأدخل عنوانًا'),{status:400});
  const threshold=Number(menu.settings?.freeDeliveryThreshold)||0;
  deliveryFee=(threshold>0&&subtotal>=threshold)?0:Number(selected.fee);
  if(!Number.isFinite(deliveryFee)||deliveryFee<0)throw Object.assign(Error('رسوم التوصيل غير صالحة'),{status:400});
 }
 const promos=readJSON(PROMO_FILE);const orderedNames=new Set(items.map(i=>i.name));let bundleDiscount=0,bundleTitle='';
 for(const b of promos.bundles){if(!b.enabled||!b.items.every(n=>orderedNames.has(n)))continue;
   const participating=items.filter(i=>b.items.includes(i.name)).reduce((t,i)=>t+i.unitPrice*i.quantity,0);
   const saving=Math.min(participating,b.type==='percent'?Math.round(participating*b.value)/100:b.value);
   if(saving>bundleDiscount){bundleDiscount=saving;bundleTitle=b.title;}
 }
 let couponDiscount=0,couponCode=str(body.coupon,25).toUpperCase();
 if(couponCode){
  const c=promos.coupons.find(x=>x.code===couponCode);
  const times=orders.filter(o=>o.couponCode===couponCode&&o.status!=='cancelled').length;
  if(!c||!c.enabled||(c.expires&&Date.parse(c.expires)<Date.now())||(c.maxUses&&times>=c.maxUses)||subtotal<(c.minSubtotal||0))throw Object.assign(Error('الكوبون غير صالح أو انتهى أو لا ينطبق على الطلب'),{status:400});
  couponDiscount=Math.min(Math.max(0,subtotal-bundleDiscount),c.type==='percent'?Math.round((subtotal-bundleDiscount)*c.value)/100:c.value);
 }
 const discount=Math.round((couponDiscount+bundleDiscount)*100)/100;
 return {id:'HS-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase(),createdAt:new Date().toISOString(),status:'new',customer:str(body.customer,120),address:str(body.address,600),notes:str(body.notes,1500),type,zone:type==='delivery'?zone:'',items,subtotal,deliveryFee,discount,couponCode,bundleTitle,total:Math.round((subtotal-discount+deliveryFee)*100)/100,priceNote:'الأسعار والخصومات محسوبة من السيرفر'};
}

function excelXML(rows){const x=v=>String(v??'').replace(/[\x00-\x08\x0b-\x1f]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
 return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rows.map((cells,i)=>'<row r="'+(i+1)+'">'+cells.map((c,j)=>{let col='',n=j+1;while(n){n--;col=String.fromCharCode(65+n%26)+col;n=Math.floor(n/26);}return `<c r="${col}${i+1}" ${typeof c==='number'&&Number.isFinite(c)?'t="n"':'t="inlineStr"'}>${typeof c==='number'&&Number.isFinite(c)?'<v>'+c+'</v>':'<is><t xml:space="preserve">'+x(c)+'</t></is>'}</c>`;}).join('')+'</row>').join('')+'</sheetData></worksheet>';
}
function zipBytes(files){
 // Minimal uncompressed ZIP compatible with Office Open XML, no third-party dependencies.
 const crcTable=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);crcTable[n]=c>>>0;}
 const crc=buf=>{let c=0xffffffff;for(const b of buf)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
 const locals=[],central=[];let offset=0;
 for(const [name,value] of Object.entries(files)){
  const filename=Buffer.from(name),data=Buffer.from(value,'utf8'),checksum=crc(data);
  const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt32LE(checksum,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(filename.length,26);
  locals.push(h,filename,data);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt32LE(checksum,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(filename.length,28);c.writeUInt32LE(offset,42);central.push(c,filename);
  offset+=h.length+filename.length+data.length;
 }
 const centralBytes=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,centralBytes,end]);
}
function excelReport(orders){
 const active=orders.filter(o=>!['new','cancelled'].includes(o.status));const daily={},monthly={},items={};
 for(const o of active){const d=o.createdAt.slice(0,10),m=d.slice(0,7);daily[d]=(daily[d]||0)+o.total;monthly[m]=(monthly[m]||0)+o.total;for(const item of o.items)items[item.name]=(items[item.name]||0)+item.quantity;}
 const sheets=[
  [['رقم الطلب','التاريخ','العميل','الحالة','النوع','المنطقة','قبل الخصم','الخصم','التوصيل','الإجمالي','الكوبون'],...orders.map(o=>[o.id,o.createdAt,o.customer,o.status,o.type,o.zone,o.subtotal||0,o.discount||0,o.deliveryFee||0,o.total||0,o.couponCode||''])],
  [['اليوم','الإيراد'],...Object.entries(daily).sort((a,b)=>b[0].localeCompare(a[0]))],
  [['الشهر','الإيراد'],...Object.entries(monthly).sort((a,b)=>b[0].localeCompare(a[0]))],
  [['الصنف','الكمية'],...Object.entries(items).sort((a,b)=>b[1]-a[1])]
 ];
 const names=['Orders','Daily','Monthly','Top Products'];
 const files={'[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')+'</Types>',
 '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
 'xl/workbook.xml':'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+names.map((name,i)=>`<sheet name="${name}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')+'</sheets></workbook>',
 'xl/_rels/workbook.xml.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')+'</Relationships>'};
 for(let i=0;i<sheets.length;i++)files[`xl/worksheets/sheet${i+1}.xml`]=excelXML(sheets[i]);return zipBytes(files);
}

function headers(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'");
  if(IS_PROD)res.setHeader('Strict-Transport-Security','max-age=31536000');
}
function serveFile(res,filename,contentType,cache='public, max-age=3600'){
  fs.stat(filename,(err,st)=>{if(err||!st.isFile()){bad(res,404,'الملف غير موجود');return;}res.writeHead(200,{'Content-Type':contentType,'Content-Length':st.size,'Cache-Control':cache});fs.createReadStream(filename).pipe(res);});
}
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{
  headers(req,res);
  const u=new URL(req.url||'/', 'http://localhost');const p=u.pathname,method=req.method;
  try{
    if(p==='/api/health'&&method==='GET')return reply(res,200,{ok:true,app:'Halab AlShahba',demo:PUBLIC_DEMO,time:new Date().toISOString()});
    if(restoring&&method!=='GET')return bad(res,503,'جارٍ استرجاع النسخة الاحتياطية، حاول مرة أخرى');
    if(p==='/api/menu'&&method==='GET'){let m=effectiveMenu();res.setHeader('Cache-Control','no-store');return reply(res,200,m);}
    if(p==='/api/orders'&&method==='POST'){
      if(!validOrigin(req))return bad(res,403,'طلب غير موثوق');
      if(limited(submissions,clientIp(req),12,10*60*1000))return bad(res,429,'طلبات كثيرة؛ حاول لاحقاً');
      const b=await getBody(req,MAX_ORDER);
      const requestId=typeof b.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(b.requestId)?b.requestId:null;
      let reused=false,id,total,discount;
      await queuedUpdate(ORDERS_FILE,arr=>{
        if(!Array.isArray(arr))throw Error('Invalid orders data');
        if(requestId){const prior=arr.find(x=>x.requestId===requestId);if(prior){reused=true;id=prior.id;total=prior.total;discount=prior.discount||0;return arr;}}
        const o=orderPayload(b,arr);
        if(PUBLIC_DEMO){
          // All public demo orders are fake. Do not retain identifying customer details.
          o.customer='زائر تجريبي';o.address='';o.notes='';o.demo=true;
        }
        o.requestId=requestId;id=o.id;total=o.total;discount=o.discount;arr.unshift(o);return arr;
      });
      return reply(res,reused?200:201,{ok:true,id,total,discount,alreadySaved:reused});
    }
    if(p==='/api/availability'&&method==='GET')return reply(res,200,{accepting:acceptingOrders(readJSON(MENU_FILE))});
    if(p==='/api/promotions'&&method==='GET')return reply(res,200,{bundles:readJSON(PROMO_FILE).bundles.filter(x=>x.enabled)});
    if(p==='/api/pricing'&&method==='POST'){
      if(!validOrigin(req))return bad(res,403,'طلب غير موثوق');
      if(limited(submissions,clientIp(req)+':pricing',60,10*60*1000))return bad(res,429,'محاولات كثيرة');
      const order=orderPayload(await getBody(req,MAX_ORDER),readJSON(ORDERS_FILE));
      return reply(res,200,{ok:true,subtotal:order.subtotal,deliveryFee:order.deliveryFee,discount:order.discount,total:order.total,bundleTitle:order.bundleTitle});
    }

    if(p==='/api/admin/pricing-schedules'&&method==='GET'){
      if(!adminOnly(req,res))return;
      return reply(res,200,{schedules:readJSON(PRICE_FILE),serverTime:new Date().toISOString(),timeZone:'Africa/Cairo'});
    }
    if(p==='/api/admin/pricing-schedules'&&method==='PUT'){
      if(!adminWrite(req,res,['admin']))return;
      const b=await getBody(req,300000),rows=validateSchedules(b.schedules);
      await queuedUpdate(PRICE_FILE,()=>rows);return reply(res,200,{ok:true,count:rows.length});
    }
    if(p==='/api/admin/bulk'&&method==='POST'){
      if(!adminWrite(req,res,['admin']))return;
      const b=await getBody(req,15000);
      if(!b||!['raise_percent','availability'].includes(b.action))return bad(res,400,'عملية جماعية غير صالحة');
      if(b.section!==undefined&&(typeof b.section!=='string'||b.section.length>160))return bad(res,400,'القسم غير صالح');
      if(b.items!==undefined&&(!Array.isArray(b.items)||b.items.length>1000||b.items.some(x=>typeof x!=='string'||x.length>200)||new Set(b.items).size!==b.items.length))return bad(res,400,'الأصناف المختارة غير صالحة');
      if(!b.items?.length&&!b.section)return bad(res,400,'اختر قسماً أو أصنافاً');
      if(b.action==='raise_percent'&&(!Number.isFinite(b.percent)||b.percent<-90||b.percent>500))return bad(res,400,'النسبة يجب أن تكون من -90% إلى 500%');
      if(b.action==='availability'&&!['available','off','hidden'].includes(b.state))return bad(res,400,'حالة الصنف غير صالحة');
      let changed=0;
      await queuedUpdate(MENU_FILE,m=>{
        validateMenu(m);const names=new Set(m.sections.flatMap(sec=>sec.items.map(it=>it.name)));
        if(b.section&&!m.sections.some(x=>x.name===b.section))throw Object.assign(Error('القسم غير موجود'),{status:400});
        if(b.items?.some(x=>!names.has(x)))throw Object.assign(Error('أحد الأصناف المحددة غير موجود'),{status:400});
        const selected=new Set(b.items||[]);
        for(const sec of m.sections)for(const it of sec.items){if(selected.size?!selected.has(it.name):sec.name!==b.section)continue;changed++;
          if(b.action==='raise_percent'){
            it.price=roundMoney(it.price*(1+b.percent/100));
            if(it.variants)for(const key of Object.keys(it.variants))it.variants[key]=roundMoney(it.variants[key]*(1+b.percent/100));
            if(it.price>1000000||Object.values(it.variants||{}).some(p=>p>1000000))throw Object.assign(Error('السعر الجديد يتجاوز الحد المسموح'),{status:400});
          }else if(b.state==='available'){it.off=false;it.hidden=false;}
          else if(b.state==='off'){it.off=true;it.hidden=false;}
          else{it.hidden=true;}
        }
        if(!changed)throw Object.assign(Error('لم يتم اختيار أصناف'),{status:400});
        return validateMenu(m);
      });return reply(res,200,{ok:true,changed});
    }
    if(p==='/api/admin/basket-analytics'&&method==='GET'){
      if(!mustAdmin(req,res,['admin','cashier']))return;
      return reply(res,200,coPurchaseAnalytics(readJSON(ORDERS_FILE)));
    }
    if(p==='/api/admin/backups'&&method==='GET'){
      if(!adminOnly(req,res))return;
      const names=fs.readdirSync(BACKUP_DIR).filter(n=>/^halab-[0-9TZ-]+-[a-f0-9]{6}\.json$/.test(n)).sort().reverse().slice(0,30);
      return reply(res,200,{backups:names.map(name=>({name,size:fs.statSync(path.join(BACKUP_DIR,name)).size}))});
    }
    if(p==='/api/admin/backups'&&method==='POST'){
      if(!adminWrite(req,res,['admin']))return;
      const made=await createBackup();return reply(res,201,{ok:true,...made});
    }
    if(p==='/api/admin/backups/download'&&method==='GET'){
      if(!adminOnly(req,res))return;
      const name=u.searchParams.get('name')||'';
      if(!/^halab-[0-9TZ-]+-[a-f0-9]{6}\.json$/.test(name))return bad(res,400,'اسم النسخة غير صالح');
      const file=path.join(BACKUP_DIR,name);if(!fs.existsSync(file))return bad(res,404,'النسخة غير موجودة');
      const data=fs.readFileSync(file);res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'no-store','Content-Length':data.length});return res.end(data);
    }
    if(p==='/api/admin/backups/restore'&&method==='POST'){
      if(!adminWrite(req,res,['admin']))return;
      const b=await getBody(req,MAX_BACKUP_BYTES+100000);
      if(b.confirm!=='RESTORE')return bad(res,400,'التأكيد مطلوب');
      let snapshot;
      if(b.name!==undefined){if(typeof b.name!=='string'||!/^halab-[0-9TZ-]+-[a-f0-9]{6}\.json$/.test(b.name))return bad(res,400,'اسم النسخة غير صالح');snapshot=JSON.parse(fs.readFileSync(path.join(BACKUP_DIR,b.name),'utf8'));}
      else snapshot=b.backup;
      const result=await restoreBackup(snapshot);return reply(res,200,result);
    }
    if(p==='/api/admin/promotions'&&method==='GET'){
      if(!adminOnly(req,res))return;
      const data=readJSON(PROMO_FILE),orders=readJSON(ORDERS_FILE);
      return reply(res,200,{...data,usage:Object.fromEntries(data.coupons.map(c=>[c.code,orders.filter(o=>o.couponCode===c.code&&o.status!=='cancelled').length]))});
    }
    if(p==='/api/admin/promotions'&&method==='PUT'){
      if(!adminWrite(req,res,['admin']))return;
      const data=validPromotions(await getBody(req,100000));await queuedUpdate(PROMO_FILE,()=>data);return reply(res,200,{ok:true});
    }
    if(p==='/api/admin/users'&&method==='GET'){
      if(!adminOnly(req,res))return;
      return reply(res,200,{users:readJSON(USERS_FILE).map(({id,username,role})=>({id,username,role}))});
    }
    if(p==='/api/admin/users'&&method==='POST'){
      if(!adminWrite(req,res,['admin']))return;
      const b=await getBody(req,5000),username=String(b?.username||'').trim().toLowerCase(),pass=String(b?.password||''),role=b?.role;
      if(!/^[a-z0-9_.-]{3,40}$/.test(username)||pass.length<12||pass.length>128||!['admin','cashier','staff'].includes(role))return bad(res,400,'اسم المستخدم أو كلمة السر (12 حرف على الأقل) أو الصلاحية غير صالحة');
      await queuedUpdate(USERS_FILE,users=>{if(users.some(u=>u.username===username))throw Object.assign(Error('اسم المستخدم موجود'),{status:400});users.push({id:crypto.randomUUID(),username,role,passwordHash:hashPassword(pass)});return users;});
      return reply(res,201,{ok:true});
    }
    const userMatch=p.match(/^\/api\/admin\/users\/([0-9a-f-]{36})$/);
    if(userMatch&&method==='PATCH'){
      if(!adminWrite(req,res,['admin']))return;
      const b=await getBody(req,5000);let found=false;
      await queuedUpdate(USERS_FILE,users=>{const u=users.find(x=>x.id===userMatch[1]);if(!u)throw Object.assign(Error('المستخدم غير موجود'),{status:404});found=true;
        if(b.role!==undefined){if(!['admin','cashier','staff'].includes(b.role))throw Object.assign(Error('دور غير صالح'),{status:400});if(u.role==='admin'&&b.role!=='admin'&&users.filter(x=>x.role==='admin').length<2)throw Object.assign(Error('لا يمكن حذف آخر مدير'),{status:400});u.role=b.role;}
        if(b.password!==undefined){if(typeof b.password!=='string'||b.password.length<12||b.password.length>128)throw Object.assign(Error('كلمة المرور قصيرة'),{status:400});u.passwordHash=hashPassword(b.password);}return users;});return reply(res,200,{ok:found});
    }
    if(userMatch&&method==='DELETE'){
      if(!adminWrite(req,res,['admin']))return;
      const me=currentUser(req);if(me.id===userMatch[1])return bad(res,400,'لا يمكنك حذف حسابك الحالي');
      await queuedUpdate(USERS_FILE,users=>{const u=users.find(x=>x.id===userMatch[1]);if(!u)throw Object.assign(Error('المستخدم غير موجود'),{status:404});if(u.role==='admin'&&users.filter(x=>x.role==='admin').length<2)throw Object.assign(Error('لا يمكن حذف آخر مدير'),{status:400});return users.filter(x=>x.id!==u.id);});return reply(res,200,{ok:true});
    }
    if(p==='/api/admin/report.xlsx'&&method==='GET'){
      if(!mustAdmin(req,res,['admin','cashier']))return;
      const data=excelReport(readJSON(ORDERS_FILE));res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="halab_sales.xlsx"','Content-Length':data.length,'Cache-Control':'no-store'});return res.end(data);
    }
    if(p==='/api/admin/report'&&method==='GET'){
      if(!mustAdmin(req,res,['admin','cashier']))return;
      const a=readJSON(ORDERS_FILE),sales=a.filter(o=>!['cancelled','new'].includes(o.status));
      const summary={orders:a.length,cancelled:a.filter(o=>o.status==='cancelled').length,revenue:Math.round(sales.reduce((t,o)=>t+o.total,0)*100)/100};
      const daily={},monthly={},items={};for(const o of sales){const day=o.createdAt.slice(0,10),month=day.slice(0,7);daily[day]=(daily[day]||0)+o.total;monthly[month]=(monthly[month]||0)+o.total;for(const i of o.items)items[i.name]=(items[i.name]||0)+i.quantity;}
      return reply(res,200,{summary,daily,monthly,items,orders:a});
    }
    if(p==='/api/admin/images'&&method==='GET'){
      if(!adminOnly(req,res))return;
      return reply(res,200,catalogStats());
    }
    if(p==='/api/admin/images/sync'&&method==='POST'){
      if(!adminWrite(req,res,['admin']))return;
      if(!imageSync.running)syncCatalog().catch(err=>{imageSync.running=false;console.error('[catalog]',err.message);});
      return reply(res,202,{ok:true,...catalogStats()});
    }
    if(p==='/api/admin/session'&&method==='GET'){const user=currentUser(req);return reply(res,200,{authenticated:!!user,role:user?.role||null,username:user?.username||null});}
    if(p==='/api/admin/login'&&method==='POST'){
      if(req.headers['x-requested-with']!=='HalabAdmin'||!validOrigin(req))return bad(res,403,'طلب غير موثوق');
      const ip=clientIp(req);
      if(limited(attempts,ip,8,15*60*1000))return bad(res,429,'محاولات كثيرة. حاول بعد 15 دقيقة.');
      const b=await getBody(req,5000),candidate=String(b?.password??''),username=String(b?.username||'admin').trim().toLowerCase();
      const user=readJSON(USERS_FILE).find(u=>u.username===username);
      if(!user||!passwordMatches(candidate,user.passwordHash))return bad(res,401,'اسم المستخدم أو كلمة المرور غير صحيح');
      attempts.delete(ip);
      const token=crypto.randomBytes(32).toString('hex');sessions.set(crypto.createHash('sha256').update(token).digest('hex'),{expires:Date.now()+SESSION_AGE,userId:user.id});
      res.setHeader('Set-Cookie','hs_session='+token+'; HttpOnly; Path=/api/admin; SameSite=Strict; Max-Age='+SESSION_AGE/1000+(IS_PROD?'; Secure':''));
      return reply(res,200,{ok:true});
    }
    if(p==='/api/admin/logout'&&method==='POST'){
      if(!adminWrite(req,res))return;
      const token=session(req);if(token)sessions.delete(crypto.createHash('sha256').update(token).digest('hex'));
      res.setHeader('Set-Cookie','hs_session=; HttpOnly; Path=/api/admin; SameSite=Strict; Max-Age=0'+(IS_PROD?'; Secure':''));
      return reply(res,200,{ok:true});
    }
    if(p==='/api/admin/menu'&&method==='GET'){if(!mustAdmin(req,res,['admin']))return;return reply(res,200,readJSON(MENU_FILE));}
    if(p==='/api/admin/menu'&&method==='PUT'){
      if(!adminWrite(req,res,['admin']))return;
      const b=validateMenu(await getBody(req,MAX_MENU));
      validateSchedules(readJSON(PRICE_FILE),b); // prevent orphaned schedules when items/sections are renamed or deleted
      await queuedUpdate(MENU_FILE,()=>b);return reply(res,200,{ok:true});
    }
    if(p==='/api/admin/orders'&&method==='GET'){
      if(!mustAdmin(req,res))return;
      const arr=readJSON(ORDERS_FILE);return reply(res,200,{orders:arr.slice(0,1000)});
    }
    const match=p.match(/^\/api\/admin\/orders\/([a-zA-Z0-9-]+)$/);
    if(match&&method==='PATCH'){
      if(!adminWrite(req,res))return;
      const b=await getBody(req,5000);if(!['new','accepted','preparing','onway','delivered','cancelled'].includes(b?.status))return bad(res,400,'الحالة غير صالحة');
      let found=false;
      await queuedUpdate(ORDERS_FILE,arr=>arr.map(o=>{if(o.id===match[1]){found=true;return {...o,status:b.status,updatedAt:new Date().toISOString()};}return o;}));
      return found?reply(res,200,{ok:true}):bad(res,404,'الطلب غير موجود');
    }
    if(p==='/api/admin/upload'&&method==='POST'){
      if(!adminWrite(req,res,['admin']))return;
      const b=await getBody(req,MAX_UPLOAD);const match=/^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(b?.data||'');
      if(!match)return bad(res,400,'صيغة الصورة غير مدعومة');
      const buf=Buffer.from(match[2],'base64'),format=match[1],sig=(format==='png'&&buf.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))||(format==='jpeg'&&buf.subarray(0,3).equals(Buffer.from('ffd8ff','hex')))||(format==='webp'&&buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP');
      if(!sig||buf.length<20||buf.length>4_000_000)return bad(res,400,'ملف الصورة غير صالح أو كبير');
      const filename=crypto.randomUUID()+'.'+({jpeg:'jpg',png:'png',webp:'webp'}[format]);
      await fs.promises.writeFile(path.join(UPLOAD_DIR,filename),buf,{flag:'wx',mode:0o600});
      return reply(res,201,{ok:true,url:'/assets/uploads/'+filename});
    }
    if(p.startsWith('/api/'))return bad(res,404,'المسار غير موجود');
    if(method!=='GET'&&method!=='HEAD')return bad(res,405,'غير مسموح');
    if(p==='/'||p==='/index.html')return serveFile(res,path.join(PUBLIC,'index.html'),types['.html'],'no-cache');
    if(p==='/admin'||p==='/admin/'||p==='/admin.html')return serveFile(res,path.join(PUBLIC,'admin.html'),types['.html'],'no-cache');
    if(p==='/admin.js')return serveFile(res,path.join(PUBLIC,'admin.js'),types['.js'],'no-cache');
    const catalogImage=/^\/assets\/catalog\/([0-9a-f-]{36}\.webp)$/.exec(p);
    if(catalogImage&&Object.hasOwn(CATALOG,catalogImage[1])){
      const filename=catalogPath(catalogImage[1]);
      if(fs.existsSync(filename))return serveFile(res,filename,'image/webp','public, max-age=86400');
      try{await fetchCatalogImage(catalogImage[1]);return serveFile(res,filename,'image/webp','public, max-age=86400');}
      catch{return serveFile(res,CATALOG_FALLBACK,'image/webp','no-store');}
    }
    const m=/^\/assets\/uploads\/([a-f0-9-]{36}\.(?:jpg|png|webp))$/.exec(p);
    if(m)return serveFile(res,path.join(UPLOAD_DIR,m[1]),types[path.extname(m[1])]);
    const asset=/^\/assets\/(logo\.webp|cover\.webp|hotline\.png|favicon\.png|scene\.jpg|product-placeholder\.webp)$/.exec(p);
    if(asset)return serveFile(res,path.join(PUBLIC,'assets',asset[1]),types[path.extname(asset[1])],'public, max-age=86400');
    return bad(res,404,'الصفحة غير موجودة');
  }catch(err){console.error('[request]',method,p,err.message);if(!res.headersSent)bad(res,err.status||500,err.status?err.message:'حدث خطأ في الخادم');}
});
server.listen(PORT,HOST,()=>{
  console.log('Halab AlShahba listening at http://'+HOST+':'+PORT);
  if (LOCAL_1234) console.log('LOCAL TEST ONLY: login admin / 1234. This mode is NOT available online.');
  if(process.env.AUTO_SYNC_IMAGES!=='0')setTimeout(()=>syncCatalog().catch(e=>console.error('[catalog]',e.message)),2500).unref();
});
