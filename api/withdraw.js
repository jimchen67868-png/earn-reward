// Vercel serverless function: withdrawal request (Litecoin).
// Verifies the user's Firebase login token, deducts points, and queues the payout.
// The daily /api/pay-batch job sends the LTC.
const admin = require("firebase-admin");
const { isValidLtcAddress } = require("../lib/ltc");

const MIN_POINTS = 2000;     // minimum withdrawal
const POINTS_PER_USD = 200000; // 200000 points = $1.00 (keep this well below your real ad earnings!)

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Not signed in" });

    const uid = (await admin.auth().verifyIdToken(token)).uid;

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const account = String(body.account || "").trim();
    const points = Math.floor(Number(body.points));

    if (!isValidLtcAddress(account)) return res.status(400).json({ error: "Invalid Litecoin address" });
    if (!Number.isFinite(points) || points < MIN_POINTS) {
      return res.status(400).json({ error: `Minimum is ${MIN_POINTS} points` });
    }

    const userRef = db.doc(`users/${uid}`);
    const reqRef = db.collection("withdrawals").doc();
    const activeQuery = db
      .collection("withdrawals")
      .where("uid", "==", uid)
      .where("status", "in", ["queued", "sending", "needs_review"])
      .limit(1);

    await db.runTransaction(async (t) => {
      const [userSnap, activeSnap] = await Promise.all([t.get(userRef), t.get(activeQuery)]);
      if (!activeSnap.empty) throw new Error("PENDING");
      const balance = userSnap.exists ? userSnap.data().points || 0 : 0;
      if (balance < points) throw new Error("INSUFFICIENT");

      const FV = admin.firestore.FieldValue;
      t.update(userRef, { points: FV.increment(-points) });
      t.set(reqRef, {
        uid,
        points,
        usd: Math.round((points / POINTS_PER_USD) * 1e6) / 1e6,
        method: "LTC",
        account,
        status: "queued", // pay-batch sets: sending -> paid / needs_review
        createdAt: FV.serverTimestamp(),
      });
    });

    res.status(200).json({ ok: true });
  } catch (e) {
    if (e.message === "PENDING") return res.status(400).json({ error: "You already have a withdrawal in progress" });
    if (e.message === "INSUFFICIENT") return res.status(400).json({ error: "Not enough points" });
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
};
