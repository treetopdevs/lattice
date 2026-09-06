package io.crates.keyring

import android.content.Context

/** Bootstrap for the separate, existing carrier seed store. */
class Keyring {
    companion object {
        external fun initializeNdkContext(context: Context)
    }
}
