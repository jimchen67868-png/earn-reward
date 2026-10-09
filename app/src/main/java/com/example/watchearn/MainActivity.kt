package com.example.watchearn

import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.gms.ads.AdError
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.FullScreenContentCallback
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.MobileAds
import com.google.android.gms.ads.rewarded.RewardedAd
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback
import com.google.android.gms.ads.rewarded.ServerSideVerificationOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration

/*
 * build.gradle (app) dependencies:
 *   implementation(platform("com.google.firebase:firebase-bom:33.5.1"))
 *   implementation("com.google.firebase:firebase-auth")
 *   implementation("com.google.firebase:firebase-firestore")
 *   implementation("com.google.android.gms:play-services-ads:23.3.0")
 * Plugins: com.google.gms.google-services (plus google-services.json in app/)
 *
 * The app NEVER writes points. AdMob calls the Cloud Function (functions/index.js),
 * which verifies the reward and credits Firestore. The app only reads the balance.
 */
class MainActivity : AppCompatActivity() {

    private val testRewardedId = "ca-app-pub-3940256099942544/5224354917" // test ad unit
    private val auth = FirebaseAuth.getInstance()
    private val db = FirebaseFirestore.getInstance()

    private var uid: String? = null
    private var rewardedAd: RewardedAd? = null
    private var balanceListener: ListenerRegistration? = null

    private lateinit var pointsText: TextView
    private lateinit var watchButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        pointsText = TextView(this).apply { textSize = 28f; gravity = Gravity.CENTER; text = "Signing in..." }
        watchButton = Button(this).apply { text = "Please wait..."; isEnabled = false }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            addView(pointsText)
            addView(watchButton)
        })

        MobileAds.initialize(this) {}
        signIn()
    }

    private fun signIn() {
        val current = auth.currentUser
        if (current != null) {
            onSignedIn(current.uid)
        } else {
            auth.signInAnonymously()
                .addOnSuccessListener { onSignedIn(it.user!!.uid) }
                .addOnFailureListener { pointsText.text = "Sign-in failed" }
        }
    }

    private fun onSignedIn(userId: String) {
        uid = userId
        // Live balance from Firestore (read-only for the app)
        balanceListener = db.collection("users").document(userId)
            .addSnapshotListener { snap, _ ->
                pointsText.text = "Points: ${snap?.getLong("points") ?: 0}"
            }
        watchButton.setOnClickListener { showAd() }
        loadAd()
    }

    private fun loadAd() {
        watchButton.isEnabled = false
        watchButton.text = "Loading ad..."
        RewardedAd.load(
            this, testRewardedId, AdRequest.Builder().build(),
            object : RewardedAdLoadCallback() {
                override fun onAdLoaded(ad: RewardedAd) {
                    rewardedAd = ad
                    watchButton.text = "Watch ad to earn points"
                    watchButton.isEnabled = true
                }

                override fun onAdFailedToLoad(error: LoadAdError) {
                    rewardedAd = null
                    watchButton.text = "No ad available - tap to retry"
                    watchButton.isEnabled = true
                    watchButton.setOnClickListener { loadAd(); watchButton.setOnClickListener { showAd() } }
                }
            }
        )
    }

    private fun showAd() {
        val ad = rewardedAd ?: return loadAd()
        val userId = uid ?: return

        // Tells AdMob which user to include in the server callback
        ad.setServerSideVerificationOptions(
            ServerSideVerificationOptions.Builder().setUserId(userId).build()
        )
        ad.fullScreenContentCallback = object : FullScreenContentCallback() {
            override fun onAdDismissedFullScreenContent() { rewardedAd = null; loadAd() }
            override fun onAdFailedToShowFullScreenContent(error: AdError) { rewardedAd = null; loadAd() }
        }
        ad.show(this) {
            // Don't credit here. The server credits after verifying; balance updates live.
            Toast.makeText(this, "Verifying reward...", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroy() {
        balanceListener?.remove()
        super.onDestroy()
    }
}
