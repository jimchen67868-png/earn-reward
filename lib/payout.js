// Sends all queued withdrawals as ONE Litecoin transaction.
// Called right after a withdrawal request (instant) and by the daily cron (retry sweeper).
const admin = require("firebase-admin");
const { bitcoin, ECPair, LTC } = require("./ltc");

const FEE_RATE = Number(process.env.FEE_RATE || 10);                    // litoshi per vbyte
const MAX_USD_PER_PAYOUT = Number(process.env.MAX_USD_PER_PAYOUT || 20); // bigger ones need manual review
const MAX_USD_PER_BATCH = Number(process.env.MAX_USD_PER_BATCH || 100);  // extra ones wait for next run
const BC = "https://api.blockcypher.com/v1/ltc/main";
const TOKEN = process.env.BLOCKCYPHER_TOKEN;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Price from two sources; refuse to pay if they disagree by more than 5%.
async function getLtcUsd() {
  const [a, b] = await Promise.all([
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd").then((r) => r.json()),
    fetch("https://api.coinbase.com/v2/prices/LTC-USD/spot").then((r) => r.json()),
  ]);
  const p1 = Number(a?.litecoin?.usd);
  const p2 = Number(b?.data?.amount);
  if (!(p1 > 0) || !(p2 > 0)) throw new Error("PRICE_UNAVAILABLE");
  if (Math.abs(p1 - p2) / Math.min(p1, p2) > 0.05) throw new Error("PRICE_MISMATCH");
  return (p1 + p2) / 2;
}

// Includes our own unconfirmed change so back-to-back instant payouts work.
async function getUtxos(address) {
  const r = await fetch(`${BC}/addrs/${address}?unspentOnly=true&includeScript=true&token=${TOKEN}`);
  if (!r.ok) throw new Error("UTXO_FETCH_FAILED");
  const j = await r.json();
  return [...(j.txrefs || []), ...(j.unconfirmed_txrefs || [])].filter((u) => u.script && !u.spent);
}

// Only one payout run at a time (prevents two runs spending the same coins)
async function acquireLock() {
  const lockRef = db.doc("locks/payout");
  for (let i = 0; i < 4; i++) {
    const got = await db.runTransaction(async (t) => {
      const s = await t.get(lockRef);
      const until = s.exists ? s.data().until || 0 : 0;
      if (until > Date.now()) return false;
      t.set(lockRef, { until: Date.now() + 60000 });
      return true;
    });
    if (got) return lockRef;
    await sleep(5000);
  }
  return null;
}

async function runPayout() {
  if (process.env.AUTO_PAY !== "true") return { skipped: "AUTO_PAY is off" };

  const lockRef = await acquireLock();
  if (!lockRef) return { skipped: "busy" };

  let sending = []; // docs currently marked "sending"
  let broadcastStarted = false;

  try {
    const queued = await db.collection("withdrawals").where("status", "==", "queued").limit(50).get();
    if (queued.empty) return { paid: 0 };

    // Claim them so another run can't pay the same ones
    const claimed = await db.runTransaction(async (t) => {
      const fresh = await Promise.all(queued.docs.map((d) => t.get(d.ref)));
      const ok = fresh.filter((s) => s.exists && s.data().status === "queued");
      ok.forEach((s) => t.update(s.ref, { status: "sending" }));
      return ok;
    });

    const toPay = [];
    const deferred = [];
    let totalUsd = 0;
    for (const s of claimed) {
      const d = s.data();
      if (!(d.usd > 0) || d.usd > MAX_USD_PER_PAYOUT) {
        await s.ref.update({ status: "needs_review", note: "over per-payout cap" });
      } else if (totalUsd + d.usd > MAX_USD_PER_BATCH) {
        deferred.push(s);
      } else {
        totalUsd += d.usd;
        toPay.push(s);
      }
    }
    await Promise.all(deferred.map((s) => s.ref.update({ status: "queued" })));
    sending = toPay;
    if (!toPay.length) return { paid: 0 };

    const price = await getLtcUsd();
    const key = ECPair.fromWIF(process.env.LTC_WIF, LTC);
    const hotAddr = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.publicKey), network: LTC }).address;
    const utxos = await getUtxos(hotAddr);

    const outputs = toPay.map((s) => ({
      s,
      address: s.data().account,
      value: Math.round((s.data().usd / price) * 1e8),
    }));
    const total = outputs.reduce((sum, o) => sum + o.value, 0);

    // Pick inputs (largest first) until they cover payouts + fee
    const selected = [];
    let inSum = 0;
    let fee = 0;
    for (const u of utxos.sort((x, y) => y.value - x.value)) {
      selected.push(u);
      inSum += u.value;
      fee = Math.ceil((11 + 68 * selected.length + 43 * (outputs.length + 1)) * FEE_RATE);
      if (inSum >= total + fee) break;
    }
    if (inSum < total + fee) throw new Error("HOT_WALLET_TOO_LOW");
    const change = inSum - total - fee;

    const psbt = new bitcoin.Psbt({ network: LTC });
    for (const u of selected) {
      psbt.addInput({
        hash: u.tx_hash,
        index: u.tx_output_n,
        witnessUtxo: { script: Buffer.from(u.script, "hex"), value: u.value },
      });
    }
    outputs.forEach((o) => psbt.addOutput({ address: o.address, value: o.value }));
    if (change >= 1000) psbt.addOutput({ address: hotAddr, value: change });
    psbt.signAllInputs(key);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    const txid = tx.getId();

    broadcastStarted = true;
    let push;
    try {
      push = await fetch(`${BC}/txs/push?token=${TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tx: tx.toHex() }),
      });
    } catch (e) {
      // Unknown whether it was sent. Do NOT retry automatically.
      await Promise.all(sending.map((s) => s.ref.update({ status: "needs_review", note: "broadcast result unknown", txid })));
      sending = [];
      return { error: "broadcast unknown", txid };
    }
    if (!push.ok) {
      console.error("Broadcast rejected:", push.status, await push.text());
      broadcastStarted = false; // clearly rejected, safe to retry later
      throw new Error("BROADCAST_REJECTED");
    }

    const FV = admin.firestore.FieldValue;
    await Promise.all(
      outputs.map((o) =>
        o.s.ref.update({
          status: "paid",
          txid,
          ltc: o.value / 1e8,
          ltcUsdPrice: price,
          paidAt: FV.serverTimestamp(),
        })
      )
    );
    sending = [];
    return { paid: outputs.length, txid };
  } catch (e) {
    console.error("payout error:", e.message);
    if (!broadcastStarted) {
      // Nothing was sent: put them back in the queue for the next run
      await Promise.all(sending.map((s) => s.ref.update({ status: "queued" }))).catch(() => {});
    }
    return { error: e.message };
  } finally {
    await lockRef.set({ until: 0 }).catch(() => {});
  }
}

module.exports = { runPayout };
