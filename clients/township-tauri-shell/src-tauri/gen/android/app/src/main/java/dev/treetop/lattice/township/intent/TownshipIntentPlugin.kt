package dev.treetop.lattice.township.intent

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

object TownshipIntentStore {
  private const val LOG_TAG = "LATTICE_PROBE"
  private const val LOG_PREFIX = "township-android-intent-store"

  @Volatile
  private var currentUrl: String? = null

  fun record(intent: Intent?, source: String = "plugin") {
    Log.i(
        LOG_TAG,
        "$LOG_PREFIX phase=record source=${probeToken(source)} action=${probeToken(intent?.action)} route_shape=${routeShape(intent?.data)}")
    if (intent?.data?.scheme == "township" || isViewIntent(intent?.action)) {
      currentUrl = intent?.data?.toString()
    }
  }

  fun peek(): String? {
    Log.i(LOG_TAG, "$LOG_PREFIX phase=peek has_current=${currentUrl != null} route_shape=${routeShape(currentUrl?.let(Uri::parse))}")
    return currentUrl
  }

  private fun isViewIntent(action: String?): Boolean =
      action == Intent.ACTION_VIEW || action == "org.chromium.arc.intent.action.VIEW"

  private fun routeShape(uri: Uri?): String {
    if (uri == null) return "none"
    val scheme = probeToken(uri.scheme)
    val host = probeToken(uri.host ?: "nohost")
    val path = uri.path ?: ""
    val pathShape =
        when {
          uri.isOpaque -> "opaque"
          path.isEmpty() || path == "/" -> "empty"
          path == "/pairing" -> "pairing"
          path.startsWith("/pairing/") -> "pairing_payload"
          path == "/_pairing" -> "_pairing"
          path.startsWith("/_pairing/") || path.startsWith("/_pairing_") -> "_pairing_payload"
          else -> "other"
        }
    return "$scheme:$host:$pathShape"
  }

  private fun probeToken(value: String?): String =
      value?.trim()?.replace(Regex("[^A-Za-z0-9_.:-]+"), "_")?.trim('_')?.ifEmpty { "empty" }
          ?: "none"
}

@TauriPlugin
class TownshipIntentPlugin(private val activity: Activity) : Plugin(activity) {
  private var currentUrl: String? = null

  override fun load(webView: WebView) {
    super.load(webView)
    currentUrl = TownshipIntentStore.peek()
    updateCurrentUrl(activity.intent)
  }

  override fun onNewIntent(intent: Intent) {
    TownshipIntentStore.record(intent)
    updateCurrentUrl(intent)
  }

  @Command
  fun getCurrent(invoke: Invoke) {
    val ret = JSObject()
    ret.put("url", currentUrl)
    invoke.resolve(ret)
  }

  private fun updateCurrentUrl(intent: Intent?) {
    TownshipIntentStore.record(intent)
    currentUrl = TownshipIntentStore.peek()
  }
}
