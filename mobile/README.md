# OPD Scan QC — mobile app

Native Android / iOS app (Expo + React Native, TypeScript) for the same backend as the web app.
It talks only to the API — no backend changes are needed.

## Screens

- **Sign in** — username or email; optional fingerprint / Face ID unlock (Account tab)
- **Records** — patient records with search, "entered on" date filter and endless scroll
- **Upload** — the intake form plus PDF / image files, with returning-patient prefill and progress
- **Review** — files with pages waiting for a decision → pages → accept / rescan
- **Rescan** — pages sent for rescan, grouped by file, with "upload new scan"
- **Patient record** and **page viewer** (pinch to zoom, double-tap to zoom)

## Run on a phone (no Android Studio needed)

1. Install **Expo Go** on the phone (Play Store / App Store).
2. `cd mobile && npm install && npx expo start`
3. Scan the QR code with Expo Go (Android) or the Camera app (iPhone).

The app uses `https://ipdscan.subharti.org/api` by default. To point it elsewhere:

```
EXPO_PUBLIC_API_BASE=https://your-server/api npx expo start
```

## Build installable apps

Uses Expo's cloud build (EAS) — no Mac needed for iOS.

```
npm install -g eas-cli
eas login
eas build:configure
eas build --platform android --profile preview   # APK to install directly
eas build --platform ios                         # needs an Apple Developer account
```

App identifiers: `org.subharti.opdscanqc` (Android package and iOS bundle id).
