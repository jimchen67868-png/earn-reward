// Litecoin helpers (network params + address validation).
const bitcoin = require("bitcoinjs-lib");
const { ECPairFactory } = require("ecpair");
const ecc = require("tiny-secp256k1");

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const LTC = {
  messagePrefix: "\x19Litecoin Signed Message:\n",
  bech32: "ltc",
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

function isValidLtcAddress(addr) {
  try {
    bitcoin.address.toOutputScript(String(addr), LTC);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { bitcoin, ECPair, LTC, isValidLtcAddress };
