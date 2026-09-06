package dev.treetop.lattice.treehouse

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    System.loadLibrary("treehouse_tauri_shell")
    Keyring.initializeNdkContext(applicationContext)
    super.onCreate(savedInstanceState)
  }
}
