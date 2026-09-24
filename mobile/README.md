# Map to GPX — iOS and Android

The site's own core and engine (`<script id="mtg-core">` and `<script id="mtg-engine">`
in `../index.html`) in a Capacitor shell, with an interface of its own in `src/`.
`scripts/build-www.mjs` copies the two scripts out verbatim on every build, so the
app and the site route, parse and write GPX with the same code.

Needs Node 22+, Xcode 26 for iOS, and the Android SDK with JDK 21 for Android.

```bash
npm install
npm run dev        # the interface in a browser tab: open /mobile/www/ on the address it prints
npm run sync       # build www/ and copy it into both native projects
npm run ios        # …and open Xcode
npm run android    # …and open Android Studio
```

`npm run dev` borrows the key in `../config.local.js` for the local routing proxy,
server-side only. The build refuses to finish if that key, or anything that looks
like an OpenRouteService key, would end up in the bundle.

## Talking to the API

A release build calls `https://map-to-gpx.com/api/*` from its own origin
(`capacitor://app.map-to-gpx.com` on iOS, `https://app.map-to-gpx.com` on Android),
which `lib/route-proxy.js` accepts by name. That change has to be deployed
before the app can route without a personal key.

To try a native build against a local server instead:

```bash
MTG_API=http://127.0.0.1:8080 npm run sync              # iOS Simulator
adb reverse tcp:8080 tcp:8080
MTG_API=http://localhost:8080 npm run sync              # Android emulator (debug builds allow http here)
```

Rebuild without `MTG_API` before shipping; the build prints a warning while it is set.

## Before the first device or store build

- **iOS**: in Xcode, set your team on both the `App` and `ShareExtension` targets.
  Both carry the App Group `group.com.maptogpx.app`, which Xcode registers on first
  signing. Bundle IDs: `com.maptogpx.app` and `com.maptogpx.app.share`. The app is
  iPhone-only and portrait.
- **Android**: application ID `com.maptogpx.app`; a release build needs your upload key.

## How the pieces fit

- **Share → Map to GPX.** Android takes the shared text through an intent filter.
  iOS uses the `ShareExtension` target: it puts the link in the App Group and opens
  `maptogpx://share`, and `@capgo/capacitor-share-target` hands it to the page either way.
- **Send** writes the .gpx to the cache and opens the system share sheet with the file.
  **↓** saves a copy to Files › On My iPhone › Map to GPX, or Documents on Android.
- **The last route** is kept in `Library/last-route.json` and opens with no connection.
- **The key**, if someone adds one, goes to the Keychain or Android Keystore.
- **Tip links** are off in native builds (`SUPPORT_IN_APP` in `src/app.js`): the stores
  treat tips to an app's developer as purchases.
