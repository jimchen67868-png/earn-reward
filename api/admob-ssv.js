// Vercel serverless function: AdMob server-side verification (SSV) callback.
// Verifies Google's signature, then credits points in Firestore once per transaction.
const admin = require("firebase-admin");
const crypto = require("crypto");

const POINTS_PER_AD = 10;
const DAILY_AD_CAP = 30; // max rewarded ads per user per day

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

let keyCache = { keys: null, at: 0 };

async function getKeys() {
  if (keyCache.keys && Date.now() - keyCache.at < 24 * 3600 * 1000) return keyCache.keys;
  const res = await fetch("https://www.gstatic.com/admob/reward/verifier-keys.json");
  const json = await res.json();
  const keys = {};
  for (const k of json.keys) keys[String(k.keyId)] = k.pem;
  keyCache = { keys, at: Date.now() };
  return keys;
}

module.exports = async (req, res) => {
  try {
    console.log("SSV", req.url);
    if (req.query && req.query.key_id === "1234567890") return res.status(200).send("test ok");
    // The signed message is the raw query string up to "&signature="
    const qs = (req.url || "").split("?")[1] || "";
    const idx = qs.indexOf("&signature=");
    if (idx < 0) return res.status(400).send("missing signature");

    const message = qs.substring(0, idx);
    const { signature, key_id, user_id, transaction_id } = req.query;
    if (!signature || !key_id || !transaction_id) {
      return res.status(400).send("missing params");
    }

    const pem = (await getKeys())[String(key_id)];
    if (!pem) return res.status(400).send("unknown key");

    const sig = Buffer.from(String(signature).replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const valid = crypto.verify("sha256", Buffer.from(message), pem, sig);
    if (!valid) return res.status(403).send("bad signature");

    if (!user_id) return res.status(200).send("ok, no user_id");
    const today = new Date().toISOString().slice(0, 10);
    const userRef = db.doc(`users/${user_id}`);
    const txRef = db.doc(`rewards/${transaction_id}`);
    const dayRef = db.doc(`users/${user_id}/daily/${today}`);

    await db.runTransaction(async (t) => {
      const [tx, day] = await Promise.all([t.get(txRef), t.get(dayRef)]);
      if (tx.exists) return; // already credited (AdMob retries)
      const count = day.exists ? day.data().count : 0;
      if (count >= DAILY_AD_CAP) return; // over daily cap

      const FV = admin.firestore.FieldValue;
      t.set(txRef, { uid: user_id, at: FV.serverTimestamp() });
      t.set(dayRef, { count: count + 1 });
      t.set(userRef, { points: FV.increment(POINTS_PER_AD) }, { merge: true });
    });

    res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    res.status(500).send("error");
  }
};
