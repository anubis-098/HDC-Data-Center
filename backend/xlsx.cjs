// Bounded XLSX reader for scalar Store master data. ZIP/DEFLATE only; no macros,
// external entities or formula evaluation. Reject unsupported cell structures.
const zlib=require('node:zlib');
const {memberships}=require('./store-groups.cjs');
function unzip(buffer){
 const files=new Map();let end=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50){end=i;break}
 if(end<0)throw Error('Invalid ZIP directory');const count=buffer.readUInt16LE(end+10);if(!count||count>2000||buffer.readUInt16LE(end+4)||buffer.readUInt16LE(end+6))throw Error('Unsupported ZIP');let offset=buffer.readUInt32LE(end+16),total=0;
 for(let i=0;i<count;i++){
  if(offset+46>buffer.length||buffer.readUInt32LE(offset)!==0x02014b50)throw Error('Invalid ZIP entry');
  const flags=buffer.readUInt16LE(offset+8),method=buffer.readUInt16LE(offset+10),compressed=buffer.readUInt32LE(offset+20),size=buffer.readUInt32LE(offset+24),nl=buffer.readUInt16LE(offset+28),extra=buffer.readUInt16LE(offset+30),comment=buffer.readUInt16LE(offset+32),local=buffer.readUInt32LE(offset+42);total+=size;
  if(total>50000000||flags&1||![0,8].includes(method)||local+30>buffer.length)throw Error('Workbook too large or unsupported ZIP');
  const name=buffer.subarray(offset+46,offset+46+nl).toString('utf8');if(files.has(name))throw Error('Duplicate ZIP entry');
  if(buffer.readUInt32LE(local)!==0x04034b50)throw Error('Invalid ZIP header');const start=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);if(start+compressed>buffer.length)throw Error('Truncated ZIP');
  const raw=buffer.subarray(start,start+compressed),data=method===8?zlib.inflateRawSync(raw,{maxOutputLength:Math.max(1,size)}):raw;if(data.length!==size)throw Error('Invalid ZIP size');files.set(name,data.toString('utf8'));offset+=46+nl+extra+comment;
 }return files;
}
function decode(s){return s.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi,(all,num,name)=>{if(num){const n=num[0].toLowerCase()==='x'?parseInt(num.slice(1),16):Number(num);if(n>0x10ffff||n===0)throw Error('Invalid XML entity');return String.fromCodePoint(n)}return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[name.toLowerCase()]})}
function attrs(s){return Object.fromEntries([...s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m=>[m[1],decode(m[2]??m[3])]))}
function text(s){return [...s.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m=>decode(m[1])).join('')}
function value(s){return decode(s.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1]||'')}
function readWorkbook(buffer){const files=unzip(buffer);for(const [name,xml] of files)if(/\.(xml|rels)$/.test(name)&&/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('XML entities are not supported');
 const workbook=files.get('xl/workbook.xml'),rels=files.get('xl/_rels/workbook.xml.rels');if(!workbook||!rels)throw Error('Missing workbook');const relationships=new Map([...rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?\s*>/g)].map(m=>{const a=attrs(m[1]);if(a.TargetMode==='External')return [a.Id,null];let target=a.Target.startsWith('/')?a.Target.slice(1):require('node:path').posix.normalize('xl/'+a.Target);return [a.Id,target]}));
 const sheets=[...workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?\s*>/g)].map(m=>{const a=attrs(m[1]);return {name:a.name,path:relationships.get(a['r:id'])}});if(!sheets.length)throw Error('Missing worksheets');
 const shared=[...(files.get('xl/sharedStrings.xml')||'').matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(m=>text(m[1]));
 const styles=files.get('xl/styles.xml')||'';const formats=new Map([...styles.matchAll(/<(?:\w+:)?numFmt\b([^>]*?)\/?\s*>/g)].map(m=>{const a=attrs(m[1]);return [a.numFmtId,a.formatCode]}));const cellXfs=styles.match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/)?.[1]||'';const styleFormats=[...cellXfs.matchAll(/<(?:\w+:)?xf\b([^>]*?)>/g)].map(m=>formats.get(attrs(m[1]).numFmtId)||'');
 return {sheets,records(sheetName){const sheet=sheets.find(s=>s.name===sheetName);if(!sheet||!files.has(sheet.path))throw Error('Sheet not found');const xml=files.get(sheet.path),rows=[];let count=0;for(const m of xml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)){if(++count>10001)throw Error('Maximum 10000 data rows');const row={};for(const c of m[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)){const a=attrs(c[1]),body=c[2]||'',col=a.r?.match(/^[A-Z]+/)?.[0];if(!col)throw Error('Missing cell coordinate');if(/<(?:\w+:)?f\b/.test(body)){row[col]={formula:true,value:''};continue}let v;if(a.t==='s'){const index=Number(value(body));if(!Number.isInteger(index)||index<0||index>=shared.length)throw Error('Invalid shared string');v=shared[index]}else if(a.t==='inlineStr')v=text(body);else if(a.t==='e'||a.t==='b')throw Error('Error or boolean cells are not supported');else{v=value(body);const fmt=styleFormats[Number(a.s||0)];if(/^0+$/.test(fmt)&&/^\d+$/.test(v))v=v.padStart(fmt.length,'0')}row[col]={value:v,formula:false}}rows.push(row)}
 if(!rows.length)throw Error('No rows found');const normalize=v=>v.toLowerCase().replace(/[^a-z0-9]/g,'');const codeCol=Object.keys(rows[0]).find(k=>['st','stno','storeno','storecode','code'].includes(normalize(rows[0][k].value))),nameCol=Object.keys(rows[0]).find(k=>['stname','storename','name'].includes(normalize(rows[0][k].value)));if(!codeCol||!nameCol)throw Error('Expected ST / Store Code and Store Name headers');const group=/^master\s+hle$/i.test(sheetName.trim())?'HLE':/^master\s+1px$/i.test(sheetName.trim())?'1PX':null;
 const categoryCol=group==='HLE'?Object.keys(rows[0]).find(k=>normalize(rows[0][k].value)==='grouphdc'):group==='1PX'?Object.keys(rows[0]).find(k=>normalize(rows[0][k].value)==='dc'):null;
 if(group&&!categoryCol)throw Error('Missing Group HDC / DC category column');
 const result=new Map();
 for(let i=1;i<rows.length;i++){
  const c=rows[i][codeCol],n=rows[i][nameCol];
  if(!c?.value&&!n?.value&&!c?.formula&&!n?.formula)continue;
  const category=categoryCol?rows[i][categoryCol]:null;
  if(c?.formula||n?.formula||category?.formula)throw Error(`Row ${i+1}: formulas are not supported`);
  const code=(c?.value||'').trim(),name=(n?.value||'').trim();
  if(!/^[A-Za-z0-9_-]{1,30}$/.test(code)||!name||name.length>160)throw Error(`Row ${i+1}: invalid Store code or name`);
  const links=group?memberships([{group,category:(category?.value||'').trim()}]):[];
  const previous=result.get(code);
  if(previous&&previous.name!==name)throw Error(`Row ${i+1}: conflicting duplicate Store ${code}`);
  const combined=[...(previous?.memberships||[])];
  for(const link of links)if(!combined.some(m=>m.group===link.group&&m.category===link.category))combined.push(link);
  result.set(code,{code,name,active:true,memberships:combined});
 }
 if(!result.size)throw Error('No Store records');return [...result.values()]}};
}
function allRecords(workbook){
 const result=new Map();
 const selected=workbook.sheets.filter(s=>/^master\s+(hle|1px)$/i.test(s.name.trim()));
 if(!selected.length)throw Error('No Master HLE / Master 1PX sheets');
 for(const sheet of selected)for(const record of workbook.records(sheet.name)){
  const previous=result.get(record.code);
  if(previous&&previous.name.toLowerCase()!==record.name.toLowerCase())throw Error(`Conflicting Store name across sheets: ${record.code}`);
  result.set(record.code,previous?{...previous,memberships:memberships([...previous.memberships,...record.memberships])}:record);
 }
 if(result.size>10000)throw Error('Maximum 10000 Stores');
 return [...result.values()];
}
module.exports={readWorkbook,allRecords};
