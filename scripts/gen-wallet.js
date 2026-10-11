// Run once: node scripts/gen-wallet.js
// Makes a NEW Litecoin hot wallet for payouts. Keep the private key secret.
const { bitcoin, ECPair, LTC } = require("../lib/ltc");

const kp = ECPair.makeRandom({ network: LTC });
const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(kp.publicKey), network: LTC });

console.log("Deposit address (send a little LTC here):", address);
console.log("Private key WIF (SECRET, only for Vercel env LTC_WIF):", kp.toWIF());
