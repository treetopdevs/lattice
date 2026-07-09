package dev.treetop.lattice.township

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import dev.treetop.lattice.township.intent.TownshipIntentStore
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    TownshipIntentStore.record(intent, "activity_on_create")
    enableEdgeToEdge()
    System.loadLibrary("township_tauri_shell")
    Keyring.initializeNdkContext(applicationContext)
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    TownshipIntentStore.record(intent, "activity_on_new_intent")
    super.onNewIntent(intent)
  }
}
