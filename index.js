// server/index.js — MCT Clock-In (NO INDEX REQUIRED VERSION)
import express from "express";
import cors    from "cors";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const app = express();
app.use(cors());
app.use(express.json());

// ── Firebase Admin init ───────────────────────────────────────
let db;
try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT env variable is not set.");
  }
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(sa) });
  db = getFirestore();
  console.log("✅ Firebase connected");
} catch (e) {
  console.error("❌ Firebase init failed:", e.message);
  process.exit(1);
}

// ── Normalize UID — strips colons/spaces/dashes ───────────────
// "A1:B2:C3:D4" → "A1B2C3D4"
function normalizeUID(raw) {
  return String(raw).toUpperCase().replace(/[:\s\-]/g, "");
}

// ── API Key check ─────────────────────────────────────────────
async function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.headers["X-Api-Key"] || req.query.api_key;
  console.log(`[AUTH] Key: "${key ? key.substring(0, 10) + "…" : "MISSING"}"`);
  if (!key) return res.status(401).json({ success: false, error: "Missing X-Api-Key header" });
  try {
    const snap = await db.collection("api_keys").doc(key).get();
    if (!snap.exists || snap.data().active !== true) {
      console.log("[AUTH] ❌ Invalid key");
      return res.status(401).json({ success: false, error: "Invalid or inactive API key" });
    }
    console.log("[AUTH] ✅ Valid");
    next();
  } catch (e) {
    console.error("[AUTH] Error:", e.message);
    return res.status(500).json({ success: false, error: "Auth check failed: " + e.message });
  }
}

// ── GET / ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ message: "MCT Clock-In Server ✅", clockin: "POST /api/clockin" });
});

// ── GET /api/health ───────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "online", project: "MCT Clock-In", timestamp: new Date().toISOString() });
});

// ── POST /api/clockin ← ESP8266 hits this ────────────────────
app.post("/api/clockin", requireApiKey, async (req, res) => {
  const { rfid_uid, device_id = "ESP8266", location = "Lab A" } = req.body;

  console.log(`\n[SCAN] Body received:`, JSON.stringify(req.body));

  if (!rfid_uid) {
    return res.status(400).json({ success: false, error: "rfid_uid is required" });
  }

  const uid = normalizeUID(rfid_uid);
  const now = new Date();
  console.log(`[SCAN] UID raw="${rfid_uid}" → normalized="${uid}"`);

  try {
    // ── Step 1: look up student by UID ────────────────────────
    const studentSnap = await db.collection("students").doc(uid).get();
    console.log(`[SCAN] Student exists: ${studentSnap.exists}`);

    // ── UNKNOWN card ──────────────────────────────────────────
    if (!studentSnap.exists) {
      await db.collection("clockin_logs").add({
        rfid_uid:  uid,
        raw_uid:   rfid_uid,
        status:    "UNKNOWN",
        device_id,
        location,
        timestamp: FieldValue.serverTimestamp(),
        date:      now.toLocaleDateString("en-NG"),
        time:      now.toLocaleTimeString("en-NG"),
      });
      console.log(`[SCAN] ❓ UNKNOWN — "${uid}" not in students collection`);
      return res.json({
        success:         true,
        status:          "UNKNOWN",
        message:         "Card not registered",
        display_message: "Unknown Card",
        buzzer:          "error",
      });
    }

    const student = studentSnap.data();
    console.log(`[SCAN] Student found: ${student.name} (${student.studentId})`);

    // ── Step 2: write SUCCESS log immediately — NO duplicate ──
    // Duplicate check removed entirely to avoid composite index.
    // If you need it later, create the index in Firebase Console.
    const logRef = await db.collection("clockin_logs").add({
      rfid_uid:  uid,
      status:    "SUCCESS",
      student: {
        name:       student.name,
        studentId:  student.studentId,
        department: student.department || "Mechatronics Engineering",
      },
      device_id,
      location,
      timestamp: FieldValue.serverTimestamp(),
      date:      now.toLocaleDateString("en-NG"),
      time:      now.toLocaleTimeString("en-NG"),
    });

    console.log(`[SCAN] ✅ SUCCESS — ${student.name} logged (id: ${logRef.id})`);

    return res.json({
      success:         true,
      status:          "SUCCESS",
      message:         `${student.name} clocked in`,
      display_message: "Welcome!",
      buzzer:          "success",
      logId:           logRef.id,
      student: {
        name:      student.name,
        studentId: student.studentId,
      },
    });

  } catch (e) {
    // Log the full error so it shows in Railway logs
    console.error("[SCAN] ❌ ERROR:", e.message);
    console.error(e.stack);
    return res.status(500).json({
      success: false,
      error:   "Server error: " + e.message,
    });
  }
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎓 MCT Clock-In Server running on port ${PORT}\n`);
});
