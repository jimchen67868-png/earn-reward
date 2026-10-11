package com.example.watchearn

import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.gms.ads.AdError
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.FullScreenContentCallback
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.MobileAds
import com.google.android.gms.ads.RequestConfiguration
import com.google.android.gms.ads.rewarded.RewardedAd
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback
import com.google.android.gms.ads.rewarded.ServerSideVerificationOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/*
 * The app never writes points. The server credits them after AdMob verification,
 * and deducts them when a withdrawal is requested (api/withdraw.js).
 */
class MainActivity : AppCompatActivity() {

    private val rewardedAdUnitId = "ca-app-pub-4283964646300912/9324597260"

    // Add your phone's test device ID here (logcat: "setTestDeviceIds") so your own
    // device gets test ads from your real unit. Never tap real ads on your own phone.
    private val testDeviceIds: List<String> = listOf()

    private val withdrawUrl = "https://earn-reward-537n.vercel.app/api/withdraw"
    private val minWithdrawPoints = 2000L // keep in sync with api/withdraw.js

    private val auth = FirebaseAuth.getInstance()
    private val db = FirebaseFirestore.getInstance()

    private var uid: String? = null
    private var rewardedAd: RewardedAd? = null
    private var balanceListener: ListenerRegistration? = null
    private var currentPoints = 0L

    private lateinit var pointsText: TextView
    private lateinit var watchButton: Button
    private lateinit var payoutInput: EditText
    private lateinit var withdrawButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        pointsText = TextView(this).apply { textSize = 28f; gravity = Gravity.CENTER; text = "Signing in..." }
        watchButton = Button(this).apply { text = "Please wait..."; isEnabled = false }
        payoutInput = EditText(this).apply { hint = "Litecoin (LTC) address, e.g. ltc1..." }
        withdrawButton = Button(this).apply {
            text = "Withdraw (min $minWithdrawPoints points)"
            isEnabled = false
            setOnClickListener { requestWithdraw() }
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            addView(pointsText)
            addView(watchButton)
            addView(payoutInput)
            addView(withdrawButton)
        })

        MobileAds.setRequestConfiguration(
            RequestConfiguration.Builder().setTestDeviceIds(testDeviceIds).build()
        )
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
        balanceListener = db.collection("users").document(userId)
            .addSnapshotListener { snap, _ ->
                currentPoints = snap?.getLong("points") ?: 0L
                pointsText.text = "Points: $currentPoints"
                withdrawButton.isEnabled = currentPoints >= minWithdrawPoints
            }
        watchButton.setOnClickListener { showAd() }
        loadAd()
    }

    private fun loadAd() {
        watchButton.isEnabled = false
        watchButton.text = "Loading ad..."
        RewardedAd.load(
            this, rewardedAdUnitId, AdRequest.Builder().build(),
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

        ad.setServerSideVerificationOptions(
            ServerSideVerificationOptions.Builder().setUserId(userId).build()
        )
        ad.fullScreenContentCallback = object : FullScreenContentCallback() {
            override fun onAdDismissedFullScreenContent() { rewardedAd = null; loadAd() }
            override fun onAdFailedToShowFullScreenContent(error: AdError) { rewardedAd = null; loadAd() }
        }
        ad.show(this) {
            Toast.makeText(this, "Verifying reward...", Toast.LENGTH_SHORT).show()
        }
    }

    private fun requestWithdraw() {
        val account = payoutInput.text.toString().trim()
        if (account.isEmpty()) {
            Toast.makeText(this, "Enter your payout details first", Toast.LENGTH_SHORT).show()
            return
        }
        val user = auth.currentUser ?: return
        val points = currentPoints
        withdrawButton.isEnabled = false

        user.getIdToken(false)
            .addOnSuccessListener { result ->
                thread {
                    val message = try {
                        val conn = (URL(withdrawUrl).openConnection() as HttpURLConnection).apply {
                            requestMethod = "POST"
                            doOutput = true
                            connectTimeout = 15000
                            readTimeout = 45000
                            setRequestProperty("Content-Type", "application/json")
                            setRequestProperty("Authorization", "Bearer ${result.token}")
                        }
                        val body = JSONObject()
                            .put("points", points)
                            .put("account", account)
                            .put("method", "LTC")
                            .toString()
                        conn.outputStream.use { it.write(body.toByteArray()) }

                        val code = conn.responseCode
                        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                            ?.bufferedReader()?.readText() ?: ""
                        if (code in 200..299) {
                            if (runCatching { JSONObject(text).optBoolean("paid") }.getOrDefault(false)) "Paid! Your LTC is on its way." else "Withdrawal queued. It will be sent shortly."
                        } else {
                            runCatching { JSONObject(text).optString("error") }.getOrNull()
                                ?.takeIf { it.isNotEmpty() } ?: "Failed ($code)"
                        }
                    } catch (e: Exception) {
                        "Network error, try again"
                    }
                    runOnUiThread {
                        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
                        withdrawButton.isEnabled = currentPoints >= minWithdrawPoints
                    }
                }
            }
            .addOnFailureListener {
                Toast.makeText(this, "Could not verify login", Toast.LENGTH_SHORT).show()
                withdrawButton.isEnabled = currentPoints >= minWithdrawPoints
            }
    }

    override fun onDestroy() {
        balanceListener?.remove()
        super.onDestroy()
    }
}
