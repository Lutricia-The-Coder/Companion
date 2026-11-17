# Manual finalization and test steps

The repository work is ready for the remaining account- and device-specific steps. Do not use a real emergency contact for tests. Resend acceptance is not proof that an email reached an inbox.

## 1. Deploy the updated Supabase functions

Windows Application Control blocks the Supabase CLI in this environment, so deploy these three generated files in the Supabase Dashboard:

1. Run `node scripts/prepare-supabase-dashboard-functions.mjs` from the project folder.
2. In Supabase Dashboard, open **Edge Functions** and select `activate-emergency`.
3. Back up the current code somewhere private, replace the editor contents with the complete contents of `tmp/supabase-dashboard-functions/activate-emergency.ts`, keep JWT verification enabled, and deploy.
4. Repeat for `report-route-deviation.ts` and `register-evidence.ts` in their matching function editors.
5. Confirm all three show deployed. Do not paste any keys into the source editor; the existing function secrets belong in the Dashboard's Secrets settings.

## 2. Email delivery limitation

The Supabase Auth confirmation email verifies the Auth SMTP path only. Emergency, route, and evidence emails are sent by the Resend Edge Function integration. With `onboarding@resend.dev`, Resend only permits delivery to the account owner's email. To test delivery to a separate trusted contact, add and verify a domain in Resend, set `RESEND_FROM_EMAIL` to an allowed sender from that domain in Edge Function Secrets, and then use a disposable test contact. A domain is not required to test sign-up confirmation.

## 3. Remote family dashboard

The dashboard currently runs locally at `http://localhost:8000`; another person's phone cannot reach that address. Publish the static `dashboard/` files, including the generated `dashboard/config.js`, on a public HTTPS static host. Then:

1. Add the host origin to Supabase Auth's allowed redirect URLs.
2. Set the Edge Function secret `COMPANION_DASHBOARD_URL` to the HTTPS origin (no path/query string).
3. Set `EXPO_PUBLIC_COMPANION_DASHBOARD_URL` in the mobile build environment to that same origin and rebuild the app.
4. Create two disposable accounts, grant the second account journey access from the owner account, then sign in as the second account and verify the map updates live.

The dashboard's Supabase publishable key is intended for browser clients; never include a service-role or Resend secret in its config.

## 4. Verify evidence cleanup schedule

The user reports that Cron schedule job ID 1 is configured for daily 02:30 UTC and that both secrets are in Vault. After its next scheduled run, use the Supabase SQL Editor to inspect the result (read-only):

```sql
select jobid, runid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = 1
order by start_time desc
limit 5;
```

Do not invoke the cleanup function manually against production; it deletes expired evidence objects.

## 5. Build and test on the Honor X5c (last)

After the function and dashboard setup is ready, connect the phone with USB debugging enabled. In PowerShell from the project folder run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android.ps1 -BuildTarget physical
```

The resulting debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`. This build includes the current source; the older APK already in that path does not. Install the new APK by copying it to the phone and opening it, or with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk` if Android Platform Tools are available.

On the phone, grant the requested location, microphone, camera (only if evidence recording is enabled), and notification permissions. Test a stationary route first with a test contact, then separately test route deviation, check-in cancellation, and evidence access. For the full background test, verify process kill/restart, reboot, battery saver, permission revocation, low battery, and network loss. Do not trigger real contacts during distress-classifier experiments.

The monitor's JVM tests need to be rerun when the local Gradle cache responds. In this environment the initial wrapper attempt was blocked from downloading Gradle and a retry using the short cache remained silent; the Android service and physical device behavior are therefore not signed off.

## 6. Audio model evaluation

This step is **not ready to run yet**: the current Android service only exposes an event when a score crosses its check-in threshold; it does not export every model window. The evaluator below cannot produce meaningful recall or false-positive-per-hour results from event-only records. A consented evaluation mode that exports per-window scores without storing audio is still required. Do not manually invent the `predicted` values or interpret the current app's alert count as classifier accuracy.

Once that evaluation mode is added, use only recordings made with informed consent. Include varied background conditions and actual scream/shout samples, and label each evaluated window as `distress` or `background`. Save predictions and measurements in a CSV with columns:

```csv
actual,predicted,duration_seconds,latency_ms,memory_mb,battery_delta_percent
```

Then run `node scripts/evaluate-audio-metrics.mjs path\\to\\predictions.csv`. Report corpus conditions and duration alongside the output. Do not use synthetic or web audio alone to claim real-world safety accuracy.
