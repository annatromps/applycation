const cron = require("node-cron");
const db = require("./db");
const { runDiscoveryCycle } = require("./discovery");

let currentTask = null;

function cronExpressionFor(settings) {
  const hour = Number.isInteger(settings.cadenceHourLocal) ? settings.cadenceHourLocal : 7;
  const minute = Number.isInteger(settings.cadenceMinuteLocal) ? settings.cadenceMinuteLocal : 0;
  switch (settings.cadence) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "every_2_3_days":
      return `${minute} ${hour} */2 * *`;
    case "weekly":
      return `${minute} ${hour} * * 1`; // Mondays
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
      const result = await runDiscoveryCycle();
      console.log(`[scheduler] discovery cycle complete, ${result.jobs.length} new match(es)`, result.diagnostics);
    } catch (e) {
      console.error("[scheduler] discovery cycle failed:", e);
    }
  });
  console.log(`[scheduler] cadence="${settings.cadence}" — scheduled "${expr}"`);
}

module.exports = { reschedule, cronExpressionFor };
