const fs=require('node:fs');
const path=require('node:path');
const defaults={
 'container-loading':{name:'Container Loading',url:'http://hdc-container-loading-api:8000'},
 'tote-tracker':{name:'Tote Tracker',url:'http://hdc-tote-tracker-api:8000'}
};
function accountGateway({secretDirectory,targets=defaults,audit,readBody,json}){
 function keyFor(id){try{const key=fs.readFileSync(path.join(secretDirectory,id+'.key'),'utf8').trim();return /^[a-f0-9]{64}$/.test(key)?key:null}catch{return null}}
 const handler=async function(req,res,p,user){
  if(p==='/api/accounts'&&req.method==='GET'){json(res,{projects:Object.entries(targets).map(([id,t])=>({id,name:t.name,configured:!!keyFor(id)}))});return true}
  if(!p.startsWith('/api/accounts/'))return false;
  const match=p.match(/^\/api\/accounts\/([a-z-]+)(?:\/([a-f0-9-]{36})(\/password)?)?$/);
  if(!match||!Object.hasOwn(targets,match[1])){json(res,{detail:'ไม่พบโปรเจคหรือบัญชี'},404);return true}
  const [,project,id,password]=match,method=req.method;
  if(!((!id&&['GET','POST'].includes(method))||(id&&!password&&method==='PUT')||(id&&password&&method==='POST'))){json(res,{detail:'Method not allowed'},405);return true}
  const key=keyFor(project);if(!key){json(res,{detail:'ยังไม่ได้ตั้งค่าการจัดการบัญชี กรุณารัน Start-Integration.ps1 ใหม่'},503);return true}
  let data;if(method!=='GET')data=await readBody(req,4000);
  let response,payload;
  try{
   response=await fetch(targets[project].url+'/api/hdc/accounts'+(id?'/'+id:'')+(password?'/password':''),{method,headers:{Authorization:'Bearer '+key,'X-HDC-Actor':encodeURIComponent(user),'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(10000)});
   const text=await response.text();if(text.length>1000000)throw Error('Oversized response');payload=JSON.parse(text);
  }catch{json(res,{detail:'ติดต่อระบบปลายทางไม่ได้ กรุณารีเฟรชตรวจบัญชีก่อนลองใหม่'},503);return true}
  if(!response.ok){const status=[404,409,422].includes(response.status)?response.status:502;json(res,{detail:status===502?'ระบบปลายทางยังไม่พร้อมจัดการบัญชี กรุณาอัปเดต Integration':payload.detail},status);return true}
  if(method!=='GET')audit(user,password?'account.password':id?'account.update':'account.create',project+' · '+String(payload.username||id||''));
  // Password hashes and service credentials never leave the gateway.
  const publicAccount=a=>({id:a.id,username:a.username,active:a.active,...(a.central_id?{central_id:a.central_id}:{})});
  json(res,Array.isArray(payload)?payload.map(publicAccount):publicAccount(payload),response.status);return true;
 };
 handler.linkLegacy=async(project,id,data,user)=>{
  const key=keyFor(project);if(!key)throw Object.assign(Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อโปรเจค'),{status:503});
  let response,payload;try{response=await fetch(targets[project].url+'/api/hdc/accounts/'+id+'/link',{method:'POST',headers:{Authorization:'Bearer '+key,'X-HDC-Actor':encodeURIComponent(user),'Content-Type':'application/json'},body:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(10000)});payload=await response.json()}catch{throw Object.assign(Error('ติดต่อโปรเจคไม่ได้ กรุณาตรวจบัญชีเดิมก่อนลองใหม่'),{status:503})}
  if(!response.ok)throw Object.assign(Error([404,409,422].includes(response.status)?payload.detail:'โปรเจคยังไม่พร้อม กรุณาอัปเดต Integration'),{status:[404,409,422].includes(response.status)?response.status:503});
  return {id:payload.id,username:payload.username,active:payload.active,central_id:payload.central_id};
 };
 return handler;
}
module.exports={accountGateway};
