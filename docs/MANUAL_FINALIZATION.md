# Remaining setup and test steps

The current source implementation is still being completed. Do not use an APK from an earlier pass for feature testing: it predates the current native service and safety-flow changes. The final arm64 APK will be built only after source work is complete, then installed on the Honor X5c for the agreed device checks. Do not use real emergency contacts or invoke evidence cleanup against production data during testing.

## 1. Deploy the three updated Supabase functions

The generated bundles are already prepared in `tmp/supabase-dashboard-functions/`. To regenerate them after future edits, open PowerShell in the project folder and run `node scripts/prepare-supabase-dashboard-functions.mjs`.

For each function below, open Supabase Dashboard → your `Companion` project → **Edge Functions** → select the existing function → **Code**:

| Function | Complete source to paste |
|---|---|
| `activate-emergency` | `tmp/supabase-dashboard-functions/activate-emergency.ts` |
| `report-route-deviation` | `tmp/supabase-dashboard-functions/report-route-deviation.ts` |
| `register-evidence` | `tmp/supabase-dashboard-functions/register-evidence.ts` |

For each one, save a private backup of its current code, replace the editor with the entire matching file, leave **Verify JWT** enabled, and click **Deploy updates**. Do not add any API keys to the function source. Existing secrets stay in Edge Function Secrets. Confirm the function shows the latest deployment time before moving to the next one.

## 2. Email without buying a domain

The current Resend test sender `onboarding@resend.dev` can only send to the email address that owns the Resend account. You can test the email flow without paying for a domain by adding that same account-owner address as the test journey's trusted contact. The provider dashboard will show whether Resend accepted the message; check the owner's inbox for receipt.

To send to any other trusted contact, Resend requires a verified sending domain. Skip that until you own or control a domain. Supabase Auth confirmation SMTP is separate and does not prove emergency email delivery works.

## 3. Publish the family dashboard on Cloudflare Pages

The configured app URL is `https://companion-family.pages.dev`, and the local `.env` already has that dashboard URL. To make Git-based Cloudflare Pages deployments generate their ignored runtime config:

1. In Cloudflare Dashboard, open **Workers & Pages** → **companion-family** → **Settings** → **Builds & deployments** → **Build configuration**.
2. First commit and push the local `scripts/build-dashboard.mjs` and `package.json` script change to the Git repository connected to this Pages project. Then set the root directory to the repository root (leave the field blank if Cloudflare already uses the repo root), build command to `npm run dashboard:build`, and build output directory to `dashboard`.
3. Under **Environment variables**, add these two variables for both Production and Preview, using values from the project's Supabase API settings and the local `.env` (the URL and publishable/anon key only): `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
4. Save and trigger a new deployment. The build script generates `dashboard/config.js`; that file is intentionally ignored by Git so credentials are not committed. The publishable key is designed for browser clients. Never put a service-role or Resend key in Cloudflare Pages.
5. Open `https://companion-family.pages.dev` and verify the sign-in screen appears. The dashboard uses the Pages domain as its auth email redirect; if Supabase rejects it, add `https://companion-family.pages.dev/**` under Supabase Dashboard → **Authentication** → **URL Configuration** → **Redirect URLs**.
6. In Supabase Dashboard → **Edge Functions** → **Secrets**, set `COMPANION_DASHBOARD_URL` to exactly `https://companion-family.pages.dev` (no trailing path or query string). This makes notification messages link to the hosted dashboard.

The build script can also be run locally with `npm run dashboard:build`; it reads `.env` and writes the ignored `dashboard/config.js` without printing the key.

## 4. Apply emergency-resolution SQL

In Supabase Dashboard → **SQL Editor** → **New query**, open `supabase/migrations/202611180001_emergency_resolution.sql`, paste the complete file, and click **Run**. Verify it exists with this read-only query:

```sql
select routine_schema, routine_name
from information_schema.routines
where routine_schema = 'public' and routine_name = 'resolve_emergency';
```

