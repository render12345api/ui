# ⚡ BurstSMS Dashboard

## File Structure
```
burstsms/
├── server.js          ← Backend (Node.js + Express)
├── package.json       ← Dependencies
└── frontend/
    └── index.html     ← Frontend (served by backend)
```

## Setup & Run

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
node server.js
# or for auto-reload during dev:
npx nodemon server.js
```

### 3. Open in browser
```
http://localhost:3000
```

---

## Deploy to Railway / Render / VPS

1. Push this folder to GitHub
2. Deploy on Railway.app or Render.com (free tier works)
3. In `frontend/index.html`, change this line:
   ```js
   const API = 'http://localhost:3000';
   ```
   to your deployed URL:
   ```js
   const API = 'https://your-app.railway.app';
   ```

---

## Plans & Credits

| Plan     | Price | Credits | Validity |
|----------|-------|---------|----------|
| Free     | ₹0    | 2,000   | No expiry|
| Starter  | ₹9    | 8,000   | 30 days  |
| Pro      | ₹25   | 26,000  | 30 days  |
| Advanced | ₹49   | 55,000  | 30 days  |

---

## Payment Integration (TODO)
In `server.js` at the `/api/buy-plan` route, replace the comment
`// In production: verify payment here` with your Razorpay/UPI verification logic.

Razorpay example:
```js
const razorpay = new Razorpay({ key_id: 'YOUR_KEY', key_secret: 'YOUR_SECRET' });
// verify signature before adding credits
```
