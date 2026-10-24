'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../public/index.html'),'utf8');
const pattern=/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
let found,checked=0;
while((found=pattern.exec(html))!==null){
 const attrs=found[1],body=found[2];
 if(!body.trim()||/type\s*=\s*["']application\/(ld\+json|json)["']/i.test(attrs))continue;
 new vm.Script(body,{filename:`index-inline-${++checked}.js`});
}
if(checked<8)throw Error('Unexpectedly missing inline scripts');
console.log(`INLINE JS OK: ${checked} scripts`);
