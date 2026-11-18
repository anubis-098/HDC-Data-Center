const storeGroups = {
  '1PX': ['Combine HLE Direct', 'Transfer CDC', 'Transfer CDC-FS', 'Transfer MKB', 'Transfer MKD3'],
  HLE: ['Direct', 'Hub Chiangmai', 'Hub Hatyai', 'Hub Kamphaeng', 'Hub Khonkaen', 'Hub Korat', 'Hub Rayong', 'Hub Surat', 'Hub Ubon', 'Hub Udon'],
};
function memberships(value = []) {
  if (!Array.isArray(value) || value.length > 15) throw Error('Invalid Store categories');
  const seen = new Set();
  return value.map(item => {
    if (!item || !storeGroups[item.group]?.includes(item.category)) throw Error('Invalid Store Group / Category');
    const key = item.group + '/' + item.category;
    if (seen.has(key)) throw Error('Duplicate Store category');
    seen.add(key);
    return {group: item.group, category: item.category};
  }).sort((a,b) => a.group.localeCompare(b.group) || a.category.localeCompare(b.category));
}
function mergeMemberships(existing, incoming) {
  if (!incoming?.length) return existing || [];
  const groups = new Set(incoming.map(item => item.group));
  return memberships([...(existing || []).filter(item => !groups.has(item.group)), ...incoming]);
}
function assertStoreCapacity(db, records) {
  const codes = new Set(db.prepare('SELECT code FROM stores').all().map(store => store.code));
  for (const store of records) codes.add(store.code);
  if (codes.size > 10000) throw Object.assign(Error('ชุดข้อมูลต้องมี Store รวมไม่เกิน 10,000 รายการ เพื่อให้ทั้งสองโปรเจคซิงก์ได้'), {status: 422});
}
module.exports = {storeGroups, memberships, mergeMemberships, assertStoreCapacity};
