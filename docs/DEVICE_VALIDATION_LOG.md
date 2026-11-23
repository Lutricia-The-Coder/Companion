# Physical-device validation log

Manual observations from the connected device. A feature is marked passed only for the behavior actually observed; this is not a production-safety certification.

## Device and build

- Test device: Samsung Galaxy A24 (`SM-A245F`), Android 16, `arm64-v8a`.
- Build: standalone ARM64 APK at `android/app/build/outputs/apk/release/app-release.apk`, rebuilt with R8 minification disabled after the minified release crashed in AndroidX WorkManager startup. The non-minified APK was installed and launched; the user confirmed the app returned to the normal monitoring journey. It is not device-model-specific; 32-bit-only Android devices are not covered by this APK.
- This is not the previously named Honor X5c. Results here apply to the Samsung A24 only.

## Verified observations

- [x] App installed and opened; the main activity remained in the foreground.
- [x] Latest standalone release APK opened on the phone and restored the active normal-monitoring journey after installation.
- [x] Existing confirmed Supabase account signed in. This verifies sign-in for that account, not a fresh registration flow.
- [x] Trusted contact was saved to the account profile; active-journey access grant succeeded after saving the safety circle.
- [x] Location coordinates changed while the user moved.
- [x] Location continued advancing while the screen was locked for about one minute. Android showed the location foreground service running.
- [x] Dashboard map/location updated while the journey was active using the same account as journey owner. This does not verify a separate family account's access policy.
- [x] Manual SOS email reached the test-only email address; the emergency was resolved and the journey returned to normal tracking.
- [x] User reports the configured personal phrase was detected during an active journey; the app returned to normal tracking. Recognition was foreground-only; confidence-path behavior was not independently measured.
- [x] On 2026-11-21 the user reconfirmed the configured phrase matched and triggered the alarm on the Samsung phone.
- [x] A temporary phrase could be edited, disabled, and deleted. Its disabled/independent-activation controls remained off after leaving and returning to Settings; the temporary phrase was then removed.
- [x] Road route planning displayed “Road route ready.”
- [x] At permission inspection, Android granted fine/background location, microphone, and notifications. Camera and activity-recognition runtime permissions were denied at that time.
- [x] Native safety-monitor foreground service existed, and its notification stated that on-device sound and motion checks were running.
- [x] User turned background audio monitoring off and back on during an active journey; Companion issued corresponding off/on monitoring notifications. USB ADB was disconnected during the final state check, so the notification was the observed verification.

## Pending or inconclusive

