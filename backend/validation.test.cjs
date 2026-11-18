const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createApp}=require('./server.cjs');

async function fixture(run){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hdc-validation-'));
 const app=createApp({directory,origin:'http://test.local'});
 app.createAdmin('admin','test-password-123');
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port;
 let cookie='';
 async function request(route,method='GET',body,extra={}){
  const response=await fetch(base+route,{method,headers:{Origin:'http://test.local',Cookie:cookie,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});
  return {response,data:await response.json()};
 }
 try{
  const login=await request('/api/login','POST',{username:'admin',password:'test-password-123'});
  cookie=login.response.headers.get('set-cookie').split(';')[0];
  await run({app,request,directory});
 }finally{
  await new Promise(resolve=>app.server.close(resolve));app.db.close();
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true});
 }
}

test('Non-object JSON is rejected without an internal server error',async()=>fixture(async({request})=>{
 for(const route of ['/api/login','/api/stores','/api/import/preview','/api/stores/delete-all']){
  for(const body of [null,[],true,'invalid']){
   const result=await request(route,'POST',body);
   assert.equal(result.response.status,422,`${route}: ${JSON.stringify(body)}`);
  }
 }
}));

test('Malformed Store URL encoding is a client error',async()=>fixture(async({request})=>{
 await request('/api/stores','POST',{code:'1',name:'Store',active:true});
 const key=(await request('/api/clients/container-loading/key','POST',{})).data.key;
 assert.equal((await request('/api/v1/stores/%ZZ','GET',undefined,{Authorization:'Bearer '+key})).response.status,400);
 assert.equal((await request('/api/stores/%ZZ','PUT',{})).response.status,400);
}));

test('Store writes and imports cannot publish more than consumers can sync',async()=>fixture(async({app,request,directory})=>{
 app.db.exec('BEGIN');
 const insert=app.db.prepare('INSERT INTO stores(code,name,active,updated_at) VALUES(?,?,1,?)');
 for(let i=0;i<10000;i++)insert.run('S'+i,'Store '+i,new Date().toISOString());
 app.db.prepare("UPDATE settings SET value='1' WHERE key='version'").run();app.db.exec('COMMIT');
 assert.equal((await request('/api/stores','POST',{code:'EXTRA',name:'Overflow',active:true})).response.status,422);
 assert.equal((await request('/api/stores/S0','PUT',{code:'S0',name:'Updated',active:true})).response.status,200);
 const content=fs.readFileSync(path.join(__dirname,'../Example/Store.xlsx')).toString('base64');
 assert.equal((await request('/api/import/preview','POST',{filename:'Store.xlsx',content,sheet:'*'})).response.status,422);
 const before=app.db.prepare("SELECT value FROM settings WHERE key='version'").get().value;
 app.db.prepare('INSERT INTO previews VALUES(?,?,?,?,?)').run('capacity-preview','admin',JSON.stringify([{code:'S0',name:'Must not change'},{code:'EXTRA',name:'Overflow'}]),'test.xlsx',Date.now()+60000);
 assert.equal((await request('/api/import/confirm','POST',{id:'capacity-preview',version:Number(before)})).response.status,422);
 assert.equal(app.db.prepare("SELECT name FROM stores WHERE code='S0'").get().name,'Updated');
 const cli=spawnSync(process.execPath,[path.join(__dirname,'import-stores.cjs'),path.join(__dirname,'../Example/Store.xlsx'),'--apply'],{env:{...process.env,DATA_DIRECTORY:directory},encoding:'utf8'});
 assert.notEqual(cli.status,0);assert.equal(app.db.prepare('SELECT count(*) AS n FROM stores').get().n,10000);
 assert.equal(app.db.prepare("SELECT value FROM settings WHERE key='version'").get().value,before);
}));
