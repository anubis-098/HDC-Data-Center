# การเชื่อม HDC Data Center กับสองโปรเจค

ใช้ Compose overlay ที่เพิ่ม Backend adapter และ build หน้า Store ใหม่แบบอ่านอย่างเดียว โดยไม่เขียน source หรือย้ายฐานข้อมูลเดิมของ Container Loading และ Tote Tracker ต้องใช้ Docker Compose 2.17+ / BuildKit (additional build contexts)

## เริ่มใช้งาน

1. ในโฟลเดอร์ Data Center รัน `docker compose up -d --build`
2. เปิด http://localhost:8082 เข้าระบบ Administrator และนำเข้า Store ให้มีข้อมูลอย่างน้อย 1 รายการ
3. ในเมนู “การเชื่อมต่อ API” สร้าง Key ของ Container Loading และ Tote Tracker เก็บแยกกัน Key แสดงครั้งเดียว การหมุน Key ยกเลิกตัวเดิม
4. รันจาก PowerShell:

```powershell
cd D:\Code\HDC-Data-Center
.\scripts\Start-Integration.ps1
```

สคริปต์ใช้ Store API Key จาก container เดิมถ้ามี หรือถามแบบซ่อนการพิมพ์ ตรวจว่า Key ตรงโปรเจคก่อน build/recreate Keys ไม่แสดงในคำสั่ง แต่ถูกเก็บใน environment ของ container ตามปกติของ Docker ต้องจำกัดสิทธิ์ผู้เข้าถึง Docker daemon ถ้าต้องเปลี่ยน Key ให้ใช้ `-PromptForApiKeys` หากยังไม่มี Store ชุดกลางจะเก็บ cache เดิมและเริ่มซิงก์หลังนำเข้า

ต้องมี `.env` เดิมในสองโปรเจค ไม่เปลี่ยนรหัสผ่านฐานหรือ volume สคริปต์ใช้ compose.yaml เดิมร่วมกับ integration/compose.consumer.yaml หากระบบเดิมใช้ compose override เพิ่มเติม (เช่น HTTPS หรือ storage-hdd) ให้รวมไฟล์เหล่านั้นก่อน consumer overlay ในคำสั่ง deploy ด้วย อย่ารันสคริปต์ค่าเริ่มต้นทับ deployment ที่มีไฟล์ override เพิ่มเติมโดยยังไม่ได้รวมไฟล์เหล่านั้น

หาก path ต่างจากค่าเริ่มต้น:

```powershell
.\scripts\Start-Integration.ps1 -ContainerProject D:\Code\HDC-Container-loading -ToteProject D:\Code\HDC-Tote-tracker
```

## ตรวจสอบ

- Container Loading: http://localhost:8080 หน้า Store จะมีปุ่ม “ซิงก์ตอนนี้” และแสดงเวอร์ชัน / เวลาสำเร็จล่าสุด
- Tote Tracker: http://localhost:8081 หน้า Admin แสดง Store จาก Data Center และคงการจัดการ Tote เดิม
- Data Center หน้า API แสดงเวอร์ชันและจำนวน Store ที่ปลายทางยืนยันหลัง commit สำเร็จ รีเฟรชเพื่อดูสถานะล่าสุด
- ทดลองแก้ชื่อหรือปิด Store ที่ Data Center รอไม่เกิน 60 วินาที หรือกดซิงก์ที่ปลายทาง งานใหม่จะใช้ชื่อ/สถานะล่าสุด ประวัติ Shipment และ Tote Event ไม่เปลี่ยนชื่อย้อนหลัง

## พฤติกรรมซิงก์

- ส่ง Bearer API Key จาก Backend ผ่าน network `hdc-master-data` ไม่ส่ง Key ไปเบราว์เซอร์
- อ่าน snapshot ทั้งชุด ตรวจ schema, duplicate, boolean, รหัส/ชื่อ และเวอร์ชันก่อนเขียน
- commit ลง PostgreSQL ของแต่ละโปรเจคแบบ transaction เดียว มี advisory lock ป้องกันซิงก์ชนกัน
- เพิ่ม/อัปเดตตามรหัสและรับ active จากศูนย์กลาง Store เก่าที่ไม่อยู่ในชุดกลางจะปิดใช้งาน ไม่ลบแถวและไม่ทำลาย foreign key
- ชุดกลางว่าง / version 0 / API ผิดพลาด / ไฟล์ข้อมูลผิด จะเก็บ cache เดิม ไม่ล้างข้อมูล
- ข้อมูลที่เก็บใน Shipment/Tote Event เดิมยังคงเดิม
- API แก้ไข/ลบ/นำเข้า Store เดิมที่ปลายทางถูกปฏิเสธ แม้มีผู้เรียกผ่าน HTTP โดยตรง
- มี admin endpoints `/api/admin/data-center/status` (GET) และ `/api/admin/data-center/sync` (POST) ใช้ session Administrator เดิม
- Data Center รับ acknowledgement ผ่าน POST `/api/v1/sync-status` ใช้ Key ของโปรเจคนั้น สิทธิ์เขียนจำกัดเฉพาะรายงาน sync status ไม่ให้เขียน Store

