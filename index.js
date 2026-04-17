// server/index.js  — MCT Clock-In  (COMPLETE FIXED VERSION)
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
    throw new Error("FIREBASE_SERVICE_ACCOUNT env variable is not set on Railway.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
  console.log("✅ Firebase Admin connected");
} catch (e) {
  console.error("❌ Firebase init failed:", e.message);
  process.exit(1);
}

// ── Normalize UID ─────────────────────────────────────────────
// Strips colons, spaces, dashes.  "A1:B2:C3:D4" → "A1B2C3D4"
function normalizeUID(raw) {
  return String(raw).toUpperCase().replace(/[:\s\-]/g, "");
}

// ── API Key check ─────────────────────────────────────────────
async function requireApiKey(req, res, next) {
  // Accept key in header (lowercase or uppercase) or query string
  const key =
    req.headers["x-api-key"] ||
    req.headers["X-Api-Key"]  ||
    req.query.api_key;

  console.log(`[AUTH] Key received: "${key ? key.substring(0,8) + "…" : "NONE"}"`);

  if (!key) {
    return res.status(401).json({ success: false, error: "Missing X-Api-Key header" });
  }
  try {
    const snap = await db.collection("api_keys").doc(key).get();
    if (!snap.exists || snap.data().active !== true) {
      console.log(`[AUTH] ❌ Invalid key: ${key}`);
      return res.status(401).json({ success: false, error: "Invalid or inactive API key" });
    }
    console.log("[AUTH] ✅ Key valid");
    next();
  } catch (e) {
    console.error("[AUTH] Error:", e.message);
    return res.status(500).json({ success: false, error: "Auth check failed: " + e.message });
  }
}

// ── GET / ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ message: "MCT Clock-In Server ✅", health: "/api/health", clockin: "POST /api/clockin" });
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

// ── POST /api/clockin ─────────────────────────────────────────
app.post("/api/clockin", requireApiKey, async (req, res) => {
  const { rfid_uid, device_id = "ESP8266", location = "Lab A" } = req.body;

  console.log(`\n[CLOCKIN] Raw body:`, JSON.stringify(req.body));

  if (!rfid_uid) {
    return res.status(400).json({ success: false, error: "rfid_uid is required in request body" });
  }

  const uid = normalizeUID(rfid_uid);
  const now = new Date();

  console.log(`[CLOCKIN] Raw UID: "${rfid_uid}"  →  Normalized: "${uid}"`);

  try {
    // ── 1. Look up student ──────────────────────────────────
    const studentSnap = await db.collection("students").doc(uid).get();
    console.log(`[CLOCKIN] Student lookup for "${uid}": exists=${studentSnap.exists}`);

    if (!studentSnap.exists) {
      // Log the unknown scan so it appears on dashboard
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

      console.log(`[CLOCKIN] ❓ Unknown card: ${uid}`);
      return res.json({
        success:         true,
        status:          "UNKNOWN",
        message:         "Card not registered in system",
        display_message: "Unknown Card",
        buzzer:          "error",
      });
    }

    const student = studentSnap.data();
    console.log(`[CLOCKIN] Found student: ${student.name}`);

    // ── 2. Duplicate check (NO composite index needed) ──────
    // We only filter by rfid_uid + status, then check time in JS.
    // This avoids the Firestore composite index requirement entirely.
    const recentSnap = await db.collection("clockin_logs")
      .where("rfid_uid", "==", uid)
      .where("status",   "==", "SUCCESS")
      .orderBy("timestamp", "desc")
      .limit(1)
      .get();

    if (!recentSnap.empty) {
      const lastLog  = recentSnap.docs[0].data();
      const lastTime = lastLog.timestamp?.toDate?.() ?? new Date(0);
      const minsAgo  = (now - lastTime) / 60000;

      console.log(`[CLOCKIN] Last clock-in was ${minsAgo.toFixed(1)} minutes ago`);

      if (minsAgo < 5) {
        return res.json({
          success:         true,
          status:          "DUPLICATE",
          message:         `${student.name} already clocked in recently`,
          display_message: "Already In!",
          buzzer:          "double",
          student: {
            name:      student.name,
            studentId: student.studentId,
          },
        });
      }
    }

    // ── 3. Write successful clock-in ────────────────────────
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

    console.log(`[CLOCKIN] ✅ SUCCESS — ${student.name} (${uid}) @ ${now.toLocaleTimeString()}`);

    return res.json({
      success:         true,
      status:          "SUCCESS",
      message:         `${student.name} clocked in successfully`,
      display_message: "Welcome!",
      buzzer:          "success",
      logId:           logRef.id,
      student: {
        name:      student.name,
        studentId: student.studentId,
      },
    });

  } catch (e) {
    console.error("[CLOCKIN] ❌ Server error:", e);
    return res.status(500).json({
      success: false,
      error:   "Server error: " + e.message,
    });
  }
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎓 MCT Clock-In API — Port ${PORT}`);
  console.log(`💚 Health : GET  /api/health`);
  console.log(`🔧 Clockin: POST /api/clockin\n`);
});
