// Load a .env file from the project root into process.env (existing vars win).
// Accepts `KEY=value`, `KEY = value`, `export KEY=value`, quoted values and # comments.
const fs = require("node:fs");
const path = require("node:path");

function loadEnv(file = path.join(__dirname, "..", ".env")) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let [, key, value] = m;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
  }
  return true;
}

module.exports = { loadEnv };
