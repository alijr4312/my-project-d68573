'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const data=JSON.parse(read('seed/menu.json'));
const manifest=JSON.parse(read('seed/catalog-manifest.json'));
const html=read('public/index.html');
let scriptCount=0;
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g)){
  if(/type=["']application\/ld\+json["']/.test(m[1])){JSON.parse(m[2]);continue;}
  if(/\bsrc=/.test(m[1]))continue;
  new vm.Script(m[2],{filename:`public/index.html#script-${++scriptCount}`});
}
if(scriptCount<8)throw Error('Not all inline scripts were checked');
if(!Array.isArray(data.sections)||!data.sections.length)throw Error('Menu sections missing');
if(!Array.isArray(data.settings?.zones)||!data.settings.zones.length)throw Error('Delivery zones missing');
const validNames=new Set(data.sections.flatMap(s=>s.items.map(x=>x.name)));
const offers=data.settings.offers||[];
if(!Array.isArray(offers)||offers.some(n=>!validNames.has(typeof n==='string'?n:n.ref)))throw Error('Recommended homepage products invalid');
const upsell=data.settings.upsell;
if(!upsell||!Array.isArray(upsell.items)||upsell.items.some(n=>!validNames.has(n))||!Number.isInteger(upsell.limit)||upsell.limit<1||upsell.limit>6)throw Error('Upsell suggestions invalid');
if(!html.includes('UPSELL_SETTINGS=cfg.upsell')||!read('public/admin.js').includes('renderRecommendations'))throw Error('Recommendation UI missing');
let total=0,local=0;
for(const section of data.sections){
  for(const item of section.items){
    total++;
    if(item.image?.startsWith('/assets/catalog/')){
      const key=item.image.replace('/assets/catalog/','');
      if(!manifest[key])throw Error('Missing original URL for '+key);
      local++;
    }
  }
}
if(Object.values(manifest).some(u=>!/^https:\/\/menus\.mat3m\.com\/uploads\/library\/[0-9a-f-]{36}\.webp$/.test(u)))throw Error('Image manifest contains an unsafe remote URL');
for(const p of ['public/admin.html','public/admin.js','public/assets/logo.webp','public/assets/cover.webp','public/assets/favicon.png','public/assets/hotline.png','public/assets/scene.jpg','public/assets/product-placeholder.webp','seed/menu.json','seed/catalog-manifest.json']){
  if(!fs.statSync(path.join(root,p)).isFile())throw Error('Missing '+p);
}
if(html.includes('https://menus.mat3m.com/uploads/library/'))throw Error('Public website still directly depends on upstream product images');
console.log(`BUILD OK: ${data.sections.length} sections, ${total} products, ${data.settings.zones.length} delivery zones, ${local} local catalog references, ${Object.keys(manifest).length} unique originals, ${scriptCount} inline JS scripts`);
