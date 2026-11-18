// Local administrator import. Preview by default; --apply publishes atomically.
const fs=require('node:fs');
const path=require('node:path');
const {createApp}=require('./server.cjs');
const {readWorkbook,allRecords}=require('./xlsx.cjs');
const {mergeMemberships,assertStoreCapacity}=require('./store-groups.cjs');
function main(){
 const filename=process.argv[2];
 if(!filename || !filename.toLowerCase().endsWith('.xlsx'))throw Error('Usage: node backend/import-stores.cjs Store.xlsx [--apply]');
 const data=fs.readFileSync(filename);
 if(data.length>5000000)throw Error('Maximum 5 MB');
 const records=allRecords(readWorkbook(data));
 const app=createApp();
 try{
  const db=app.db;
  const existing=new Set(db.prepare('SELECT code FROM stores').all().map(store=>store.code));
  assertStoreCapacity(db, records);
  const summary={stores:records.length,added:records.filter(store=>!existing.has(store.code)).length,memberships:records.reduce((sum,store)=>sum+store.memberships.length,0)};
  if(!process.argv.includes('--apply')){console.log(JSON.stringify({...summary,applied:false}));return}
  db.exec('BEGIN IMMEDIATE');
  try{
   assertStoreCapacity(db, records);
   const upsert=db.prepare('INSERT INTO stores(code,name,active,updated_at,memberships) VALUES(?,?,1,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at,memberships=excluded.memberships');
   for(const store of records){
    const previous=db.prepare('SELECT memberships FROM stores WHERE code=?').get(store.code);
    upsert.run(store.code,store.name,new Date().toISOString(),JSON.stringify(mergeMemberships(previous?JSON.parse(previous.memberships):[],store.memberships)));
   }
   db.prepare("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='version'").run();
   db.prepare('INSERT INTO audit(actor,action,detail) VALUES(?,?,?)').run('local-import','นำเข้า Excel',`${path.basename(filename)} · ${records.length} Store · Master HLE + Master 1PX`);
   db.exec('COMMIT');
   console.log(JSON.stringify({...summary,applied:true}));
  }catch(error){db.exec('ROLLBACK');throw error}
 }finally{app.db.close()}
}
try{main()}catch(error){console.error(error.message);process.exitCode=1}
