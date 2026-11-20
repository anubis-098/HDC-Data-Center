# HDC Data Center

ระบบข้อมูล Store กลางธีม CJ Logistics พร้อม Administrator Login, จัดการ Store, นำเข้า Excel จริง, ประวัติการแก้ไข และ API Key แยกโปรเจค ใช้ Node.js 24 / SQLite บน Docker volume

## เริ่มใช้งาน Docker Compose

ก่อนเริ่ม ให้เตรียม Certificate และแก้ค่า HTTPS ใน `.env` ตาม [คู่มือ HTTPS](deployment/README.md) ส่วนการคัดลอก `.env.example` ด้านล่างใช้เฉพาะการติดตั้งใหม่ อย่าทับ `.env` เดิมของ Server

```powershell
cd D:\Code\HDC-Data-Center
Copy-Item .env.example .env
docker compose config --quiet
docker compose up --build -d
docker compose exec data-center node backend/manage.cjs create-admin
```

สร้าง username และรหัสผ่านอย่างน้อย 12 ตัว (ซ่อนการพิมพ์) ไม่มีรหัสผ่านเริ่มต้น เปิด https://10.84.185.1:8082 แล้วเข้าสู่ระบบ นำเข้า List Store.xlsx เลือกชีต ตรวจสอบ และยืนยัน ฐานเริ่มว่าง ไม่ได้นำเข้าตัวอย่างอัตโนมัติ

`docker compose down` เก็บข้อมูลเดิม ห้ามใช้ `down -v` หากต้องการเก็บฐาน ค่าเริ่มต้น bind เฉพาะ localhost หากใช้ผ่าน LAN ให้ตั้ง `BIND_ADDRESS=0.0.0.0`, `PUBLIC_ORIGIN=https://10.84.185.1:8082` และ `COOKIE_SECURE=true` ใน `.env`

## ข้อมูลและการนำเข้า

- รหัส Store เป็นข้อความ A-Z a-z 0-9 _ - ยาว 1–30 ตัว; ชื่อไม่เกิน 160 ตัว ปิดใช้งานแทนการลบ
- XLSX ไม่เกิน 5 MB / 10,000 แถว รองรับหัว ST, ST. No, Store No, Store Code และ Store Name; ไม่รองรับสูตร XLS/XLSM และโครงสร้างเซลล์ซับซ้อน
- เก็บเลขศูนย์นำหน้าที่เป็นข้อความหรือรูปแบบตัวเลข 000; ไม่แปลง 1 เป็น 001 เอง
- รหัสซ้ำชื่อขัดแย้งปฏิเสธทั้งไฟล์ รหัสซ้ำชื่อเดียวกันรวมรายการ
- ตรวจสอบก่อนยืนยัน (หมดอายุ 15 นาที) บันทึกแบบ transaction เดียว พร้อมตรวจเวอร์ชันป้องกันทับการแก้ไขระหว่างตรวจไฟล์
- อัปเดตชื่อ เก็บสถานะเปิด/ปิดเดิม ไม่ลบ Store ที่ไม่มีในไฟล์
- Audit Log เก็บในฐานถาวร หน้าเว็บแสดงล่าสุด 100 รายการ

## API

Store รองรับ Group `1PX` และ `HLE` พร้อม Category ตามไฟล์ `Example/Store.xlsx` โดยนำเข้าชีต Master HLE และ Master 1PX พร้อมกันได้ ดูรายละเอียดใน [Store Group / Category](integration/store-groups.md)

หน้า “ข้อมูล Store” มีปุ่มลบ Store ทั้งหมด ต้องพิมพ์ `DELETE ALL STORES` เพื่อยืนยัน หลังซิงก์ รายการจะไม่แสดงให้เลือกในสองโปรเจค แต่ยังเก็บประวัติงานเดิมไว้ การเลือก Store เป็นช่องเดียวที่พับ–ขยาย Group/Category และค้นหาได้

หน้า “การเชื่อมต่อ API” สร้าง Key แยกโปรเจค แสดงเพียงครั้งเดียว เก็บ Key ใน Backend ปลายทาง การหมุน Key ยกเลิกตัวเดิมทันที

```http
GET /api/v1/stores
Authorization: Bearer <API_KEY>
```

ผลลัพธ์มี `version`, `groups`, `allow_empty` และ `stores` แต่ละ Store มี `code`, `name`, `active`, `updated_at`, `memberships` ซึ่งเป็นรายการ `{group, category}` คืน Store ทั้งเปิดและปิดเพื่อซิงก์สถานะ `allow_empty=true` ใช้ประกาศชุดข้อมูลว่างหลังสั่งลบทั้งหมดโดย Administrator เท่านั้น ใช้ GET /api/v1/datasets/stores/version ตรวจเวอร์ชัน หรือ GET /api/v1/stores/{code} อ่านรายตัว GET /api/ready เป็น healthcheck

Data Center ใช้ network hdc-master-data และชื่อภายใน http://hdc-data-center:8082 สำหรับ API ระหว่างโปรเจค

## เชื่อมสองโปรเจค

มี Compose overlay สำหรับ HDC-Container-loading และ HDC-Tote-tracker ซิงก์ Store ทุก 60 วินาที บันทึกลงฐานเดิมและใช้ cache เมื่อศูนย์กลางไม่พร้อม หน้า Store เปลี่ยนเป็นอ่านอย่างเดียวพร้อมปุ่มซิงก์ ไม่เปลี่ยนข้อมูลประวัติของงานเดิม

หลังเปิด Data Center และนำเข้า Store แล้ว สร้าง API Key แยกสองโปรเจคในหน้า API จากนั้นรัน:

