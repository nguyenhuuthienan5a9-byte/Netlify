# Dead Wave 3.6 — triển khai lên Netlify (có tài khoản)

Gói này gồm: `public/index.html` (game), `netlify/functions/api.mjs` (đăng ký / đăng nhập / lưu mây / xếp hạng / mã phòng), `netlify.toml`, `package.json`.

## Cách 1 — Netlify CLI (nhanh nhất)
1. Cài Node.js, rồi: `npm i -g netlify-cli`
2. Giải nén gói, mở terminal trong thư mục: `npm install`
3. `netlify login` → `netlify link` (chọn site deadwavevn) → `netlify deploy --prod`

## Cách 2 — GitHub
Đẩy thư mục này lên một repo GitHub, trên Netlify chọn "Import from Git" cho site, Netlify tự cài và build.

(Kéo-thả thư mục vào Netlify Drop KHÔNG chạy được phần tài khoản vì cần cài thư viện cho Functions.)

## Cấu hình (tuỳ chọn, Site configuration → Environment variables)
- `AUTH_SECRET`: chuỗi bí mật bất kỳ ≥ 16 ký tự để ký phiên đăng nhập. Nếu bỏ trống, hệ thống tự tạo và lưu một khóa.
- `TURN_URLS`, `TURN_USER`, `TURN_PASS`: máy chủ TURN (ví dụ Metered / Cloudflare) để người ở mạng chặn P2P vẫn vào được phòng multiplayer. Ví dụ `TURN_URLS=turn:host:3478,turns:host:443?transport=tcp`.

Dữ liệu lưu bằng Netlify Blobs (không cần database riêng). Không có "quên mật khẩu" (không dùng email).
