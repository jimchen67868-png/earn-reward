# Setup (free plan, no Firebase Functions)

## Firebase (Spark plan is fine)
1. Authentication > Sign-in method > enable **Anonymous**.
2. Firestore Database > create, then paste `firestore.rules` in the Rules tab.
3. Project settings (gear) > Service accounts > **Generate new private key**.
   Keep that JSON secret. Never commit it or share it.

## Vercel (free Hobby plan)
1. vercel.com > sign in with GitHub > Add New > Project > import `earn-reward`.
2. Framework Preset: **Other**. Leave build settings empty.
3. Environment Variables: name `FIREBASE_SERVICE_ACCOUNT`, value = the entire service account JSON.
4. Deploy. Your endpoint is `https://<project>.vercel.app/api/admob-ssv`.

## AdMob
Ad unit > Server-side verification > enable > paste the endpoint URL.

## Withdrawals
- The app calls `api/withdraw` (Vercel). Rate and minimum are set at the top of `api/withdraw.js`
  (and `minWithdrawPoints` in MainActivity.kt). Currently 2000 points = $0.01 (200000 = $1), minimum 100000 points ($0.50).
- Requests appear in Firestore > `withdrawals` with status `pending`.
- Pay the user manually, then edit the document and set `status` to `paid`.
  To reject, set `status` to `rejected` and add the points back to `users/<uid>.points` by hand.
- Republish `firestore.rules` in the Firebase console after updating.