```powershell
.\scripts\Start-Integration.ps1
```

สคริปต์ถาม Key แบบซ่อนการพิมพ์ ตรวจว่า Key ตรงโปรเจค แล้ว build/deploy ด้วย overlay โดยไม่เขียน source เดิม ต้องมี Docker Compose 2.17+ และ .env เดิมของสองโปรเจค ใช้สคริปต์เดิมเมื่อ rebuild เพื่อคง overlay

Data Center แสดงทั้งเวลาเรียก API และเวอร์ชัน/จำนวน Store ที่ปลายทางยืนยันหลัง commit สำเร็จ ดูขั้นตอนและข้อกำหนด deployment ใน [integration/README.md](integration/README.md)

## จัดการบัญชี Administrator ของสองโปรเจค

เมนู “บัญชีผู้ใช้” สร้าง Administrator กลางหนึ่งบัญชี แล้วใช้ชื่อและรหัสผ่านชุดเดียวกันเข้าสู่ Container Loading และ Tote Tracker โดยค่าเริ่มต้นเข้าได้ทั้งสองโปรเจค เลือกสิทธิ์โปรเจค เปิด/ปิด หรือเปลี่ยนรหัสผ่าน (12–200 ตัว) ได้จากจุดเดียว

หากมีบัญชีเดิมชื่อซ้ำ ให้สร้างบัญชีกลางพร้อมรหัสผ่านใหม่ แล้วเปิด “บัญชีเดิม / เชื่อมบัญชี” เลือกบัญชีเดิมของแต่ละโปรเจคและยืนยันเชื่อม ประวัติและ UUID ปลายทางเดิมยังอยู่ ไม่เชื่อมชื่อที่ซ้ำกันอัตโนมัติ ถ้าเป็นชื่อใหม่ที่ไม่ชน ระบบสร้างตัวอ้างอิงในโปรเจคเมื่อเข้าสู่ระบบครั้งแรก

ทั้งสองโปรเจคตรวจรหัสผ่านและสิทธิ์กับ Data Center บัญชีกลางที่เปลี่ยนชื่อ รหัสผ่าน สถานะ หรือสิทธิ์ จะต้องเข้าสู่ระบบใหม่ทั้งสองเว็บ การยกเลิกสิทธิ์มีผลในการตรวจ Session ครั้งถัดไป บัญชีกลางต้องติดต่อ Data Center ได้ขณะเข้าสู่ระบบและใช้สิทธิ์ Administrator; งานพนักงานและ Store cache ยังใช้รูปแบบเดิม

รัน Start-Integration.ps1 ใหม่เพื่อเปิดใช้ฟีเจอร์ทั้งสามระบบ สคริปต์ใช้ Store API Key จาก container เดิมถ้ามี หรือถาม Key เมื่อยังไม่เคยตั้งค่า หากต้องป้อน Key ใหม่ใช้ `-PromptForApiKeys`

สคริปต์สร้าง Management Key แยกต่อโปรเจคใน `.secrets/` ใช้เฉพาะการติดต่อระหว่าง Backend และ mount แบบอ่านอย่างเดียว ไม่ส่งไปเบราว์เซอร์และไม่เพิ่มสิทธิ์ให้ Store API Key เดิม เก็บโฟลเดอร์นี้ไว้กับ deployment และสำรองอย่างปลอดภัย ไม่ใส่ Git หรือ Docker image

ป้องกันการปิดหรือถอดสิทธิ์ Administrator กลางคนสุดท้ายของแต่ละโปรเจค บันทึก Audit โดยไม่เก็บรหัสผ่านใน Audit รหัสผ่านกลางเก็บ scrypt hash ที่ Data Center ส่วนโปรเจคเก็บตัวอ้างอิงและ Session บัญชีกลางนี้มีสิทธิ์ในสองโปรเจคตามที่เลือก; ผู้ดูแล Data Center ใช้บัญชี Data Center เดิม

## พัฒนาและทดสอบ

ใช้ Node.js 24 ไม่มี dependency ภายนอก:

```powershell
npm.cmd run check
npm.cmd test
node backend/manage.cjs create-admin
npm.cmd start
```

ฐาน local อยู่ data/hdc.sqlite แยกจาก Docker volume การทดสอบใช้ฐานชั่วคราว ทดสอบสิทธิ์, Origin, Login, Store, Excel, version conflict, Audit, API Key rotation, Logout และข้อมูลหลังเปิดฐานใหม่

สำรองด้วย SQLite backup API หรือหยุด container ก่อนคัดลอกฐาน ไม่คัดลอกฐานที่กำลังเขียนโดยละเลยไฟล์ WAL เหมาะกับ master data ขนาดเล็กและ app instance เดียว หากต้องการหลาย replica ควรย้ายเป็น PostgreSQL

Administrator Session อายุ 8 ชั่วโมง Cookie HttpOnly / SameSite=Strict รหัสผ่านใช้ scrypt และ API Key เก็บเฉพาะ SHA-256 ตรวจ Origin ทุกคำขอเปลี่ยนข้อมูลจากเว็บ ส่วน service acknowledgement ใช้ Bearer API Key และเขียนได้เฉพาะสถานะซิงก์ของโปรเจคตัวเอง

CI ใช้โลโก้เดิมจาก HDC-Tote-tracker (frontend/branding/SOURCE.md) สีน้ำเงิน #006da8 / #0080c6 พร้อมแถบแดง–ส้ม ฟอนต์ Sarabun พร้อม Tahoma/Arial fallback เมื่อเครื่องไม่มี Sarabun
