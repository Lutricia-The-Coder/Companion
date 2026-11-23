import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const functionsRoot = path.join(root, 'supabase', 'functions');
const outputRoot = path.join(root, 'tmp', 'supabase-dashboard-functions');

const stripImports = (source) => source.replace(/^import\s+.*?;\s*\r?\n/gm, '');

const emailSource = stripImports(await readFile(path.join(functionsRoot, '_shared', 'emailNotifications.ts'), 'utf8'));
const emergencyRetryPolicySource = (await readFile(path.join(functionsRoot, '_shared', 'emergencyRetryPolicy.ts'), 'utf8')).trim();
const expoPushSource = (await readFile(path.join(functionsRoot, '_shared', 'expoPush.mjs'), 'utf8')).trim();
const commonSource = (await readFile(path.join(functionsRoot, '_shared', 'common.ts'), 'utf8'))
  .replace(/^import\s+.*?;\s*\r?\n/gm, '')
  .trim();

await mkdir(outputRoot, { recursive: true });

for (const name of ['activate-emergency', 'report-route-deviation', 'register-evidence', 'get-evidence-download-url', 'delete-evidence', 'cleanup-expired-evidence', 'delete-account']) {
  const entry = stripImports(await readFile(path.join(functionsRoot, name, 'index.ts'), 'utf8')).trim();
  const output = [
    `// Generated from supabase/functions/${name}/index.ts and _shared sources.`,
    '// Paste this complete file into the matching Supabase Dashboard function editor.',
    '// Do not add credentials to this source.',
    "import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';",
    emailSource.trim(),
    ...(name === 'activate-emergency' ? [emergencyRetryPolicySource] : []),
    expoPushSource,
    commonSource,
    entry,
    '',
  ].join('\n\n');
  const imports = output.match(/^import\s.+;$/gm) ?? [];
  if (imports.length !== 1 || imports.some((line) => !line.includes('https://'))) {
    throw new Error(`${name} bundle contains duplicate or unresolved imports.`);
  }
  await writeFile(path.join(outputRoot, `${name}.ts`), output, 'utf8');
}

process.stdout.write(`Prepared 7 self-contained Dashboard function files in ${outputRoot}\n`);
