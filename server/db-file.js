// Local file storage backend. Used automatically when no DATABASE_URL is
// set — zero setup for running/testing on your own machine. Not suitable
// for most hosted deployments with ephemeral disks; see db-postgres.js for
// the backend used when DATABASE_URL is present (picked in db.js).

const fs = require("fs");
const path = require("path");
const { defaultData } = require("./defaultData");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData(), null, 2));
  }
}

async function read() {
  ensureDb();
  const raw = fs.readFileSync(DB_FILE, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`data/db.json is corrupted: ${e.message}`);
  }
}

let writeQueue = Promise.resolve();
function write(data) {
  // Serialize writes so concurrent requests can't interleave and corrupt the file.
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve, reject) => {
        const tmp = DB_FILE + ".tmp";
        fs.writeFile(tmp, JSON.stringify(data, null, 2), (err) => {
          if (err) return reject(err);
          fs.rename(tmp, DB_FILE, (err2) => (err2 ? reject(err2) : resolve()));
        });
      })
  );
  return writeQueue;
}

async function update(fn) {
  const data = await read();
  const result = (await fn(data)) || data;
  await write(result);
  return result;
}

module.exports = { read, write, update, DB_FILE };
