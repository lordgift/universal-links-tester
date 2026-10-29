# Universal Links Tester

เว็บสำหรับตรวจไฟล์ `.well-known` ของ iOS Universal Links / Android App Links และดูว่า Apple CDN กับ Google ดึงไฟล์เวอร์ชันล่าสุดไปแล้วหรือยัง

## รัน

```bash
npm start          # http://localhost:3000
npm run dev        # restart อัตโนมัติเมื่อแก้ไฟล์
PORT=8080 npm start
```

ต้องใช้ Node 20 ขึ้นไป ไม่มี dependency

แชร์ผลตรวจได้ด้วย URL แบบ `http://localhost:3000/?domain=example.com`

## สิ่งที่ตรวจ

| | URL | ตรวจอะไร |
|---|---|---|
| iOS · ไฟล์บนเว็บ | `https://<domain>/.well-known/apple-app-site-association` | ได้ 200 โดยไม่ redirect, JSON ถูกต้อง, ไม่เกิน 128 KB, มี `applinks`, รูปแบบ App ID |
| iOS · Apple CDN | `https://app-site-association.cdn-apple.com/a/v1/<domain>` | CDN มีไฟล์หรือยัง, เนื้อหาตรงกับไฟล์บนเว็บไหม, `Apple-Failure-Reason`, อายุแคช |
| Android · ไฟล์บนเว็บ | `https://<domain>/.well-known/assetlinks.json` | ได้ 200 โดยไม่ redirect, `Content-Type: application/json`, มี statement `handle_all_urls`, รูปแบบ fingerprint |
| Android · Google | `https://digitalassetlinks.googleapis.com/v1/statements:list` | Google เห็น package / fingerprint ตรงกับไฟล์บนเว็บไหม, `errorCode`, `debugString` |

## ทำไมต้องมี server

เบราว์เซอร์ดึงไฟล์ `.well-known` จากโดเมนอื่นตรงๆ ไม่ได้เพราะติด CORS และ fetch ฝั่งเบราว์เซอร์จะ follow redirect เองโดยไม่บอกเรา `server.js` เลยเป็นตัวดึงไฟล์ทั้งหมดแทน (ตั้ง `redirect: 'manual'` ไว้ จึงจับ redirect ได้) แล้วส่งผลวิเคราะห์ให้หน้าเว็บผ่าน `GET /api/check?domain=...`
