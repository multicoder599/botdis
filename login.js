require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

if (!apiId || !apiHash) {
  console.error('Add API_ID and API_HASH to .env');
  process.exit(1);
}

(async () => {
  const stringSession = new StringSession('');
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('Phone number (+254...):'),
    password: async () => await input.text('2FA password (if any):'),
    phoneCode: async () => await input.text('Enter Telegram code:'),
    onError: (err) => console.log(err),
  });

  const session = client.session.save();
  console.log('\n=== COPY THIS TO .env SESSION_STRING ===\n');
  console.log(session);
  console.log('\n=======================================\n');

  await client.disconnect();
})();