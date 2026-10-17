# Android APK

The Android app loads the online game server, so deploy the Render Blueprint first.

1. Push this project to a GitHub repository.
2. In the repository, open **Settings → Secrets and variables → Actions → Variables** and add `GAME_URL` with the Render service URL, for example `https://severo-yug.onrender.com`.
3. Open **Actions → Build Android APK → Run workflow**.
4. Download the `severo-yug-debug-apk` artifact from the completed workflow and extract `app-debug.apk`.

The APK is an installable debug build for direct testing. It needs an internet connection and the Render service to be online. The app and server share the same accounts and game data.