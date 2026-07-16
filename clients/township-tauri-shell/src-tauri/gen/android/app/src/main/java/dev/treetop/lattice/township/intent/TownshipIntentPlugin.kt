package dev.treetop.lattice.township.intent

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
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
  private const val TAURI_ANDROID_PAIRING_HANDOFF_PREFIX = "township-pairing_3Av1_3A"
  private const val MAX_PAIRING_INTENT_URL_LENGTH = 8192

  @Volatile
  private var currentUrl: String? = null

  fun record(intent: Intent?, source: String = "plugin") {
    Log.i(
        LOG_TAG,
        "$LOG_PREFIX phase=record source=${probeToken(source)} action=${probeToken(intent?.action)} route_shape=${routeShape(intent?.data)}")
    val rawUrl = intent?.data?.toString()
    currentUrl =
        rawUrl?.takeIf {
          isViewIntent(intent.action) &&
              hasBrowsableCategory(intent) &&
              intent.data?.scheme == "township" &&
              it.isNotBlank() &&
              it.length <= MAX_PAIRING_INTENT_URL_LENGTH
        }
  }

  fun peek(): String? {
    Log.i(LOG_TAG, "$LOG_PREFIX phase=peek has_current=${currentUrl != null} route_shape=${routeShape(currentUrl?.let(Uri::parse))}")
    return currentUrl
  }

  fun consumePairingHandoff(): String? {
    val rawUrl = peek()
    val handoff = pairingHandoff(rawUrl)
    if (handoff != null) currentUrl = null
    Log.i(
        LOG_TAG,
        "$LOG_PREFIX phase=handoff has_handoff=${handoff != null} route_shape=${routeShape(rawUrl?.let(Uri::parse))}")
    return handoff
  }

  private fun isViewIntent(action: String?): Boolean =
      action == Intent.ACTION_VIEW || action == "org.chromium.arc.intent.action.VIEW"

  private fun hasBrowsableCategory(intent: Intent): Boolean =
      intent.categories?.contains(Intent.CATEGORY_BROWSABLE) == true

  private fun pairingHandoff(value: String?): String? {
    val uri =
        try {
          value?.let(Uri::parse)
        } catch (_: Exception) {
          null
        } ?: return null
    if (uri.scheme != "township") return null

    val path = Uri.decode(uri.path ?: "").trimStart('/')
    if (!isPairingRoute(uri, path)) return null

    val queryHandoff = present(uri.getQueryParameter("handoff"))
    if (queryHandoff != null) return queryHandoff

    val payload =
        when {
          uri.host == "pairing" -> path
          uri.host == "nohost" -> routePayload(path, "_pairing")
          uri.host.isNullOrEmpty() && (path == "pairing" || path.startsWith("pairing/")) ->
              routePayload(path, "pairing")
          uri.host.isNullOrEmpty() && (path == "nohost:_pairing" || path.startsWith("nohost:_pairing")) ->
              routePayload(path, "nohost:_pairing")
          else -> null
        }
    return present(payload)?.let(::normalizeTauriAndroidRouteHandoff)
  }

  private fun isPairingRoute(uri: Uri, path: String): Boolean =
      when {
        uri.port != -1 -> false
        uri.host == "pairing" -> true
        uri.host == "nohost" ->
            path == "_pairing" || path.startsWith("_pairing/") || path.startsWith("_pairing_")
        uri.host.isNullOrEmpty() ->
            path == "pairing" ||
                path.startsWith("pairing/") ||
                path == "nohost:_pairing" ||
                path.startsWith("nohost:_pairing/") ||
                path.startsWith("nohost:_pairing_")
        else -> false
      }

  private fun routePayload(path: String, prefix: String): String? =
      when {
        path == prefix -> null
        path.startsWith("$prefix/") -> path.removePrefix("$prefix/")
        path.startsWith("${prefix}_") -> path.removePrefix("${prefix}_")
        else -> null
      }

  private fun normalizeTauriAndroidRouteHandoff(value: String): String =
      if (value.startsWith(TAURI_ANDROID_PAIRING_HANDOFF_PREFIX)) {
        "township-pairing:v1:${value.removePrefix(TAURI_ANDROID_PAIRING_HANDOFF_PREFIX)}"
      } else {
        value
      }

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

  private fun present(value: String?): String? =
      value?.trim()?.takeIf { it.isNotEmpty() }
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
    val handoff = TownshipIntentStore.consumePairingHandoff()
    ret.put(
        "handoffB64",
        handoff?.let {
          Base64.encodeToString(it.toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        })
    invoke.resolve(ret)
  }

  private fun updateCurrentUrl(intent: Intent?) {
    TownshipIntentStore.record(intent)
    currentUrl = TownshipIntentStore.peek()
  }
}
