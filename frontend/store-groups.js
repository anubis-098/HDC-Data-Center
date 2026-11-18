let storeGroupFilter='',storeCategoryFilter='';
function deleteAllStores(){
 const modal=document.querySelector('#modal'),version=state.version;
 modal.innerHTML=`<form id="delete-stores-form"><h2>ลบ Store ทั้งหมด</h2>
 <p>ลบ Store ทั้งหมด ${stores.length} รายการออกจาก Data Center และหยุดแสดงเป็นตัวเลือกในทั้งสองโปรเจคหลังซิงก์ ประวัติงานและรูปภาพเดิมยังคงอยู่</p>
 <label for="delete-stores-confirmation">พิมพ์ DELETE ALL STORES เพื่อยืนยัน</label>
 <input id="delete-stores-confirmation" autocomplete="off" spellcheck="false" required>
 <p id="delete-stores-error" class="error" role="alert"></p>
 <div class="actions"><button type="button" class="btn" id="cancel-delete-stores">ยกเลิก</button><button type="submit" class="btn danger" id="confirm-delete-stores" disabled>ลบ Store ทั้งหมด</button></div></form>`;
 const input=modal.querySelector('#delete-stores-confirmation'),button=modal.querySelector('#confirm-delete-stores');
 let busy=false;
 input.oninput=()=>{button.disabled=busy||input.value!=='DELETE ALL STORES'};
 modal.querySelector('#cancel-delete-stores').onclick=()=>{if(!busy)modal.close()};
 modal.querySelector('#delete-stores-form').onsubmit=async event=>{
  event.preventDefault();if(busy||input.value!=='DELETE ALL STORES')return;
  busy=true;button.disabled=true;input.disabled=true;modal.querySelector('#cancel-delete-stores').disabled=true;
  try{
   const result=await api('/api/stores/delete-all',{method:'POST',body:JSON.stringify({confirmation:input.value,version})});
   modal.close();storeGroupFilter='';storeCategoryFilter='';query='';current=1;await refresh();toast(`ลบ Store แล้ว ${result.deleted} รายการ`);
  }catch(error){modal.querySelector('#delete-stores-error').textContent=error.message}
  finally{busy=false;button.disabled=input.value!=='DELETE ALL STORES';input.disabled=false;modal.querySelector('#cancel-delete-stores').disabled=false}
 };
 modal.showModal();
}
function storeGroupOptions(){return state.groups || {}}
function categoryText(store){return (store.memberships || []).map(item=>`${item.group} / ${item.category}`).join(' · ') || 'ยังไม่จัดกลุ่ม'}
function matchesStoreGroup(store){return !storeGroupFilter || (store.memberships || []).some(item=>item.group===storeGroupFilter && (!storeCategoryFilter || item.category===storeCategoryFilter))}
function storeFilterControls(){
 const groups=storeGroupOptions();
 return `<select id="store-group-filter" class="filter" aria-label="กรอง Group"><option value="">ทุก Group</option>${Object.keys(groups).map(group=>`<option value="${esc(group)}" ${storeGroupFilter===group?'selected':''}>${esc(group)}</option>`).join('')}</select>
 <select id="store-category-filter" class="filter" aria-label="กรอง Category" ${!storeGroupFilter?'disabled':''}><option value="">ทุก Category</option>${(groups[storeGroupFilter]||[]).map(category=>`<option value="${esc(category)}" ${storeCategoryFilter===category?'selected':''}>${esc(category)}</option>`).join('')}</select>`;
}
function bindStoreFilters(){
 const group=document.querySelector('#store-group-filter'),category=document.querySelector('#store-category-filter');
 if(!group || !category)return;
 group.onchange=()=>{storeGroupFilter=group.value;storeCategoryFilter='';current=1;render()};
 category.onchange=()=>{storeCategoryFilter=category.value;current=1;renderRows()};
}
function mountStoreMemberships(store){
 const host=document.querySelector('#store-memberships');
 const links=(store?.memberships || []).map(item=>({...item}));
 function renderLinks(){
  host.innerHTML=`<label>Group / Category</label>${links.map((link,index)=>`<div class="membership-row">
   <select data-membership-group="${index}" aria-label="Group ${index+1}" required><option value="">เลือก Group</option>${Object.keys(storeGroupOptions()).map(group=>`<option value="${esc(group)}" ${link.group===group?'selected':''}>${esc(group)}</option>`).join('')}</select>
   <select data-membership-category="${index}" aria-label="Category ${index+1}" required ${!link.group?'disabled':''}><option value="">เลือก Category</option>${(storeGroupOptions()[link.group]||[]).map(category=>`<option value="${esc(category)}" ${link.category===category?'selected':''}>${esc(category)}</option>`).join('')}</select>
   <button type="button" class="btn" data-remove-membership="${index}" aria-label="ลบกลุ่ม ${index+1}">×</button></div>`).join('')}
   <button type="button" class="btn" id="add-membership" ${links.length>=15?'disabled':''}>+ เพิ่ม Group / Category</button>`;
  host.querySelector('#add-membership').onclick=()=>{links.push({group:'',category:''});renderLinks()};
  host.querySelectorAll('[data-membership-group]').forEach(select=>select.onchange=()=>{links[+select.dataset.membershipGroup]={group:select.value,category:''};renderLinks()});
  host.querySelectorAll('[data-membership-category]').forEach(select=>select.onchange=()=>{links[+select.dataset.membershipCategory].category=select.value});
  host.querySelectorAll('[data-remove-membership]').forEach(button=>button.onclick=()=>{links.splice(+button.dataset.removeMembership,1);renderLinks()});
 }
 renderLinks();
 return ()=>links.map(item=>({...item}));
}
