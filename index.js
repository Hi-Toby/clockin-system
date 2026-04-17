// server/index.js
// ─────────────────────────────────────────────────────────────
//  MCT Clock-In — Express API Server
//  Deployed on Railway. Firebase Admin auth uses the
//  FIREBASE_SERVICE_ACCOUNT env variable (JSON string).
// ─────────────────────────────────────────────────────────────

import express from "express";
import cors from "cors";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const app = express();
app.use(cors());
app.use(express.json());

// ── Firebase Admin init ──────────────────────────────────────
// On Railway we store the service account JSON as an env var
// called FIREBASE_SERVICE_ACCOUNT (the full JSON as a string).
let db;
try {
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Railway / production: read from env variable
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Using FIREBASE_SERVICE_ACCOUNT env variable");
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Local fallback: read from file path
    const fs = await import("fs");
    serviceAccount = JSON.parse(
      fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8")
    );
    console.log("✅ Using GOOGLE_APPLICATION_CREDENTIALS file");
  } else {
    throw new Error(
      "No Firebase credentials found.\n" +
      "Set FIREBASE_SERVICE_ACCOUNT env variable on Railway.\n" +
      "Or set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path locally."
    );
  }

  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
  console.log("✅ Firebase Admin connected");

} catch (e) {
  console.error("❌ Firebase Admin init failed:", e.message);
  process.exit(1);
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

// ── Health check (no auth needed) ────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    project: "MCT Clock-In",
    timestamp: new Date().toISOString(),
    message: "Server is running and connected to Firebase"
  });
});

// ── POST /api/clockin  ← ESP32 posts here ────────────────────
app.post("/api/clockin", requireApiKey, async (req, res) => {
  const { rfid_uid, device_id = "ESP32", location = "Lab A" } = req.body;
  if (!rfid_uid) {
    return res.status(400).json({ success: false, error: "rfid_uid is required" });
  }

  const uid = rfid_uid.toUpperCase();
  const now = new Date();

  try {
    // 1. Look up student
    const studentSnap = await db.collection("students").doc(uid).get();

    if (!studentSnap.exists) {
      // Unknown card — log it
      await db.collection("clockin_logs").add({
        rfid_uid: uid,
        status: "UNKNOWN",
        device_id,
        location,
        timestamp: FieldValue.serverTimestamp(),
        date: now.toLocaleDateString("en-NG"),
        time: now.toLocaleTimeString("en-NG"),
      });
      console.log(`[UNKNOWN] Card: ${uid}`);
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
      return res.json({
        success: true,
        status: "DUPLICATE",
        message: "Already clocked in recently",
        display_message: `Hi ${student.name.split(" ")[0]}! Already in.`,
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
      display_message: `Welcome, ${student.name.split(" ")[0]}!`,
      buzzer: "success",
      student,
      logId: logRef.id,
    });

  } catch (e) {
    console.error("Clock-in error:", e);
    res.status(500).json({ success: false, error: "Server error: " + e.message });
  }
});

// ── Start server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎓 MCT Clock-In API Server`);
  console.log(`📡 Running on port ${PORT}`);
  console.log(`🔧 ESP32 endpoint: POST /api/clockin`);
  console.log(`💚 Health check:   GET  /api/health\n`);
});