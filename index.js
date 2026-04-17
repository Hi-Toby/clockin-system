// server/index.js
// ─────────────────────────────────────────────────────────────
//  MCT Clock-In — Express API Server
//  Hosted on Railway. Firebase Admin uses FIREBASE_SERVICE_ACCOUNT env var.
// ─────────────────────────────────────────────────────────────

import express from "express";
import cors from "cors";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const app = express();
app.use(cors());
app.use(express.json());

// ── Firebase Admin init ──────────────────────────────────────
let db;
try {
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Using FIREBASE_SERVICE_ACCOUNT env variable");
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const fs = await import("fs");
    serviceAccount = JSON.parse(
      fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8")
    );
    console.log("✅ Using GOOGLE_APPLICATION_CREDENTIALS file");
  } else {
    throw new Error("No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT on Railway.");
  }

  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
  console.log("✅ Firebase Admin connected");

} catch (e) {
  console.error("❌ Firebase Admin init failed:", e.message);
  process.exit(1);
}

// ── UID normalizer ────────────────────────────────────────────
// Strips colons, spaces, dashes — handles both "A1:B2:C3:D4"
// and "A1B2C3D4" so the ESP8266 and ESP32 both work correctly.
function normalizeUID(raw) {
  return raw.toUpperCase().replace(/[:\s\-]/g, "");
}

// ── API Key middleware ────────────────────────────────────────
async function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!key) {
    return res.status(401).json({ success: false, error: "Missing X-Api-Key header" });
  }
  try {
    const snap = await db.collection("api_keys").doc(key).get();
    if (!snap.exists || snap.data().active !== true) {
      return res.status(401).json({ success: false, error: "Invalid or inactive API key" });
    }
    next();
  } catch (e) {
    return res.status(500).json({ success: false, error: "Key validation failed" });
  }
}

// ── GET / — friendly root message ────────────────────────────
app.get("/", (req, res) => {
  res.json({
    message: "MCT Clock-In Server is running ✅",
    endpoints: {
      health:  "GET  /api/health",
      clockin: "POST /api/clockin  (requires X-Api-Key header)",
    }
  });
});

// ── GET /api/health ───────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    project: "MCT Clock-In",
    timestamp: new Date().toISOString(),
    message: "Server is running and connected to Firebase"
  });
});

// ── POST /api/clockin  ← ESP8266/ESP32 posts here ────────────
app.post("/api/clockin", requireApiKey, async (req, res) => {
  const { rfid_uid, device_id = "ESP8266", location = "Lab A" } = req.body;

  if (!rfid_uid) {
    return res.status(400).json({ success: false, error: "rfid_uid is required" });
  }

  // ✅ FIX 1: normalize UID — strips colons from ESP8266 format
  const uid = normalizeUID(rfid_uid);
  const now = new Date();

  console.log(`[SCAN] Raw UID: "${rfid_uid}" → Normalized: "${uid}"`);

  try {
    // 1. Look up student by normalized UID
    const studentSnap = await db.collection("students").doc(uid).get();

    if (!studentSnap.exists) {
      await db.collection("clockin_logs").add({
        rfid_uid: uid,
        raw_uid: rfid_uid,          // also store original for debugging
        status: "UNKNOWN",
        device_id,
        location,
        timestamp: FieldValue.serverTimestamp(),
        date: now.toLocaleDateString("en-NG"),
        time: now.toLocaleTimeString("en-NG"),
      });
      console.log(`[UNKNOWN] UID: ${uid} — not in students collection`);
      return res.json({
        success: true,
        status: "UNKNOWN",
        message: "Card not registered",
        display_message: "Unknown Card",
        buzzer: "error",
      });
    }

    const student = studentSnap.data();

    // 2. Duplicate check — last 5 minutes
    const fiveMinAgo = new Date(now - 5 * 60 * 1000);
    const recentSnap = await db.collection("clockin_logs")
      .where("rfid_uid", "==", uid)
      .where("status", "==", "SUCCESS")
      .where("timestamp", ">=", fiveMinAgo)
      .limit(1)
      .get();

    if (!recentSnap.empty) {
      console.log(`[DUPLICATE] ${student.name} already clocked in recently`);
      return res.json({
        success: true,
        status: "DUPLICATE",
        message: "Already clocked in recently",
        display_message: `Already In!`,
        buzzer: "double",
        student,
      });
    }

    // 3. Write successful clock-in
    const logRef = await db.collection("clockin_logs").add({
      rfid_uid: uid,
      status: "SUCCESS",
      student: {
        name:       student.name,
        studentId:  student.studentId,
        department: student.department,
      },
      device_id,
      location,
      timestamp: FieldValue.serverTimestamp(),
      date: now.toLocaleDateString("en-NG"),
      time: now.toLocaleTimeString("en-NG"),
    });

    console.log(`[CLOCK-IN] ✅ ${student.name} (${uid}) @ ${now.toLocaleTimeString()}`);

    res.json({
      success: true,
      status: "SUCCESS",
      message: `${student.name} clocked in successfully`,
      display_message: `Welcome!`,      // kept short for 16-char LCD line 1
      student,
      logId: logRef.id,
      buzzer: "success",
    });

  } catch (e) {
    console.error("Clock-in error:", e);
    res.status(500).json({ success: false, error: "Server error: " + e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎓 MCT Clock-In API Server`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`💚 Health: GET /api/health`);
  console.log(`🔧 Clock-in: POST /api/clockin\n`);
});
