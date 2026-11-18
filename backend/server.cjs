const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {readWorkbook,allRecords}=require('./xlsx.cjs');
const {storeGroups,memberships,mergeMemberships}=require('./store-groups.cjs');
const {accountGateway}=require('./accounts.cjs');
const {createIdentityService}=require('./identity.cjs');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const passwordHash=password=>{const salt=crypto.randomBytes(16).toString('hex');return salt+':'+crypto.scryptSync(password,salt,64).toString('hex')};
function matches(password,stored){const [salt,digest]=stored.split(':');return crypto.timingSafeEqual(crypto.scryptSync(password,salt,64),Buffer.from(digest,'hex'))}
const fail=(status,message)=>{throw Object.assign(new Error(message),{status})};
function createApp({directory=process.env.DATA_DIRECTORY||path.join(__dirname,'../data'),origin=process.env.PUBLIC_ORIGIN||'http://localhost:8082',accountTargets,secretDirectory=process.env.HDC_ACCOUNT_SECRET_DIRECTORY||(process.env.NODE_ENV==='production'?'/run/hdc-secrets':path.join(__dirname,'../.secrets'))}={}){
 fs.mkdirSync(directory,{recursive:true});const db=new DatabaseSync(path.join(directory,'hdc.sqlite'));db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS admins(username TEXT PRIMARY KEY,password TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,username TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS stores(code TEXT PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 INSERT OR IGNORE INTO settings VALUES('workspace','HDC Data Center');
 INSERT OR IGNORE INTO settings VALUES('version','0');
 CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,key_hash TEXT,last_used TEXT);
 INSERT OR IGNORE INTO clients(id,name) VALUES('container-loading','Container Loading'),('tote-tracker','Tote Tracker');
 CREATE TABLE IF NOT EXISTS previews(id TEXT PRIMARY KEY,username TEXT NOT NULL,records TEXT NOT NULL,filename TEXT NOT NULL,expires INTEGER NOT NULL);`);
 const storeColumns=new Set(db.prepare('PRAGMA table_info(stores)').all().map(c=>c.name));
 if(!storeColumns.has('memberships'))db.exec("ALTER TABLE stores ADD COLUMN memberships TEXT NOT NULL DEFAULT '[]'");
 const clientColumns=new Set(db.prepare('PRAGMA table_info(clients)').all().map(c=>c.name));
 for(const [name,type] of [['synced_version','INTEGER'],['synced_count','INTEGER'],['synced_at','TEXT']])if(!clientColumns.has(name))db.exec(`ALTER TABLE clients ADD COLUMN ${name} ${type}`);
 const audit=(actor,action,detail)=>db.prepare('INSERT INTO audit(actor,action,detail) VALUES(?,?,?)').run(actor,action,detail);
 const handleAccounts=accountGateway({secretDirectory,targets:accountTargets,audit,readBody:body,json});
 const identityService=createIdentityService({db,secretDirectory,passwordHash,matches,audit,readBody:body,json,linkLegacy:handleAccounts.linkLegacy});
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value}catch(e){db.exec('ROLLBACK');throw e}};
 const version=()=>Number(db.prepare("SELECT value FROM settings WHERE key='version'").get().value);
 const bump=()=>db.prepare("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='version'").run();
 const rows=()=>db.prepare('SELECT code,name,active,updated_at,memberships FROM stores ORDER BY code COLLATE NOCASE').all().map(r=>({...r,active:!!r.active,memberships:JSON.parse(r.memberships)}));
 const limits=new Map();
 function throttle(req){const ip=req.socket.remoteAddress,now=Date.now();const item=limits.get(ip)||{n:0,until:now+600000};if(item.until<now){item.n=0;item.until=now+600000}item.n++;limits.set(ip,item);if(limits.size>10000)for(const [k,v] of limits)if(v.until<now)limits.delete(k);if(item.n>15)fail(429,'ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอ 10 นาที')}
 function admin(req){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('hdc_session='))?.slice(12)||'';const s=db.prepare('SELECT username FROM sessions WHERE token=? AND expires>?').get(hash(token),Date.now());if(!s)fail(401,'กรุณาเข้าสู่ระบบ');return s.username}
 function validStore(s){if(typeof s.code!=='string'||!/^[A-Za-z0-9_-]{1,30}$/.test(s.code)||typeof s.name!=='string'||!s.name.trim()||s.name.trim().length>160||typeof s.active!=='boolean')fail(422,'รหัส Store ต้องเป็น A-Z, a-z, 0-9, _ หรือ - ไม่เกิน 30 ตัว และชื่อต้องไม่เกิน 160 ตัว');let links;try{links=memberships(s.memberships)}catch(e){fail(422,e.message)}return {...s,name:s.name.trim(),memberships:links}}
 async function body(req,max=7000000){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>max)fail(413,'ไฟล์หรือคำขอมีขนาดใหญ่เกินกำหนด');chunks.push(c)}try{return JSON.parse(Buffer.concat(chunks).toString())}catch{fail(400,'รูปแบบ JSON ไม่ถูกต้อง')}}
 function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
 async function handler(req,res){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
 try{const url=new URL(req.url,'http://localhost'),p=url.pathname,method=req.method;
 if(method==='GET'&&p==='/api/ready'){db.prepare('SELECT 1').get();return json(res,{status:'ok'})}
 if(!['GET','HEAD'].includes(method)&&p!=='/api/v1/sync-status'&&!p.startsWith('/api/identity/')&&req.headers.origin!==origin)fail(403,'Origin ไม่ตรงกับ PUBLIC_ORIGIN');
 if(method==='POST'&&p==='/api/login'){throttle(req);const b=await body(req,2000);if(typeof b.username!=='string'||typeof b.password!=='string'||b.password.length>200)fail(422,'ข้อมูลเข้าสู่ระบบไม่ถูกต้อง');const a=db.prepare('SELECT * FROM admins WHERE username=?').get(b.username);if(!a||!matches(b.password,a.password))fail(401,'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');const token=crypto.randomBytes(32).toString('base64url');db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),a.username,Date.now()+28800000);res.setHeader('Set-Cookie',`hdc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);audit(a.username,'login','เข้าสู่ระบบ Administrator');return json(res,{username:a.username})}
 if(p.startsWith('/api/identity/'))return await identityService.machine(req,res,p);
 if(p.startsWith('/api/v1/')){const key=(req.headers.authorization||'').replace(/^Bearer /,'');const client=db.prepare('SELECT * FROM clients WHERE key_hash=?').get(hash(key));if(!key||!client)fail(401,'API Key ไม่ถูกต้อง');db.prepare('UPDATE clients SET last_used=? WHERE id=?').run(new Date().toISOString(),client.id);if(p==='/api/v1/sync-status'&&method==='POST'){const b=await body(req,1000);if(!Number.isInteger(b.version)||b.version<1||b.version>version()||!Number.isInteger(b.store_count)||b.store_count<0||b.store_count>10000)fail(422,'Invalid sync acknowledgement');if(client.synced_version!==null&&client.synced_version>b.version)fail(409,'Older sync acknowledgement');db.prepare('UPDATE clients SET synced_version=?,synced_count=?,synced_at=? WHERE id=?').run(b.version,b.store_count,new Date().toISOString(),client.id);return json(res,{ok:true})}if(method!=='GET')fail(405,'API นี้อ่านข้อมูลได้เท่านั้น');if(p==='/api/v1/client')return json(res,{id:client.id,name:client.name,version:version(),store_count:rows().length});if(p==='/api/v1/datasets/stores/version')return json(res,{version:version()});if(p==='/api/v1/stores')return json(res,{version:version(),groups:storeGroups,allow_empty:Number(db.prepare("SELECT value FROM settings WHERE key='stores_cleared_version'").get()?.value??-1)===version(),stores:rows()});if(p.startsWith('/api/v1/stores/')){const s=rows().find(s=>s.code===decodeURIComponent(p.slice(15)));if(!s)fail(404,'ไม่พบ Store');return json(res,s)}fail(404,'ไม่พบ API')}
 if(p.startsWith('/api/')){const user=admin(req);if(await identityService.admin(req,res,p,user))return;if(await handleAccounts(req,res,p,user))return;
 if(p==='/api/logout'&&method==='POST'){const token=(req.headers.cookie||'').match(/(?:^|;\s*)hdc_session=([^;]+)/)?.[1]||'';db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token));res.setHeader('Set-Cookie','hdc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,{ok:true})}
 if(p==='/api/state'&&method==='GET')return json(res,{username:user,workspace:db.prepare("SELECT value FROM settings WHERE key='workspace'").get().value,version:version(),groups:storeGroups,stores:rows(),activities:db.prepare('SELECT actor,action AS title,detail,created_at AS time FROM audit ORDER BY id DESC LIMIT 100').all(),clients:db.prepare('SELECT id,name,key_hash IS NOT NULL AS configured,last_used,synced_version,synced_count,synced_at FROM clients').all()});
 if(p==='/api/stores/delete-all'&&method==='POST'){
  const b=await body(req,1000);
  if(b.confirmation!=='DELETE ALL STORES')fail(422,'กรุณาพิมพ์ DELETE ALL STORES เพื่อยืนยัน');
  let deleted=0;
  transaction(()=>{
   if(b.version!==version())fail(409,'ข้อมูล Store เปลี่ยนแปลงแล้ว กรุณารีเฟรชและยืนยันใหม่');
   deleted=Number(db.prepare('SELECT count(*) AS n FROM stores').get().n);
   if(!deleted)return;
   db.prepare('DELETE FROM stores').run();bump();
   db.prepare("INSERT INTO settings(key,value) VALUES('stores_cleared_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(version()));
   db.prepare('DELETE FROM previews').run();
   audit(user,'ลบ Store ทั้งหมด',`${deleted} Store`);
  });
  return json(res,{ok:true,deleted,version:version()});
 }
 if(p==='/api/stores'&&method==='POST'){const s=validStore(await body(req,2000));transaction(()=>{if(db.prepare('SELECT 1 FROM stores WHERE code=?').get(s.code))fail(409,'รหัส Store นี้มีอยู่แล้ว');db.prepare('INSERT INTO stores(code,name,active,updated_at,memberships) VALUES(?,?,?,?,?)').run(s.code,s.name,+s.active,new Date().toISOString(),JSON.stringify(s.memberships));bump();audit(user,'เพิ่ม Store',`${s.code} · ${s.name}`)});return json(res,{ok:true},201)}
 if(p.startsWith('/api/stores/')&&method==='PUT'){const code=decodeURIComponent(p.slice(12)),s=validStore(await body(req,2000));if(code!==s.code)fail(422,'รหัส Store ไม่ตรงกัน');transaction(()=>{if(!db.prepare('SELECT 1 FROM stores WHERE code=?').get(code))fail(404,'ไม่พบ Store');db.prepare('UPDATE stores SET name=?,active=?,updated_at=?,memberships=? WHERE code=?').run(s.name,+s.active,new Date().toISOString(),JSON.stringify(s.memberships),code);bump();audit(user,'แก้ไข Store',`${code} · ${s.name} · ${s.active?'เปิด':'ปิด'}ใช้งาน`)});return json(res,{ok:true})}
 if(p==='/api/settings'&&method==='PUT'){const b=await body(req,1000);if(typeof b.workspace!=='string'||!b.workspace.trim()||b.workspace.length>80)fail(422,'ชื่อพื้นที่ทำงานไม่ถูกต้อง');transaction(()=>{db.prepare("UPDATE settings SET value=? WHERE key='workspace'").run(b.workspace.trim());audit(user,'แก้ไขตั้งค่า',b.workspace.trim())});return json(res,{ok:true})}
 if(/^\/api\/clients\/[^/]+\/key$/.test(p)&&method==='POST'){const id=p.split('/')[3];if(!db.prepare('SELECT 1 FROM clients WHERE id=?').get(id))fail(404,'ไม่พบโปรเจค');const key='hdc_'+crypto.randomBytes(32).toString('base64url');transaction(()=>{db.prepare('UPDATE clients SET key_hash=?,synced_version=NULL,synced_count=NULL,synced_at=NULL WHERE id=?').run(hash(key),id);audit(user,'สร้างหรือหมุน API Key',id)});return json(res,{key})}
 if(p==='/api/import/preview'&&method==='POST'){const b=await body(req);if(typeof b.filename!=='string'||!b.filename.toLowerCase().endsWith('.xlsx')||typeof b.content!=='string')fail(422,'กรุณาเลือกไฟล์ .xlsx');const buffer=Buffer.from(b.content,'base64');if(buffer.length>5000000)fail(413,'ไฟล์ต้องไม่เกิน 5 MB');
 let workbook;try{workbook=readWorkbook(buffer)}catch(e){fail(422,'ไม่สามารถอ่าน Excel: '+e.message)}const sheets=workbook.sheets.map(s=>s.name);if(!b.sheet)return json(res,{sheets});let list;try{list=b.sheet==='*'?allRecords(workbook):workbook.records(b.sheet)}catch(e){fail(422,e.message)}const old=new Map(rows().map(s=>[s.code,s]));const added=list.filter(s=>!old.has(s.code)).length,changed=list.filter(s=>old.has(s.code)&&(old.get(s.code).name!==s.name||JSON.stringify(old.get(s.code).memberships)!==JSON.stringify(mergeMemberships(old.get(s.code).memberships,s.memberships)))).length;const id=crypto.randomUUID();db.prepare('DELETE FROM previews WHERE expires<?').run(Date.now());db.prepare('INSERT INTO previews VALUES(?,?,?,?,?)').run(id,user,JSON.stringify(list),b.filename,Date.now()+900000);return json(res,{id,version:version(),total:list.length,added,changed,unchanged:list.length-added-changed,sample:list.slice(0,10)})}
 if(p==='/api/import/confirm'&&method==='POST'){const b=await body(req,1000);transaction(()=>{const preview=db.prepare('SELECT * FROM previews WHERE id=? AND username=? AND expires>?').get(b.id,user,Date.now());if(!preview)fail(422,'รายการตรวจสอบหมดอายุ กรุณาเลือกไฟล์ใหม่');if(b.version!==version())fail(409,'ข้อมูลถูกแก้ไขระหว่างตรวจสอบ กรุณาตรวจไฟล์ใหม่');const upsert=db.prepare('INSERT INTO stores(code,name,active,updated_at,memberships) VALUES(?,?,1,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at,memberships=excluded.memberships');const records=JSON.parse(preview.records);for(const s of records){const previous=db.prepare('SELECT memberships FROM stores WHERE code=?').get(s.code);upsert.run(s.code,s.name,new Date().toISOString(),JSON.stringify(mergeMemberships(previous?JSON.parse(previous.memberships):[],s.memberships)))}bump();audit(user,'นำเข้า Excel',`${preview.filename} · ${records.length} Store`);db.prepare('DELETE FROM previews WHERE id=?').run(b.id)});return json(res,{ok:true})}
 fail(404,'ไม่พบ API')}
 if(method!=='GET'&&method!=='HEAD')fail(405,'Method not allowed');const files={'/':'index.html','/app.js':'app.js','/store-groups.js':'store-groups.js','/shared-accounts.js':'shared-accounts.js','/styles.css':'styles.css','/branding/cj-logistics.png':'branding/cj-logistics.png'};const file=files[p];if(!file)fail(404,'Not found');const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};res.writeHead(200,{'Content-Type':types[path.extname(file)],'Cache-Control':'no-cache'});res.end(method==='HEAD'?undefined:fs.readFileSync(path.join(__dirname,'../frontend',file)));
 }catch(e){if(!res.headersSent){if(!e.status)console.error(e);json(res,{detail:e.status?e.message:'เกิดข้อผิดพลาดภายในระบบ'},e.status||500)}else res.end()}}
 return {server:http.createServer(handler),db,createAdmin(username,password){if(!/^[A-Za-z0-9_.-]{1,60}$/.test(username)||password.length<12||password.length>200)throw new Error('Username: A-Z a-z 0-9 _ . - (1–60); password: 12–200 characters');db.prepare('INSERT INTO admins VALUES(?,?)').run(username,passwordHash(password));}};
}
module.exports={createApp};
if(require.main===module){const app=createApp();app.server.listen(Number(process.env.PORT||8082),process.env.HOST||'127.0.0.1',()=>console.log(`HDC Data Center listening on port ${process.env.PORT||8082}`));}
