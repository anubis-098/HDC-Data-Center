const fs=require('node:fs');const path=require('node:path');
function patch(root,type){
 if(type==='container-loading'){
  const file=path.join(root,'src/pages/StoresPage.tsx');if(!fs.existsSync(file))throw Error('StoresPage.tsx missing');
  fs.writeFileSync(file,"export { HdcStores as StoresPage } from '../components/HdcStores';\n");
 }else if(type==='tote-tracker'){
  const file=path.join(root,'src/pages/AdminPage.tsx');let source=fs.readFileSync(file,'utf8');
  const importLine='import { StoreImport } from "../components/StoreImport";';
  const start=source.indexOf('<form className="panel form" onSubmit={save}>');
  const end=source.indexOf('<section className="panel form">',start);
  if(!source.includes(importLine)||start<0||end<0)throw Error('AdminPage changed; review Store section before rebuilding integration');
  source=source.slice(0,start)+'<HdcStores />\n          '+source.slice(end);
  source=source.replace(importLine,'import { HdcStores } from "../components/HdcStores";');
  const legacy=/<StoreImport onImported=\{async \(\) => setStores\(await api<Store\[\]>\("\/admin\/stores"\)\)\} \/>/;
  if(!legacy.test(source))throw Error('Legacy StoreImport section changed');
  source=source.replace(legacy,'');fs.writeFileSync(file,source);
 }else throw Error('Unknown HDC_CONSUMER_TYPE');
}
module.exports={patch};if(require.main===module)patch('/app',process.argv[2]);
