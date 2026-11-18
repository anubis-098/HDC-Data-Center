const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('./server.cjs');

test('Delete all requires Administrator, confirmation and current version; publishes an explicit empty snapshot',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hdc-delete-stores-'));
 const app=createApp({directory,origin:'http://test.local'});
 app.createAdmin('admin','test-password-123');
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port;
 let cookie='';
 async function request(route,method='GET',body){
  const response=await fetch(base+route,{method,headers:{Origin:'http://test.local',Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {response,data:await response.json()};
 }
 try{
  assert.equal((await request('/api/stores/delete-all','POST',{confirmation:'DELETE ALL STORES',version:0})).response.status,401);
  const login=await request('/api/login','POST',{username:'admin',password:'test-password-123'});
  cookie=login.response.headers.get('set-cookie').split(';')[0];
  await request('/api/stores','POST',{code:'1',name:'Store',active:true});
  const key=(await request('/api/clients/container-loading/key','POST',{})).data.key;
  const state=(await request('/api/state')).data;
  assert.equal((await request('/api/stores/delete-all','POST',{confirmation:'wrong',version:state.version})).response.status,422);
  assert.equal((await request('/api/stores/delete-all','POST',{confirmation:'DELETE ALL STORES',version:0})).response.status,409);
  assert.equal((await request('/api/state')).data.stores.length,1);
  const deleted=await request('/api/stores/delete-all','POST',{confirmation:'DELETE ALL STORES',version:state.version});
  assert.equal(deleted.response.status,200);assert.equal(deleted.data.deleted,1);
  const after=(await request('/api/state')).data;
  assert.equal(after.stores.length,0);assert.ok(after.activities.some(item=>item.title==='ลบ Store ทั้งหมด'));
  const snapshot=await (await fetch(base+'/api/v1/stores',{headers:{Authorization:'Bearer '+key}})).json();
  assert.deepEqual(snapshot.stores,[]);assert.equal(snapshot.allow_empty,true);
  assert.equal((await fetch(base+'/api/v1/sync-status',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({version:snapshot.version,store_count:0})})).status,200);
  await request('/api/stores','POST',{code:'2',name:'New Store',active:true});
  const next=await (await fetch(base+'/api/v1/stores',{headers:{Authorization:'Bearer '+key}})).json();
  assert.equal(next.allow_empty,false);assert.equal(next.stores.length,1);
 }finally{
  await new Promise(resolve=>app.server.close(resolve));app.db.close();
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true});
 }
});
