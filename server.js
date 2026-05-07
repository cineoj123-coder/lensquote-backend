/**
 * LensQuote — Backend API Server
 * Runs on Koyeb.com (free, no card needed)
 * Frontend lives separately on GitHub Pages
 */

const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Allow your GitHub Pages frontend to call this API
// Replace YOUR_GITHUB_USERNAME with your actual GitHub username
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || "*",           // set this in Koyeb env vars
  "http://localhost:5500",                    // VS Code Live Server
  "http://127.0.0.1:5500",
  "http://localhost:3001",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed =
    ALLOWED_ORIGINS.includes("*") ||
    ALLOWED_ORIGINS.includes(origin);

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// ─── DATABASE ─────────────────────────────────────────────────────────────────
// Koyeb ephemeral disk — data persists during session
// For permanent storage, use PlanetScale/Turso (free) — see README
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "quotations.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS quotations (
    id           TEXT PRIMARY KEY,
    client_name  TEXT NOT NULL,
    mobile       TEXT NOT NULL,
    location     TEXT NOT NULL,
    events       TEXT NOT NULL,
    services     TEXT NOT NULL,
    total_cost   REAL NOT NULL,
    created_at   TEXT NOT NULL
  );
`);

// Seed default base prices (before 100% markup)
const DEFAULTS = {
  traditional_photography: 5000,
  traditional_videography: 5000,
  candid_photography:      8000,
  cinematic_video:         10000,
  drone_shoot:             4000,
};
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (!db.prepare("SELECT key FROM settings WHERE key=?").get(k)) {
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(k, String(v));
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "photo@admin123";
const sessions   = new Map();

function requireAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Health check
app.get("/", (req, res) => res.json({ status: "ok", app: "LensQuote API" }));

// Get service prices (public — used by quotation form)
app.get("/api/prices", (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const prices = Object.fromEntries(rows.map(r => [r.key, parseFloat(r.value)]));
  res.json(prices);
});

// Save a new quotation
app.post("/api/quotation", (req, res) => {
  const { clientName, mobile, location, events, services, totalCost } = req.body;
  if (!clientName || !mobile || !location || !events || !services) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,"");
  const rand    = Math.random().toString(36).substring(2,6).toUpperCase();
  const id      = `QT-${dateStr}-${rand}`;

  db.prepare(
    `INSERT INTO quotations(id,client_name,mobile,location,events,services,total_cost,created_at)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run(id, clientName, mobile, location,
    JSON.stringify(events), JSON.stringify(services),
    totalCost, new Date().toISOString());

  res.json({ id, message: "Saved" });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, Date.now());
    return res.json({ token });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

app.post("/api/admin/logout", requireAuth, (req, res) => {
  sessions.delete(req.headers["x-admin-token"]);
  res.json({ message: "Logged out" });
});

app.get("/api/admin/prices", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  res.json(Object.fromEntries(rows.map(r => [r.key, parseFloat(r.value)])));
});

app.put("/api/admin/prices", requireAuth, (req, res) => {
  const allowed = Object.keys(DEFAULTS);
  const upsert  = db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)");
  const run     = db.transaction(data => {
    for (const [k, v] of Object.entries(data)) {
      if (allowed.includes(k)) upsert.run(k, String(parseFloat(v)));
    }
  });
  run(req.body);
  res.json({ message: "Prices updated" });
});

app.get("/api/admin/quotations", requireAuth, (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM quotations ORDER BY created_at DESC LIMIT 200"
  ).all();
  res.json(rows.map(r => ({
    ...r,
    events:   JSON.parse(r.events),
    services: JSON.parse(r.services),
  })));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ LensQuote API running on port ${PORT}`);
});
