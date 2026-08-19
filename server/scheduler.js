const cron = require("node-cron");
const db = require("./db");
const { runDiscoveryCycle } = require("./discovery");

let currentTask = null;

function cronExpressionFor(settings) {
  const hour = Number.isInteger(settings.cadenceHourLocal) ? settings.cadenceHourLocal : 7;
  switch (settings.cadence) {
    case "daily":
      return `0 ${hour} * * *`;
    case "every_2_3_days":
      return `0 ${hour} */2 * *`;
    case "weekly":
      return `0 ${hour} * * 1`; // Mondays
    case "custom":
      return settings.customCron || null;
    case "manual":
    default:
      return null;
  }
}

/** (Re)build the scheduled task from current settings. Safe to call anytime settings change. */
async function reschedule() {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }
  const { settings } = await db.read();
  const expr = cronExpressionFor(settings);
  if (!expr || !cron.validate(expr)) {
    console.log(`[scheduler] cadence="${settings.cadence}" — no automatic schedule active`);
    return;
  }
  currentTask = cron.schedule(expr, async () => {
    console.log(`[scheduler] running discovery cycle (cron "${expr}")`);
    try {
      const added = await runDiscoveryCycle();
      console.log(`[scheduler] discovery cycle complete, ${added.length} new match(es)`);
    } catch (e) {
      console.error("[scheduler] discovery cycle failed:", e);
    }
  });
  console.log(`[scheduler] cadence="${settings.cadence}" — scheduled "${expr}"`);
}

module.exports = { reschedule, cronExpressionFor };
