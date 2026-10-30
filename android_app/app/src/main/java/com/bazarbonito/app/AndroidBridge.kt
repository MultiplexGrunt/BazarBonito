package com.bazarbonito.app

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.webkit.JavascriptInterface
import android.widget.Toast

class AndroidBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun getPendingSharedImage(): String? {
        val img = activity.pendingSharedImage
        activity.pendingSharedImage = null
        return img
    }

    @JavascriptInterface
    fun onAppReady() {
        activity.onWebAppReady()
    }

    @JavascriptInterface
    fun vibrate(durationMs: Long) {
        try {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vibratorManager = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vibratorManager?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(durationMs)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    @JavascriptInterface
    fun showToast(message: String) {
        activity.runOnUiThread {
            Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
        }
    }

    @JavascriptInterface
    fun openWhatsAppChat(phone: String, message: String) {
        activity.runOnUiThread {
            try {
                val encodedMsg = java.net.URLEncoder.encode(message, "UTF-8")
                val url = "https://wa.me/$phone?text=$encodedMsg"
                val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                intent.setPackage("com.whatsapp")
                try {
                    activity.startActivity(intent)
                } catch (e: Exception) {
                    val fallbackIntent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                    activity.startActivity(fallbackIntent)
                }
            } catch (e: Exception) {
                e.printStackTrace()
                Toast.makeText(activity, "No se pudo abrir WhatsApp", Toast.LENGTH_SHORT).show()
            }
        }
    }

    @JavascriptInterface
    fun isAndroidApp(): Boolean = true
}
