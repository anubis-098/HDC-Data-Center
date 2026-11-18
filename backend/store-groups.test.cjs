const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {readWorkbook,allRecords}=require('./xlsx.cjs');
const {memberships,mergeMemberships,storeGroups}=require('./store-groups.cjs');
const {createApp}=require('./server.cjs');
const sample=()=>fs.readFileSync(path.join(__dirname,'../Example/Store.xlsx'));

test('Real workbook joins HLE and 1PX memberships without duplicating Stores',()=>{
 const workbook=readWorkbook(sample());
 assert.equal(workbook.records('Master HLE').length,164);
 assert.equal(workbook.records('Master 1PX').length,166);
 const records=allRecords(workbook);
 assert.equal(records.length,166);
 assert.equal(records.reduce((sum,store)=>sum+store.memberships.length,0),330);
 assert.deepEqual(records.find(store=>store.code==='1').memberships,[{group:'1PX',category:'Combine HLE Direct'},{group:'HLE',category:'Direct'}]);
 for(const [group,categories] of Object.entries(storeGroups))assert.deepEqual([...new Set(records.flatMap(store=>store.memberships.filter(item=>item.group===group).map(item=>item.category)))].sort(),[...categories].sort());
 assert.equal(records.filter(store=>store.code==='352').length,1);
 assert.equal(records.find(store=>store.code==='175').name,'Happitat');
 assert.throws(()=>memberships([{group:'HLE',category:'Transfer CDC'}]));
 assert.throws(()=>memberships([{group:'1PX',category:'Transfer CDC'},{group:'1PX',category:'Transfer CDC'}]));
 assert.deepEqual(mergeMemberships([{group:'HLE',category:'Direct'},{group:'1PX',category:'Transfer CDC'}],[{group:'HLE',category:'Hub Surat'}]),[{group:'1PX',category:'Transfer CDC'},{group:'HLE',category:'Hub Surat'}]);
});

test('Grouped import preview, publication, API, manual edits and single-sheet merge',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hdc-groups-'));
 const app=createApp({directory,origin:'http://test.local'});
 app.createAdmin('admin','test-password-123');
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port;
 let cookie='';
 async function request(route,method='GET',body){
  const response=await fetch(base+route,{method,headers:{Origin:'http://test.local',Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {response,data:await response.json()};
 }
 try {
  const login=await request('/api/login','POST',{username:'admin',password:'test-password-123'});
  cookie=login.response.headers.get('set-cookie').split(';')[0];
  await request('/api/stores','POST',{code:'1',name:'Original',active:false});
  const content=sample().toString('base64');
  const preview=await request('/api/import/preview','POST',{filename:'Store.xlsx',content,sheet:'*'});
  assert.equal(preview.response.status,200);
  assert.equal(preview.data.total,166);
  assert.equal(preview.data.sample[0].memberships.length,2);
  assert.equal((await request('/api/import/confirm','POST',{id:preview.data.id,version:preview.data.version})).response.status,200);
  let state=(await request('/api/state')).data;
  assert.equal(state.stores.find(store=>store.code==='1').active,false);
  assert.equal(Object.keys(state.groups).length,2);
  const key=(await request('/api/clients/container-loading/key','POST',{})).data.key;
  const snapshot=await (await fetch(base+'/api/v1/stores',{headers:{Authorization:'Bearer '+key}})).json();
  assert.equal(snapshot.stores.find(store=>store.code==='1').memberships.length,2);
  assert.equal((await request('/api/stores/1','PUT',{code:'1',name:'Manual',active:true,memberships:[{group:'HLE',category:'BAD'}]})).response.status,422);
  assert.equal((await request('/api/stores/1','PUT',{code:'1',name:'Manual',active:true,memberships:[{group:'1PX',category:'Transfer MKB'},{group:'HLE',category:'Direct'}]})).response.status,200);
  const single=(await request('/api/import/preview','POST',{filename:'Store.xlsx',content,sheet:'Master HLE'})).data;
  assert.equal((await request('/api/import/confirm','POST',{id:single.id,version:single.version})).response.status,200);
  state=(await request('/api/state')).data;
  assert.ok(state.stores.find(store=>store.code==='1').memberships.some(item=>item.group==='1PX'&&item.category==='Transfer MKB'));
 }finally{
  await new Promise(resolve=>app.server.close(resolve));app.db.close();
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));
  fs.rmSync(directory,{recursive:true,force:true});
 }
});
