# Physical-device validation log

Manual observations from the connected device. A feature is marked passed only for the behavior actually observed; this is not a production-safety certification.

## Device and build

- Test device: Samsung Galaxy A24 (`SM-A245F`), Android 16, `arm64-v8a`.
- Build: standalone ARM64 APK at `android/app/build/outputs/apk/release/app-release.apk`, installed and launched successfully. It is not device-model-specific; 32-bit-only Android devices are not covered by this APK.
- This is not the previously named Honor X5c. Results here apply to the Samsung A24 only.

## Verified observations

- [x] App installed and opened; the main activity remained in the foreground.
- [x] Existing confirmed Supabase account signed in. This verifies sign-in for that account, not a fresh registration flow.
- [x] Trusted contact was saved to the account profile; active-journey access grant succeeded after saving the safety circle.
- [x] Location coordinates changed while the user moved.
- [x] Location continued advancing while the screen was locked for about one minute. Android showed the location foreground service running.
- [x] Dashboard map/location updated while the journey was active using the same account as journey owner. This does not verify a separate family account's access policy.
- [x] Manual SOS email reached the test-only email address; the emergency was resolved and the journey returned to normal tracking.
- [x] User reports the configured personal phrase was detected during an active journey; the app returned to normal tracking. Recognition was foreground-only; confidence-path behavior was not independently measured.
- [x] A temporary phrase could be edited, disabled, and deleted. Its disabled/independent-activation controls remained off after leaving and returning to Settings; the temporary phrase was then removed.
- [x] Road route planning displayed “Road route ready.”
- [x] At permission inspection, Android granted fine/background location, microphone, and notifications. Camera and activity-recognition runtime permissions were denied at that time.
- [x] Native safety-monitor foreground service existed, and its notification stated that on-device sound and motion checks were running.
- [x] User turned background audio monitoring off and back on during an active journey; Companion issued corresponding off/on monitoring notifications. USB ADB was disconnected during the final state check, so the notification was the observed verification.

## Pending or inconclusive

- [ ] Background scream/shout classification: no alert appeared during two controlled attempts. The on-device prediction logger was enabled for the later attempt, but prediction rows were not exported or inspected. Classifier accuracy is unverified.
- [ ] Route deviation: route planned, but no off-route movement test was done because the user could not move at the time.
- [ ] Separate family account: dashboard access and realtime were tested with the owner account, not a second authorized account.
- [ ] Evidence capture/upload/download/delete/expiry: not tested. Camera permission was denied at the last inspection; evidence recording requires explicit consent.
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
