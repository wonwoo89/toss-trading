import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getLastAuthError, getTokenCacheStatus, warmUpAuth } from '../lib/auth.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env') });

const clientId = process.env.TOSS_CLIENT_ID?.trim();
const clientSecret = process.env.TOSS_CLIENT_SECRET?.trim();

console.log('env file:', path.join(rootDir, '.env'));
console.log(
  'TOSS_CLIENT_ID:',
  clientId ? `set (${clientId.length} chars, prefix: ${clientId.slice(0, 4)})` : 'MISSING'
);
console.log('TOSS_CLIENT_SECRET:', clientSecret ? `set (${clientSecret.length} chars)` : 'MISSING');
console.log('TOSS_ACCOUNT_SEQ:', process.env.TOSS_ACCOUNT_SEQ?.trim() || 'MISSING');

try {
  await warmUpAuth();
  const status = getTokenCacheStatus();
  console.log('result: OK');
  console.log('token cached:', status.cached);
  console.log('expires in ms:', status.expiresInMs);
} catch (error) {
  console.error('result: FAILED');
  console.error(error instanceof Error ? error.message : error);
  console.error('last auth error:', getLastAuthError());
  process.exit(1);
}
