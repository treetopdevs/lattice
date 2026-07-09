package dev.treetop.lattice.township.intent

import android.app.Activity
import android.content.Intent
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

object TownshipIntentStore {
  @Volatile
  private var currentUrl: String? = null

  fun record(intent: Intent?) {
    if (intent?.data?.scheme == "township" || isViewIntent(intent?.action)) {
      currentUrl = intent?.data?.toString()
    }
  }

  fun peek(): String? = currentUrl

  private fun isViewIntent(action: String?): Boolean =
      action == Intent.ACTION_VIEW || action == "org.chromium.arc.intent.action.VIEW"
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
