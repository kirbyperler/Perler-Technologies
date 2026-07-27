require('./_env')();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');
const { isValidEmail, isStrongPassword } = require('../lib/validation');

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

const ENTER_CODES = [10, 13]; // \n, \r
const CTRL_C_CODE = 3;
const BACKSPACE_CODES = [8, 127]; // \b, DEL

// Reads a password without echoing it to the terminal. Falls back to a visible
// prompt if stdin isn't an interactive TTY (e.g. piped input).
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      resolve(prompt(question));
      return;
    }

    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    function cleanup() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    }

    function onData(char) {
      const code = char.charCodeAt(0);
      if (ENTER_CODES.includes(code)) {
        cleanup();
        process.stdout.write('\n');
        resolve(value);
      } else if (code === CTRL_C_CODE) {
        cleanup();
        process.stdout.write('\n');
        reject(new Error('Cancelled.'));
      } else if (BACKSPACE_CODES.includes(code)) {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    }

    stdin.on('data', onData);
  });
}

async function main() {
  const args = parseArgs();
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Add it to .env.local or your shell environment.');
    process.exit(1);
  }

  const email = (args.email || await prompt('Admin email: ')).trim().toLowerCase();
  if (!isValidEmail(email)) {
    console.error('That email address is not valid.');
    process.exit(1);
  }

  let password = args.password;
  if (!password) {
    password = await promptHidden('Admin password (12+ characters, mixed case/numbers/symbols): ');
    const confirmPassword = await promptHidden('Confirm password: ');
    if (password !== confirmPassword) {
      console.error('Passwords did not match.');
      process.exit(1);
    }
  } else {
    console.warn('Warning: passing --password on the command line can leak it via shell history. Prefer the interactive prompt.');
  }

  if (!isStrongPassword(password)) {
    console.error('Password must be 12+ characters and include at least 3 of: lowercase, uppercase, numbers, symbols.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'perler');

  try {
    const admins = db.collection('admins');
    const existing = await admins.findOne({ email });
    if (existing) {
      console.error(`An admin account already exists for ${email}.`);
      process.exit(1);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();
    await admins.insertOne({ email, passwordHash, role: 'Admin', createdAt: now, updatedAt: now });

    console.log(`Admin account created for ${email}.`);
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error('Failed to create admin account:', error.message);
  process.exit(1);
});
