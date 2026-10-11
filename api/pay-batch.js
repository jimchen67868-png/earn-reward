// Daily cron: retries anything still queued (instant payouts normally handle requests right away).
// Protected by CRON_SECRET.
const { runPayout } = require("../lib/payout");

module.exports = async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("unauthorized");
  }
  const result = await runPayout();
  res.status(result.error ? 500 : 200).json(result);
};
