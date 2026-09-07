package dev.treetop.lattice.treehouse.witness

import android.app.Activity
import android.app.AlertDialog
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.widget.TextView
import java.security.Signature
import java.util.Collections
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal interface WitnessReviewUi {
    fun review(details: WitnessReviewDetails, callback: (Boolean) -> Unit): WitnessUiCancellation

    fun authenticate(
        signature: Signature,
        callback: (WitnessPresenceResult) -> Unit
    ): WitnessUiCancellation
}

internal interface WitnessUiCancellation {
    fun cancel()
}

internal class WitnessReviewDetails(
    val title: String,
    fields: List<Pair<String, String>>
) {
    val fields: List<Pair<String, String>> =
        Collections.unmodifiableList(fields.map { (label, value) -> label to value })
}

internal sealed class WitnessPresenceResult {
    data class Success(val signature: Signature) : WitnessPresenceResult()

    data class Refused(val reason: String) : WitnessPresenceResult()
}

internal class WitnessNativeReview(private val activity: Activity) : WitnessReviewUi {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor { command -> mainHandler.post(command) }

    override fun review(
        details: WitnessReviewDetails,
        callback: (Boolean) -> Unit
    ): WitnessUiCancellation {
        val terminal = AtomicBoolean(false)
        val dialog = AtomicReference<AlertDialog?>(null)

        fun finishFromUi(accepted: Boolean) {
            if (terminal.compareAndSet(false, true)) {
                dialog.getAndSet(null)?.dismiss()
                callback(accepted)
            }
        }

        mainHandler.post {
            if (terminal.get()) return@post
            if (!activityUsable()) {
                finishFromUi(false)
                return@post
            }

            try {
                val built =
                    AlertDialog.Builder(activity)
                        .setTitle(escapeForReview(details.title))
                        .setMessage(reviewMessage(details.fields))
                        .setPositiveButton(POSITIVE_LABEL) { _, _ -> finishFromUi(true) }
                        .setNegativeButton(NEGATIVE_LABEL) { _, _ -> finishFromUi(false) }
                        .setOnCancelListener { finishFromUi(false) }
                        .create()

                dialog.set(built)
                built.setOnDismissListener {
                    dialog.compareAndSet(built, null)
                    finishFromUi(false)
                }
                built.setOnShowListener {
                    built.findViewById<TextView>(android.R.id.message)?.apply {
                        ellipsize = null
                        maxLines = Int.MAX_VALUE
                    }
                }
                built.show()
            } catch (_: RuntimeException) {
                finishFromUi(false)
            }
        }

        return cancellation {
            if (terminal.compareAndSet(false, true)) {
                mainHandler.post {
                    dialog.getAndSet(null)?.dismiss()
                    callback(false)
                }
            }
        }
    }

    override fun authenticate(
        signature: Signature,
        callback: (WitnessPresenceResult) -> Unit
    ): WitnessUiCancellation {
        val terminal = AtomicBoolean(false)
        val cancellationSignal = AtomicReference<CancellationSignal?>(null)

        fun finish(result: WitnessPresenceResult) {
            if (terminal.compareAndSet(false, true)) callback(result)
        }

        mainHandler.post {
            if (terminal.get()) return@post
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !activityUsable()) {
                finish(WitnessPresenceResult.Refused("biometric_unavailable"))
                return@post
            }

            try {
                val signal = CancellationSignal()
                val cryptoObject = BiometricPrompt.CryptoObject(signature)
                cancellationSignal.set(signal)

                val authenticationCallback =
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(
                            result: BiometricPrompt.AuthenticationResult
                        ) {
                            val returned = result.cryptoObject
                            val exactOperation =
                                result.authenticationType ==
                                    BiometricPrompt.AUTHENTICATION_RESULT_TYPE_BIOMETRIC &&
                                    returned === cryptoObject &&
                                    returned.signature === signature

                            finish(
                                if (exactOperation) {
                                    WitnessPresenceResult.Success(signature)
                                } else {
                                    WitnessPresenceResult.Refused("biometric_crypto_mismatch")
                                }
                            )
                        }

                        override fun onAuthenticationError(
                            errorCode: Int,
                            errString: CharSequence
                        ) {
                            finish(WitnessPresenceResult.Refused("biometric_error_$errorCode"))
                        }
                    }

                val prompt =
                    BiometricPrompt.Builder(activity)
                        .setTitle(PRESENCE_PROMPT)
                        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                        .setNegativeButton(NEGATIVE_LABEL, mainExecutor) { _, _ ->
                            finish(WitnessPresenceResult.Refused("cancelled"))
                        }
                        .build()

                prompt.authenticate(cryptoObject, signal, mainExecutor, authenticationCallback)
            } catch (_: RuntimeException) {
                finish(WitnessPresenceResult.Refused("biometric_unavailable"))
            }
        }

        return cancellation {
            if (terminal.compareAndSet(false, true)) {
                mainHandler.post {
                    cancellationSignal.get()?.cancel()
                    callback(WitnessPresenceResult.Refused("cancelled"))
                }
            }
        }
    }

    private fun activityUsable(): Boolean = !activity.isFinishing && !activity.isDestroyed

    private fun cancellation(action: () -> Unit): WitnessUiCancellation =
        object : WitnessUiCancellation {
            private val cancelled = AtomicBoolean(false)

            override fun cancel() {
                if (cancelled.compareAndSet(false, true)) action()
            }
        }

    private fun reviewMessage(fields: List<Pair<String, String>>): String =
        buildString {
            append(REVIEW_WARNING)
            for ((label, value) in fields) {
                append("\n\n")
                append(escapeForReview(label))
                append(": ")
                append(escapeForReview(value))
            }
        }

    private fun escapeForReview(value: String): String =
        buildString(value.length) {
            var offset = 0
            while (offset < value.length) {
                val codePoint = value.codePointAt(offset)
                if (Character.isISOControl(codePoint) ||
                    Character.getType(codePoint) == Character.FORMAT.toInt()
                ) {
                    if (codePoint <= 0xffff) {
                        append("\\u")
                        append(codePoint.toString(16).uppercase().padStart(4, '0'))
                    } else {
                        append("\\U")
                        append(codePoint.toString(16).uppercase().padStart(8, '0'))
                    }
                } else {
                    appendCodePoint(codePoint)
                }
                offset += Character.charCount(codePoint)
            }
        }

    private companion object {
        const val PRESENCE_PROMPT = "Prove Treehouse witness key possession"
        const val REVIEW_WARNING =
            "Review a proposed Treehouse witness enrollment and key-possession request. " +
                "This does not establish group authority."
        const val POSITIVE_LABEL = "Continue"
        const val NEGATIVE_LABEL = "Cancel"
    }
}
