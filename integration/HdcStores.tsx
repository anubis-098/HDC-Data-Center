import { useEffect, useState } from 'react';
import { api, message, type Store } from '../lib/api';

type SyncStatus = { interval_seconds: number; sync: null | { version: number; last_success: string | null; last_error: string | null; store_count: number } };
export function HdcStores() {
  const [stores, setStores] = useState<Store[]>([]);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [category, setCategory] = useState('');
  async function load() {
    const [rows, result] = await Promise.all([api<Store[]>('/admin/stores'), api<SyncStatus>('/admin/data-center/status')]);
    setStores(rows); setStatus(result);
  }
  useEffect(() => { let alive = true; const refresh = () => { if (alive) void load().catch(e => { if (alive) setError(message(e)); }); }; refresh(); const timer = setInterval(refresh, 30000); return () => { alive = false; clearInterval(timer); }; }, []);
  async function sync() { setBusy(true); setError(''); try { await api('/admin/data-center/sync', { method: 'POST' }); await load(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  const categories = [...new Set(stores.flatMap(store => (store.memberships || []).filter(item => item.group === group).map(item => item.category)))].sort();
  const found = stores.filter(s => `${s.code} ${s.name}`.toLowerCase().includes(query.toLowerCase()) && (!group || s.memberships?.some(item => item.group === group && (!category || item.category === category))));
  return <section className="panel" style={{ padding: 20 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}><h2>Store · HDC Data Center</h2><button type="button" disabled={busy} onClick={() => void sync()}>{busy ? 'กำลังซิงก์…' : 'ซิงก์ตอนนี้'}</button></div>
    <p style={{ margin: '12px 0' }}>เพิ่ม แก้ไข และนำเข้าข้อมูลที่ HDC Data Center</p>
    <p style={{ fontSize: 12, marginBottom: 12 }}>เวอร์ชัน {status?.sync?.version && status.sync.version > 0 ? status.sync.version : '—'} · ซิงก์ล่าสุด {status?.sync?.last_success ? new Date(status.sync.last_success).toLocaleString('th-TH') : 'ยังไม่สำเร็จ'}</p>
    {(error || status?.sync?.last_error) && <div role="alert" className="error" style={{ marginBottom: 12 }}>{error || status?.sync?.last_error} · ใช้ข้อมูลที่ซิงก์สำเร็จล่าสุด</div>}
    <input aria-label="ค้นหา Store" placeholder="ค้นหารหัสหรือชื่อ Store" value={query} onChange={e => setQuery(e.target.value)} style={{ width: '100%', padding: 10, marginBottom: 14 }} />
    <div style={{display:'flex',gap:10,marginBottom:14,flexWrap:'wrap'}}>
      <select aria-label="กรอง Group" value={group} onChange={e=>{setGroup(e.target.value);setCategory('')}}><option value="">ทุก Group</option><option>1PX</option><option>HLE</option></select>
      <select aria-label="กรอง Category" value={category} disabled={!group} onChange={e=>setCategory(e.target.value)}><option value="">ทุก Category</option>{categories.map(name=><option key={name}>{name}</option>)}</select>
    </div>
    <div style={{ maxHeight: 520, overflow: 'auto' }}><table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}><thead><tr><th>รหัส</th><th>ชื่อ Store</th><th>Group / Category</th><th>สถานะ</th></tr></thead><tbody>{found.map(s => <tr key={s.code}><td style={{ padding: '10px 4px' }}>{s.code}</td><td>{s.name}</td><td>{s.memberships?.map(item=>`${item.group} / ${item.category}`).join(' · ') || 'ยังไม่จัดกลุ่ม'}</td><td>{s.active ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}</td></tr>)}</tbody></table></div>
    {!found.length && <p>ไม่พบ Store</p>}
  </section>;
}
