const fs = require('fs');
const path = require('path');

// Minimal .env loader so setup scripts can read MONGODB_URI etc. without adding a
// dotenv dependency. Existing process.env values always win.
function loadEnvFile(filename) {
  const fullPath = path.join(__dirname, '..', filename);
  if (!fs.existsSync(fullPath)) return;

  const content = fs.readFileSync(fullPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

module.exports = function loadEnv() {
  loadEnvFile('.env.local');
  loadEnvFile('.env');
};
