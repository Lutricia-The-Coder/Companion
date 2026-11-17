# Smart Companion Safety App

An in-progress React Native safety prototype built with Expo SDK 58, React Native 0.88, TypeScript, and Expo Router. The backend is being migrated to Supabase Free. It is not a validated emergency service; do not rely on it as the only way to get help.

## Run the app

```powershell
npm install
npx expo start
```

Create a free project at [Supabase](https://supabase.com/dashboard), then copy its Project URL and publishable key into the ignored local `.env` file (never put a `service_role` key in the app):

```dotenv
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
EXPO_PUBLIC_COMPANION_DASHBOARD_URL=
```

Restart Metro after changing `.env`. Until these values are set, sign-in and cloud-backed features stay unavailable. The free plan is appropriate for development and evaluation, but free projects can pause after a period of inactivity; it cannot guarantee emergency-service availability. Email provider quotas are separate from Supabase.

## Initialize Supabase

The SQL migrations create profile, journey, sharing, emergency event, email preference/attempt, and evidence data; access policies; server-side safety RPCs; the private evidence bucket; and realtime publication entries.

```powershell
npx supabase@latest login
npx supabase@latest link --project-ref YOUR_PROJECT_REF
npx supabase@latest db push --remote
```

Deploy the server functions after linking:

```powershell
npx supabase@latest functions deploy activate-emergency
npx supabase@latest functions deploy report-route-deviation
npx supabase@latest functions deploy register-evidence
npx supabase@latest functions deploy get-evidence-download-url
npx supabase@latest functions deploy delete-evidence
npx supabase@latest functions deploy cleanup-expired-evidence
npx supabase@latest functions deploy delete-account
```

If Windows Application Control blocks the Supabase CLI, prepare self-contained Dashboard editor versions of the three locally updated shared-code functions:

```powershell
node scripts/prepare-supabase-dashboard-functions.mjs
```

Generated files appear in `tmp/supabase-dashboard-functions/`. In **Supabase Dashboard → Edge Functions**, back up the existing `activate-emergency`, `report-route-deviation`, and `register-evidence` functions, paste the matching generated file into each single-file editor, and deploy the update. Keep JWT verification enabled. These bundles contain source code only, never provider credentials.

Apply every migration with `db push --remote` before deploying functions. Email attempts are recorded in `notification_attempts` with a masked email address and provider reference.

For mobile email confirmation, set the Supabase Auth **Additional Redirect URLs** to include `companion-safety://auth/callback`. For local web testing, allow `http://localhost:8081/**`, `http://localhost:8082/**`, and `http://localhost:8000/**`; add the final web origin when hosting the dashboard. The app now returns confirmation links to its callback route, exchanges the code for a session, and syncs the locally saved trusted contact after confirmation. Changing the app scheme requires a fresh native build.

To configure the local family dashboard from `.env`, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-dashboard.ps1
```

This creates ignored `dashboard/config.js` using only the project URL and publishable key.

Start the dashboard on this computer only with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-dashboard.ps1
```

Then open `http://localhost:8000`. The server binds to `127.0.0.1`; to let a trusted contact connect from another device, deploy the dashboard to a host and add that HTTPS origin to Supabase Auth's allowed redirects. Do not set `EXPO_PUBLIC_COMPANION_DASHBOARD_URL` to localhost for external contacts.

Expired evidence is scheduled through Supabase Cron. In the Companion project, `pg_cron`, `pg_net`, and Vault were enabled, the two cleanup credentials were saved in Vault, and the schedule was created (job ID 1) for daily at 02:30 UTC. It removes up to 100 expired files per run through the Storage API and removes metadata only after storage deletion succeeds. The first scheduled run and its outcome have not been verified. Keep the service-role key out of source files and chat.

Safety notifications are email-only. The app sends emergency, route-deviation, and evidence-link emails through Resend; it does not attempt SMS or remote push. A verified Resend sender domain is required to email arbitrary trusted contacts. The `onboarding@resend.dev` test sender is restricted to the email address registered with that Resend account. It is suitable for testing only. Do not describe contact alerting as operational until real recipients can be reached and provider acceptance is verified; provider acceptance still does not guarantee delivery.

For a new project, create a Resend API key and add it to Supabase Edge Function secrets (never the app `.env` or dashboard config):

```powershell
npx supabase@latest secrets set RESEND_API_KEY=... RESEND_FROM_EMAIL=... COMPANION_DASHBOARD_URL=...
```

Supabase Auth custom SMTP was configured with Resend, and the user reports receiving a confirmation email. This confirms that signup-email test only; it does not verify emergency-alert delivery to trusted contacts. The Resend API key and `onboarding@resend.dev` sender were added under **Supabase Dashboard → Edge Functions → Secrets**. `COMPANION_DASHBOARD_URL` is intentionally unset until the dashboard has a public HTTPS host.

The dashboard at `dashboard/` also needs `dashboard/config.js` copied from `dashboard/config.example.js` and filled with the project URL and publishable key. It subscribes only to journeys explicitly shared with the signed-in contact. Never expose a Supabase secret/service-role key in the mobile app or browser dashboard.

The app uses Supabase Auth, Postgres with row-level security, Realtime, private Storage, and Edge Functions. Email provider acceptance is not proof of delivery, and alerts do not contact emergency services. See [implementation status](docs/IMPLEMENTATION_STATUS.md) for implemented behavior, validation, and limitations.

The app uses distinct on-device speech recognition and YAMNet sound classification paths. Personalized phrases use the OS speech recognition service while the app is foregrounded; Android background monitoring currently runs YAMNet audio/motion checks and does not transcribe arbitrary configured phrases. Android prevents a general promise of background camera use; video capture is attempted in the foreground after an opted-in alert. On-device custom phrase recognition needs a tested offline streaming keyword/speech engine before it can be claimed to work with screen-off operation.

For a labeled, consented audio evaluation, create one CSV row per recorded window with `actual,predicted,duration_seconds,latency_ms,memory_mb,battery_delta_percent`. Use `distress` or `background` for the first two columns; runtime columns are optional. Run `node scripts/evaluate-audio-metrics.mjs path\\to\\predictions.csv` to calculate precision, recall, false negatives, false positives per background hour, and available runtime summaries. Record environmental conditions separately; this script does not collect audio or validate the classifier by itself.
