# Running Trina on Android from a Mac

Trina is one React Native codebase for **Android and iOS**; Android is the primary target (ADR-003).
A Mac builds Android apps fine. On Apple Silicon (M1/M2/M3) the emulator runs native **arm64** images, so it's fast.

There are three ways to get the app onto Android:

| Way | Needs | Best for |
|---|---|---|
| **A. Emulator on your Mac** | Android Studio | Daily development, fake GPS routes |
| **B. Your own Android phone over USB** | Android Studio + a USB cable | Real GPS, camera, steps, outdoor tests |
| **C. An APK file to share** | Android Studio (local build) **or** a free Expo account (cloud build) | Giving the app to friends and testers |

---

## 1. One-time setup (about 30 minutes, ~10 GB disk)

1. **Install Android Studio:** download it from <https://developer.android.com/studio> (pick *Mac with Apple chip*), open the `.dmg`, drag it to Applications, and launch it. Accept the defaults in the setup wizard.
2. **Install the SDK pieces:** in Android Studio go to *Settings → Languages & Frameworks → Android SDK*.
   - **SDK Platforms** tab: tick **Android 16 (API 36)**.
   - **SDK Tools** tab: tick **Android SDK Build-Tools 36**, **NDK (Side by side)**, **Android SDK Command-line Tools**, **Android Emulator**, **Android SDK Platform-Tools**.
   - Click *Apply*.
3. **Point your terminal at the SDK and at Android Studio's Java.** Your Mac has Java 24, which is too new for Gradle; Android Studio ships a compatible JDK. Add this to `~/.zshrc`, then open a new terminal:

   ```bash
   export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
   ```

   Check it: `java -version` (should say 21 or 17) and `adb --version`.
4. **Use Node 22 or newer (24 recommended).** Expo and the Android build run Node from your `PATH`, and an older default (for example `/usr/local/bin/node` v16) makes the build fail with *"Node.js is outdated"*. The repo has an `.nvmrc`:

   ```bash
   nvm install 24 && nvm alias default 24     # then open a new terminal
   node -v                                    # v24.x
   ```

## 2. A. Run on the emulator

1. **Create a virtual phone:** Android Studio → *More Actions → Virtual Device Manager → Create device* → **Pixel 8** → system image **API 36, arm64-v8a, Google APIs** → Finish. With 8 GB of RAM on your Mac, set the device's RAM to 2048 MB under *Show advanced settings*.
2. **Start it:** press ▶ in the Device Manager (or `pnpm --filter @trina/mobile android:emulator`).
3. **Start the server** in one terminal:

   ```bash
   pnpm dev:server
   ```

4. **Build and install the app** in a second terminal (the first build takes 5–15 minutes, later ones about a minute):

   ```bash
   pnpm android
   ```

   The emulator reaches your Mac at `10.0.2.2`, which is already the app's default server address.
5. **Sign in** with `arjun@trina.dev` / `touch-grass-2026`.

### Fake a walk (GPS) on the emulator

The seeded Green Sprint 60 is at **Rabindra Sarobar, Kolkata (22.5115, 88.3500)**.

- Click **⋯ (Extended controls) → Location**.
- **Single point:** type the latitude/longitude and press *Set location* (put yourself in the start zone for pre-flight).
- **A route:** open the *Routes* tab, drop points for the 4 checkpoints, choose walking speed and press *Play route*. Or load a `.gpx` file there.
- Use **airplane mode** (pull down the quick settings) to test offline play, then turn it off and watch "Syncing…" → "Everything is synced."

Other useful controls: *Camera → Virtual scene* for evidence photos; `adb emu geo fix 88.35 22.5115` sets the location from the terminal (longitude first).

## 3. B. Run on your own Android phone

1. On the phone: *Settings → About phone →* tap **Build number** 7 times, then *Developer options →* turn on **USB debugging**.
2. Plug it into the Mac, accept the "Allow USB debugging?" prompt, and check `adb devices` lists it.
3. Let the phone reach the server on your Mac through the cable:

   ```bash
   pnpm --filter @trina/mobile android:reverse        # forwards ports 3000 (API) and 8081 (Metro)
   EXPO_PUBLIC_API_URL=http://localhost:3000 pnpm android
   ```

   Without the cable, use your Mac's Wi-Fi address instead (`ipconfig getifaddr en0`), for example `EXPO_PUBLIC_API_URL=http://192.168.1.20:3000`. Phone and Mac must be on the same Wi-Fi.
4. Go outside and play. For battery-heavy Android brands (Xiaomi, Oppo, Vivo, Samsung), set Trina's battery usage to **Unrestricted**, or the OS may stop GPS when the screen is off.

## 4. C. Make an APK to share

**Locally (needs the setup above):**

```bash
EXPO_PUBLIC_API_URL=https://your-server.example pnpm android:apk
# → apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

Send that file to testers; they enable *Install unknown apps* for their browser or file manager and open it. This test build is signed with a debug key, which is fine for testing but not for the Play Store.

**In the cloud (no Android Studio needed):**

```bash
npm install -g eas-cli
eas login                                 # free Expo account
cd apps/mobile
# set EXPO_PUBLIC_API_URL in eas.json → build.preview.env first
pnpm build:apk:cloud                      # gives you a download link + QR code for the APK
```

> The phone needs a server it can reach. `localhost` on your Mac only works for the emulator (`10.0.2.2`) or a USB-connected phone (`adb reverse`). For testers, run the server somewhere public (see `infra/docker-compose.yml`) or use a tunnel such as `cloudflared tunnel --url http://localhost:3000`.

## 5. iOS on the same Mac (optional)

Install **Xcode** from the App Store, then `sudo xcode-select -s /Applications/Xcode.app` and `pnpm --filter @trina/mobile ios`. The iOS Simulator fakes GPS under *Features → Location*. A real iPhone needs your Apple ID in Xcode (free, re-sign every 7 days). iOS is less tested than Android.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Unsupported class file major version` / Gradle won't start | `JAVA_HOME` isn't Android Studio's JDK (step 1.3) |
| `Node.js (v16…) is outdated` | Step 1.4: `nvm install 24 && nvm alias default 24`, new terminal |
| `SDK location not found` | `ANDROID_HOME` missing; open a new terminal after editing `~/.zshrc` |
| `NDK not configured` | Install *NDK (Side by side)* in SDK Tools |
| App opens but says it can't reach the server | Emulator: server running on port 3000? Phone: `adb reverse` or the LAN IP in `EXPO_PUBLIC_API_URL` |
| Red screen "Unable to load script" | Metro isn't running: `pnpm --filter @trina/mobile start`, then reopen the app |
| Emulator very slow | Close other apps; use an arm64 image; lower the AVD RAM to 2 GB |
| GPS stops with the screen off on a real phone | Battery usage → Unrestricted; keep the notification visible |