- [ ] Background scream/shout classification: no alert appeared during two controlled attempts. The on-device prediction logger was enabled for the later attempt, but prediction rows were not exported or inspected. Classifier accuracy is unverified.
- [ ] Route deviation: route planned, but no off-route movement test was done because the user could not move at the time.
- [ ] Separate family account: dashboard access and realtime were tested with the owner account, not a second authorized account.
- [x] Retried the 20-second local audio recording on the current physical build. The first attempt exposed a React Native Blob API failure; after switching to `File.arrayBuffer()`, the app reported “1 evidence file uploaded privately” and the local outbox changed to “Uploaded privately.” After refreshing history, the event displayed “Audio evidence · 20s · expires 2026/12/20” with Open evidence and Delete controls.
- [x] Current triggered event shows both 20-second video and audio evidence in History with expiration dates. Opened the video through the owner’s signed evidence link; Chrome played it and visible video frames advanced. This verifies upload, signed download, and video playback for this event.
- [x] The first signed audio link showed 0:00 and would not play. Root cause was Expo SDK 58 `RecordingPresets.LOW_QUALITY` recording 3GP/AMR-NB on Android while uploads were labeled `audio/mp4`. Changed emergency capture to `RecordingPresets.HIGH_QUALITY` (MPEG-4/AAC), ran lint and typecheck successfully, rebuilt and installed the standalone ARM64 release APK, and relaunched the app. User confirmed the fresh post-fix audio evidence “works perfectly.” The old uploaded recording remains in its original format.
- [x] Local regression suites after the fix: 21 safety/route/fall/location/retry tests, 8 emergency/provider tests, 7 Supabase email tests, and 2 audio-evaluation-policy tests passed. These validate code paths and policy logic, not live provider delivery, classifier accuracy, or physical sensor behavior.
- [x] With Battery Saver already enabled, locked the screen for 30 seconds. Android’s location-provider elapsed timestamp advanced and both Companion monitor and location services remained listed afterward. This verifies a fresh provider fix and service presence through a short screen-off interval; it does not verify backend/dashboard freshness during lock or recovery after process death/reboot.
- [ ] Verify unauthorized access, remote deletion, and expiry protections using safe test data or a second authorized account. Older events display `no_recipients`; the evidence notification outcome itself is not displayed, so contact delivery remains unverified. Earlier local recording playback was user-confirmed.
- [ ] Fall detection: not tested. No deliberate fall/impact was simulated.
- [ ] Fresh registration/onboarding preference persistence, phrase CRUD/independent-setting matrix, auth redirect, and notification preference persistence: not fully exercised on a disposable account.
- [ ] Background service lifecycle under process kill/reboot, permission revocation, battery saver, low battery, and network loss: not tested.
- [ ] Model precision/recall, false positives/hour, false negatives, device latency/memory/battery, and environmental limits: not evaluated against a consented labeled corpus.
- [ ] Email provider outcomes beyond receipt of the manual SOS email, route-alert email, retries, and duplicate suppression: not verified end-to-end.

## Safe next tests

1. When convenient and safe to move, test route deviation and immediately answer any safety check-in.
2. In a private setting, export and inspect the audio prediction CSV before deciding whether the sound model recognized the test shout. Do not lower classifier thresholds solely to force a test alert.
3. With explicit evidence consent and camera permission, test evidence capture using only the test contact and test journey.
4. Use a second disposable, confirmed account to verify family-view authorization and realtime access.
5. Schedule the remaining device lifecycle and labeled-audio evaluation separately; do not represent unmeasured distress detection as reliable.

## Passive audio pipeline update and installation (2026-11-21)

- [x] Source now captures mono 16 kHz audio in memory, converts PCM16 to normalized YAMNet float input, and analyzes 0.975-second windows every 0.48 seconds.
- [x] Source now scores scream/shout/yell plus crying, infant cry, whimper, and wail/moan classes. A vocalization by itself can prompt a safety check-in but does not independently auto-activate SOS; an independent high-confidence fall/audio combination can escalate.
- [x] Added unit coverage for overlapping windows, PCM normalization, unsupported model output shape, and vocalization escalation policy. TypeScript, Expo lint, and 22 JavaScript safety tests passed.
- [x] Android unit tests passed for the native module, including compilation, overlap/window behavior, PCM normalization, output shape validation, and scoring policy (`:expo-companion-monitor:testDebugUnitTest`).
- [x] Built the current release APK for `arm64-v8a` at `android/app/build/outputs/apk/release/app-release.apk` (60,405,151 bytes; 2026-11-21 21:59 South Africa time), installed it with `adb install -r` on the Samsung Galaxy A24 (`SM-A245F`), verified ARM64 native libraries, and launched the Companion process.
- [ ] Verify the background sound-monitor notification and detection/check-in behavior on the Samsung after this installation.

## Evaluation export diagnosis and refresh (2026-11-21)

