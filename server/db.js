// Picks the storage backend based on environment: Postgres when DATABASE_URL
// is set (the norm for a hosted deployment — see README's "Deploying" section
// for how to get a free connection string), local JSON file otherwise (zero
// setup for running on your own machine). Both backends expose the same
// async { read, write, update } interface, so nothing else in the app needs
// to know or care which one is active.
const { defaultData } = require("./defaultData");

const backend = process.env.DATABASE_URL ? require("./db-postgres") : require("./db-file");

module.exports = { ...backend, defaultData };
