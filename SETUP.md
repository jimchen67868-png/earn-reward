# Firebase setup

1. console.firebase.google.com > create project > add Android app (package com.example.watchearn).
   Download `google-services.json` into your Android `app/` folder.
2. Authentication > Sign-in method > enable **Anonymous**.
3. Firestore Database > create (production mode), then paste `firestore.rules` into the Rules tab.
4. Upgrade to the **Blaze** plan (needed for Cloud Functions to call Google's key server; free tier usage still applies).
5. Deploy the function:
   ```
   npm install -g firebase-tools
   firebase login
   firebase init functions     # choose JavaScript, use existing files
   firebase deploy --only functions
   ```
   Copy the `admobSsv` function URL it prints.
6. AdMob console > your rewarded ad unit > **Server-side verification** > enable, paste the function URL.
7. Run the app. After watching an ad, the balance should rise within a few seconds.

# Before real payouts
- Anonymous accounts vanish on uninstall. Link a Google or email login (`linkWithCredential`) so balances survive.
- Add a `withdrawals` flow (user requests, you review manually first).
- Add Play Integrity checks and watch for abnormal ad counts per user.