- [x] Reviewed the user's evaluation email. It contains exactly 200 rows, all from 2026-11-19 18:20–18:23 local time, not the latest scream test. Maximum recorded scream score in those stale rows was 0.414063, below the 0.58 check-in threshold and 0.82 high-confidence threshold. This does not measure or explain the user's newer scream attempt.
- [x] Fixed the app exporter to share the newest 200 prediction rows instead of the first 200; added two tests for latest-row selection and empty logs. TypeScript, Expo lint, and the audio-evaluation test suite passed.
- [x] Rebuilt and replace-installed the ARM64 APK on the Samsung at 2026-11-21 22:50 South Africa time (60,405,647 bytes); launched the app. Existing app data, including prediction log, was preserved by replace install.
- [x] Reviewed the follow-up export from 2026-11-21 22:59. It contains 200 rows timestamped 2026-11-20 00:11–00:14 local time, so it still has no row corresponding to the latest scream test. Its maximum scream score is 0.003906 and no row crosses the 0.58 check-in or 0.82 high threshold. This cannot establish whether that latest scream was captured; the separate opt-in prediction-logging switch may have been off or there may be a device-clock mismatch.
- [x] Reviewed the next export: same 200 prediction rows/timestamps and same scores as the prior email. Read-only ADB check on the connected Samsung showed phone time 2026-11-21 23:16 SAST, the Companion native foreground monitor service active with microphone foreground-service type, and `RECORD_AUDIO` app-op running. This rules out the phone clock mismatch and confirms current capture-service activity, but does not reveal whether the optional evaluation logger was enabled during the test or had reached its 20,000-row cap.
- [x] Third export also contains those same 200 rows with last timestamp 2026-11-20 00:14; there is still no current test window in the evaluation log.
- [x] Added live evaluation diagnostics to Android monitor status and Settings: logger on/off, stored row count, latest recorded timestamp, current background-microphone state, and whether the 20,000-row/4 MB cap was reached. TypeScript, lint, 22 core tests, 4 audio-evaluation tests, and Android module unit tests passed.
- [x] Rebuilt and replace-installed the diagnostic arm64 release APK on the Samsung at 2026-11-21 23:33 SAST (60,406,767 bytes) and launched the app. Existing local log data remains available.
- [x] User inspected diagnostic status and reports evaluation logging is ON with 20,000 rows; the last prediction timestamp is 2026-11-20. This confirms the logger reached its cap and stopped recording before the latest scream attempt. No classifier conclusion can be drawn from that unrecorded attempt.
- [ ] User must export any needed metadata, then clear the local prediction log (Settings → Audio Model Evaluation → Delete local prediction log) to reset the cap. Keep the evaluation switch ON, put the active journey in the background, repeat one controlled test, and export immediately so the latest 200 rows include it.
- [ ] Confirm **Log prediction metadata during active journeys** is enabled separately from background sound monitoring; start/continue a journey, put Companion in the background, repeat the controlled test, and export the latest rows. Confirm the timestamps align with the test time before drawing conclusions.
- [ ] YAMNet accuracy, false positives/negatives, model latency under sustained use, and battery impact remain unmeasured. Use the consented evaluation flow; do not use the app as a sole safety mechanism.

## Security pass release installation (2026-11-22)

- [x] Rebuilt the current source as a generic `arm64-v8a` release APK at `android/app/build/outputs/apk/release/app-release.apk` (60,741,019 bytes; package `com.anonymous.companionsafety`, min SDK 24 / target SDK 36).
- [x] Installed with `adb install -r` on the connected Samsung Galaxy A24 (`SM-A245F`, Android 16). ADB reported `Success`; Android package metadata reports `lastUpdateTime=2026-11-22 08:31:56`.
- [x] Started the app and confirmed `com.anonymous.companionsafety/.MainActivity` is the resumed activity and the app process is running. A recent logcat scan found no fatal exception or script-load error. This is a launch smoke check, not a re-test of the app's user flows.
- [ ] Re-test the current binary's SecureStore session migration/sign-in, journey and family sharing, audio and phrase detection, location cadence, route deviation, evidence upload/download, and lifecycle handling on this phone.
- [ ] Remote push notifications remain unimplemented. SDK 58 `expo-notifications` install was blocked by disabled workspace networking; the APK contains no remote push token registration or delivery. Paid SMS was intentionally left out per the user's instruction. Existing email notifications remain configured separately.
- [ ] User reports applying the security hardening migration and deploying the updated Edge Functions; remote authorization/rate-limit/evidence behavior still needs safe verification using disposable accounts.
