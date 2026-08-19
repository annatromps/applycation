const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./db");
const scheduler = require("./scheduler");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use("/api/settings", require("./routes/settings"));
app.use("/api/profile", require("./routes/profile"));
app.use("/api/criteria", require("./routes/criteria"));
app.use("/api/jobs", require("./routes/jobs"));
app.use("/api/stats", require("./routes/stats"));

app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;

(async () => {
  // Ensure the store is initialized (creates the local file, or the Postgres
  // table + row, depending on which backend is active) before serving traffic.
  await db.read();
  app.listen(PORT, () => {
    console.log(`Applycation running at http://localhost:${PORT}`);
    console.log(`Storage backend: ${process.env.DATABASE_URL ? "Postgres" : "local file (data/db.json)"}`);
    scheduler.reschedule();
  });
})().catch((e) => {
  console.error("Failed to start:", e);
  process.exit(1);
});