รหัส `1` และ `001` ถือเป็นคนละ Store ไม่แปลงรหัสเอง ก่อนใช้หน้างานควรตรวจรหัสในไฟล์กลางกับข้อมูลเดิม หากมีรหัสคนละรูปแบบให้แก้ข้อมูลกลางให้ตรงก่อนซิงก์

## อัปเดต / รีสตาร์ต

### บัญชี Administrator

รัน Start-Integration.ps1 ใหม่หนึ่งครั้งเพื่ออัปเดตทั้งสามระบบ แล้วเปิดเมนู “บัญชีผู้ใช้” สร้างบัญชี Administrator กลาง เลือกทั้ง Container Loading และ Tote Tracker แล้วใช้ชื่อและรหัสผ่านเดียวกันเข้าสู่แต่ละเว็บ

บัญชีเดิมที่ชื่อซ้ำกันต้องเชื่อมอย่างชัดเจน: สร้างบัญชีกลางพร้อมรหัสผ่านใหม่ จากนั้นเปิด “บัญชีเดิม / เชื่อมบัญชี” เลือกโปรเจค เลือกบัญชีเดิมและกดเชื่อม ทำแยกให้ครบสองโปรเจค ตัวอ้างอิง UUID และประวัติงานปลายทางจะยังอยู่ บัญชีชื่อใหม่จะสร้างตัวอ้างอิงอัตโนมัติเมื่อเข้าโปรเจคครั้งแรก

สคริปต์สร้าง `.secrets/container-loading.key` และ `.secrets/tote-tracker.key` อัตโนมัติ เก็บไฟล์เหล่านี้ไว้ ไม่ใช่ Store API Keys และไม่ต้องคัดลอกไปใส่หน้าเว็บ เมื่อต้อง rebuild จะใช้ไฟล์เดิม ส่วน Store Key จะอ่านจาก container เดิมถ้ามี (ใช้ `-PromptForApiKeys` เมื่อต้องเปลี่ยน)

รหัสผ่านกลางยาว 12–200 ตัว เก็บ scrypt hash ที่ Data Center ตรวจสิทธิ์แบบ online ทุกครั้งที่ใช้ Administrator Session การเปลี่ยนชื่อ รหัสผ่าน สถานะ หรือสิทธิ์โปรเจคยกเลิก Sessions กลางทั้งหมดของบัญชีนั้น มีการป้องกันถอด Administrator กลางคนสุดท้ายของแต่ละโปรเจค ประวัติงานและบัญชีพนักงานไม่ถูกเปลี่ยน

เมื่อ Data Center ติดต่อไม่ได้ บัญชีกลางจะไม่สามารถเข้าสู่ระบบหรือใช้สิทธิ์ Administrator ได้ งานพนักงานและข้อมูล Store ที่ cache ไว้ยังทำงานตามเดิม บัญชีเดิมที่ยังไม่เชื่อมยังใช้ได้เมื่อศูนย์กลางตรวจแล้วว่าไม่มีบัญชีกลางชื่อนั้น บัญชีที่เชื่อมแล้วจะไม่ย้อนกลับไปตรวจรหัสผ่านเดิม

หาก PowerShell บล็อกสคริปต์ ใช้โปรเซสสำหรับรันครั้งนี้:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Start-Integration.ps1"
```

การจัดการบัญชีผ่าน Data Center ใช้ Administrator session ของ Data Center; Management API ปลายทางใช้ Key แยกและไม่รับ Store API Key การเปลี่ยนแปลงถูกบันทึกใน Audit ของ Data Center และตาราง `hdc_account_audit` ของปลายทางโดยไม่บันทึกรหัสผ่าน

ใช้ Start-Integration.ps1 เมื่อต้อง rebuild/recreate เพื่อให้ overlay ยังมีผล `docker compose restart` ใช้กับ container เดิมได้ การรัน `docker compose up` จากสองโปรเจคโดยไม่ใส่ overlay อาจกลับไปใช้แอปเดิม

หยุด Data Center ชั่วคราวยังทำงานกับ Store ที่ซิงก์สำเร็จล่าสุดได้ เมื่อเปิดกลับมาจะซิงก์ใหม่อัตโนมัติ หากหมุน API Key ต้อง deploy ปลายทางด้วย Key ใหม่

## ทดสอบ

`npm test` ตรวจ Data Center API, acknowledgement, key rotation และ frontend patch ขณะทดสอบ Python client กับ HTTP จริงตั้ง environment HDC_TEST_PYTHON เป็น path ของ Python 3.12+

`python -m unittest discover -s integration -p test_sync.py -v` ตรวจ snapshot, transaction rollback, history และการปฏิเสธข้อมูลผิด โดยใช้ SQLite จำลอง SQL สำหรับ unit tests ยังต้องทดสอบ deployment กับ PostgreSQL จริงใน Docker host
