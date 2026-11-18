import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

function readLocalEnv(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

const local = await readFile(envPath, 'utf8').then(readLocalEnv).catch(() => ({}));
const url = process.env.EXPO_PUBLIC_SUPABASE_URL || local.EXPO_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || local.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !publishableKey) {
  throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in the build environment or local .env.');
}
if (/service_role|sb_secret_/i.test(publishableKey)) {
  throw new Error('Dashboard builds accept only a Supabase publishable/anon key, never a secret key.');
}
const parsedUrl = new URL(url);
if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost') {
  throw new Error('The Supabase URL must use HTTPS except for local development.');
}

const config = { url: parsedUrl.origin, publishableKey };
await writeFile(path.join(root, 'dashboard', 'config.js'), `window.COMPANION_SUPABASE_CONFIG = ${JSON.stringify(config)};\n`, 'utf8');
process.stdout.write('Generated dashboard/config.js for the static dashboard. The publishable key is intended for browser use; no secret keys are accepted.\n');
