// Vercel cron job: sends all queued withdrawals as ONE Litecoin transaction.
// Runs daily (see vercel.json). Protected by CRON_SECRET. Does nothing unless AUTO_PAY=true.
const admin = require("firebase-admin");
const { bitcoin, ECPair, LTC } = require("../lib/ltc");

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

async function getUtxos(address) {
  const r = await fetch(`${BC}/addrs/${address}?unspentOnly=true&includeScript=true&token=${TOKEN}`);
  if (!r.ok) throw new Error("UTXO_FETCH_FAILED");
  const j = await r.json();
  return (j.txrefs || []).filter((u) => u.confirmations >= 1 && u.script);
}

module.exports = async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("unauthorized");
  }
  if (process.env.AUTO_PAY !== "true") return res.status(200).json({ skipped: "AUTO_PAY is off" });

  let sending = []; // docs currently marked "sending"
  let broadcastStarted = false;

  try {
    const queued = await db.collection("withdrawals").where("status", "==", "queued").limit(50).get();
    if (queued.empty) return res.status(200).json({ paid: 0 });

    // Claim them so a second run can't pay the same ones
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
    if (!toPay.length) return res.status(200).json({ paid: 0 });

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
      return res.status(502).json({ error: "broadcast unknown", txid });
    }
    if (!push.ok) {
      const text = await push.text();
      console.error("Broadcast rejected:", push.status, text);
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
    res.status(200).json({ paid: outputs.length, txid });
  } catch (e) {
    console.error("pay-batch error:", e.message);
    if (!broadcastStarted) {
      // Nothing was sent: put them back in the queue for the next run
      await Promise.all(sending.map((s) => s.ref.update({ status: "queued" }))).catch(() => {});
    }
    res.status(500).json({ error: e.message });
  }
};