The expected result is one row. Do not run the SQL more than once unless it reports an error; its statements are safe to reapply, but a successful result is enough.

Also apply `supabase/migrations/202611180002_monotonic_journey_location.sql` in the same SQL Editor session. It updates the existing owner-only location RPC to ignore duplicate or older GPS timestamps and rejects fixes with accuracy over 100 meters, preventing delayed writes from moving the dashboard backward. This is a production schema change: review the SQL first and apply it only when you are ready. Verify the function was replaced by checking that the latest published location keeps the greatest timestamp during the final two-account device test.

## 5. Verify the evidence cleanup schedule

The user reports that Vault secrets are saved and job ID 1 is scheduled for 02:30 UTC. After that scheduled time, run this read-only query in SQL Editor:

```sql
select jobid, runid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = 1
order by start_time desc
limit 5;
```

Confirm the latest row has a successful status. Do not manually invoke the cleanup function: it permanently deletes expired evidence files.

## 6. Test the hosted dashboard and Supabase with disposable accounts

Use two test accounts you control and add only the Resend account-owner address as a test trusted-contact email if you want to exercise notification delivery. Do not use personal safety contacts.

1. Sign in on the app with test account A and add the test contact.
2. Start a short journey and grant account B access using B's registered email.
3. Sign in to `https://companion-family.pages.dev` as B, paste the journey ID shared by A, and confirm the map/location timestamp updates while A's journey is active.
4. With A still in the journey, test route deviation on a quiet, controlled route and inspect the recorded status. Do not test by triggering the SOS while real contacts are configured.
5. Test evidence permission, upload, signed download, expiry metadata, and delete controls using only the test journey. Provider acceptance is not proof of inbox delivery.
6. Test account deletion only on a disposable account after confirming it has no data you need.

These account-level tests require your logged-in Dashboard session and test accounts; this workspace cannot safely impersonate them or confirm production delivery.

## 7. Evaluate the audio model (requires the final APK and a consented corpus)

Do not describe YAMNet scream/shout detection as reliable until measured. An opt-in Android prediction logger is now wired to Settings → Audio Model Evaluation. While an active journey has background audio monitoring enabled, it records only the per-window predicted class, confidence, timestamp, threshold, and inference latency. It does not store microphone samples or upload the CSV. The local log is capped at 20,000 rows or 4 MB. Export shares the first 200 data rows at a time through Android's text share sheet; clear the log between batches if you need to export later rows. Keep personal recordings private; do not upload raw evidence to the app's emergency bucket for evaluation. Only use corpus audio with appropriate consent.

After collecting predictions on the Honor X5c, fill the exported CSV's blank `actual` column with `distress` or `background` labels and preserve the remaining columns. The logged prediction is a per-window threshold result; it may differ from the multi-window automatic SOS policy. The current service uses a fixed 0.975-second duration per window. Add device memory and battery measurements separately if available. Then run the existing evaluator:

```powershell
node scripts/evaluate-audio-metrics.mjs .\path\to\consented-predictions.csv
```

It reports precision, recall, false negatives and false positives per background hour, plus latency summaries. No consented labeled corpus has been supplied or evaluated yet, so no model quality result can be reported. Background custom-phrase recognition also remains unavailable; configured phrases currently use OS speech recognition while the app is foregrounded.

## 8. Install and test on the Honor X5c — last

After the final source pass, build the APK at `android/app/build/outputs/apk/debug/app-debug.apk` for the Honor X5c's `arm64-v8a` architecture. Until that final build completes, any existing APK at that path is stale and must not be used to judge current source behavior. When we reach this step, connect the Honor by USB, enable Developer options → **USB debugging**, and accept the authorization prompt; then verify ADB sees the phone, install the newly built APK, and guide the tests together.

Do not test simulated screams/falls around other people or with real contacts configured. We’ll first verify launch, permissions, journey start/stop, live GPS, and notification status; then test check-in/resolution, evidence and background behavior with the disposable accounts.
