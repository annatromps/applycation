// Notification dispatch. Deliberately minimal: a webhook (Slack/Discord/
// Zapier/anything that accepts a JSON POST all work) or console logging.
// Add new channels (email, SMS, push) by extending the switch below.

async function sendNotification(settings, payload) {
  const mode = settings.notifications && settings.notifications.mode;
  if (!mode || mode === "none") return;

  if (mode === "console") {
    console.log(`[notify] ${payload.title}\n${payload.body}`);
    return;
  }

  if (mode === "webhook") {
    const url = settings.notifications.webhookUrl;
    if (!url) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `${payload.title}\n${payload.body}`, ...payload }),
      });
    } catch (e) {
      console.error("[notify] webhook delivery failed:", e.message);
    }
  }
}

module.exports = { sendNotification };
