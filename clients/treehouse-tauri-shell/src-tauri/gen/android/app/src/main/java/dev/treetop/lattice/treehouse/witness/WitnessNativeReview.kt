package dev.treetop.lattice.treehouse.witness

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import android.app.Activity
import android.app.AlertDialog
import android.app.Application
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.widget.TextView
import java.security.Signature
import java.util.Collections
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Cleanup acknowledgement means owned local resources were handled on the main thread.
 * It is not evidence that platform callbacks drained or that system UI visibly disappeared.
 * Every invocation must acknowledge exactly once after successful cleanup, even on refusal.
 * A thrown cleanup failure must not acknowledge success. cancel() only requests cancellation.
 */
internal interface WitnessReviewUi {
    fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation

    fun authenticate(
        signature: Signature,
        onLocalCleanup: () -> Unit,
        callback: (WitnessPresenceResult) -> Unit
    ): WitnessUiCancellation
}

internal interface WitnessUiCancellation {
    fun cancel()
}

internal class WitnessReviewDetails private constructor(
    val title: String,
    fields: List<Pair<String, String>>
) {
    val fields: List<Pair<String, String>> = Collections.unmodifiableList(fields.toList())

    companion object {
        fun prepareCreation(
            replica: String,
            enrollmentId: ByteArray,
            recipient: ByteArray
        ): WitnessReviewDetails =
            enrollment(
                title = "Prepare Treehouse witness enrollment",
                purpose = "Prepare witness enrollment",
                replica = replica,
                enrollmentId = enrollmentId,
                recipient = recipient
            )

        fun generate(
            replica: String,
            enrollmentId: ByteArray,
            recipient: ByteArray,
            creationAttemptId: ByteArray,
            generationChallenge: ByteArray
        ): WitnessReviewDetails =
            enrollment(
                title = "Generate Treehouse witness identity",
                purpose = "Generate witness identity",
                replica = replica,
                enrollmentId = enrollmentId,
                recipient = recipient,
                extra = listOf(
                    "Creation attempt ID" to hex(witness32(creationAttemptId)),
                    "Generation challenge" to hex(witness32(generationChallenge))
                )
            )

        fun proveBinding(
            replica: String,
            enrollmentId: ByteArray,
            recipient: ByteArray,
            witnessPublicKey: ByteArray,
            creationAttemptId: ByteArray,
            generationChallengeDigest: ByteArray,
            validatorNonce: ByteArray,
            nativeNonce: ByteArray,
            nativeSessionDigest: ByteArray
        ): WitnessReviewDetails =
            enrollment(
                title = "Prove Treehouse witness key possession",
                purpose = "Prove witness key possession",
                replica = replica,
                enrollmentId = enrollmentId,
                recipient = recipient,
                extra = listOf(
                    "Witness public key" to hex(witness32(witnessPublicKey)),
                    "Creation attempt ID" to hex(witness32(creationAttemptId)),
                    "Generation challenge digest" to hex(witness32(generationChallengeDigest)),
                    "Validator nonce" to hex(witness32(validatorNonce)),
                    "Native nonce" to hex(witness32(nativeNonce)),
                    "Native session digest" to hex(witness32(nativeSessionDigest))
                )
            )

        private fun enrollment(
            title: String,
            purpose: String,
            replica: String,
            enrollmentId: ByteArray,
            recipient: ByteArray,
            extra: List<Pair<String, String>> = emptyList()
        ): WitnessReviewDetails {
            witnessUtf8(replica, 512)
            return WitnessReviewDetails(
                title,
                listOf(
                    "Product" to "treehouse",
                    "Purpose" to purpose,
                    "Replica" to replica,
                    "Enrollment ID" to hex(witness32(enrollmentId)),
                    "Recipient" to hex(witness32(recipient))
                ) + extra
            )
        }

        private fun hex(value: WitnessBytes): String =
            value.copyBytes().joinToString("") { "%02X".format(it.toInt() and 0xff) }
    }
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
        onLocalCleanup: () -> Unit,
        callback: (Boolean) -> Unit
    ): WitnessUiCancellation {
        val terminal = AtomicBoolean(false)
        val cleanupDelivered = AtomicBoolean(false)
        val dialog = AtomicReference<AlertDialog?>(null)
        val lifecycle = AtomicReference<Application.ActivityLifecycleCallbacks?>(null)
        lateinit var timeout: Runnable

        fun cleanup() {
            mainHandler.removeCallbacks(timeout)
            lifecycle.getAndSet(null)?.let(activity.application::unregisterActivityLifecycleCallbacks)
        }

        fun finishFromUi(accepted: Boolean) {
            if (terminal.compareAndSet(false, true)) {
                cleanup()
                dialog.getAndSet(null)?.dismiss()
                if (cleanupDelivered.compareAndSet(false, true)) onLocalCleanup()
                callback(accepted)
            }
        }

        timeout = Runnable { finishFromUi(false) }

        mainHandler.post {
            if (terminal.get()) return@post
            if (!activityUsable()) {
                finishFromUi(false)
                return@post
            }

            try {
                val callbacks = lifecycleCallbacks { finishFromUi(false) }
                lifecycle.set(callbacks)
                activity.application.registerActivityLifecycleCallbacks(callbacks)
                mainHandler.postDelayed(timeout, REVIEW_TIMEOUT_MILLIS)
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
                    cleanup()
                    dialog.getAndSet(null)?.dismiss()
                    if (cleanupDelivered.compareAndSet(false, true)) onLocalCleanup()
                    callback(false)
                }
            }
        }
    }

    override fun authenticate(
        signature: Signature,
        onLocalCleanup: () -> Unit,
        callback: (WitnessPresenceResult) -> Unit
    ): WitnessUiCancellation {
        val terminal = AtomicBoolean(false)
        val cleanupDelivered = AtomicBoolean(false)
        val cancellationSignal = AtomicReference<CancellationSignal?>(null)
        val lifecycle = AtomicReference<Application.ActivityLifecycleCallbacks?>(null)
        lateinit var timeout: Runnable

        fun cleanup() {
            mainHandler.removeCallbacks(timeout)
            lifecycle.getAndSet(null)?.let(activity.application::unregisterActivityLifecycleCallbacks)
        }

        fun finish(result: WitnessPresenceResult, cancelPlatform: Boolean = false) {
            if (terminal.compareAndSet(false, true)) {
                cleanup()
                val signal = cancellationSignal.getAndSet(null)
                if (cancelPlatform || result !is WitnessPresenceResult.Success) signal?.cancel()
                if (cleanupDelivered.compareAndSet(false, true)) onLocalCleanup()
                callback(result)
            }
        }

        timeout = Runnable {
            finish(WitnessPresenceResult.Refused("biometric_timeout"), cancelPlatform = true)
        }

        mainHandler.post {
            if (terminal.get()) return@post
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !activityUsable()) {
                finish(WitnessPresenceResult.Refused("biometric_unavailable"))
                return@post
            }

            try {
                val callbacks = lifecycleCallbacks {
                    finish(WitnessPresenceResult.Refused("cancelled"), cancelPlatform = true)
                }
                lifecycle.set(callbacks)
                activity.application.registerActivityLifecycleCallbacks(callbacks)
                val signal = CancellationSignal()
                val cryptoObject = BiometricPrompt.CryptoObject(signature)
                cancellationSignal.set(signal)
                mainHandler.postDelayed(timeout, PRESENCE_TIMEOUT_MILLIS)

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
                            finish(WitnessPresenceResult.Refused("biometric_error"))
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
                    cleanup()
                    cancellationSignal.getAndSet(null)?.cancel()
                    if (cleanupDelivered.compareAndSet(false, true)) onLocalCleanup()
                    callback(WitnessPresenceResult.Refused("cancelled"))
                }
            }
        }
    }

    private fun activityUsable(): Boolean = !activity.isFinishing && !activity.isDestroyed &&
        (activity as? LifecycleOwner)?.lifecycle?.currentState == Lifecycle.State.RESUMED

    private fun lifecycleCallbacks(onInvalidated: () -> Unit): Application.ActivityLifecycleCallbacks =
        object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(changed: Activity) {
                if (changed === activity) onInvalidated()
            }
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit

            override fun onActivityStopped(changed: Activity) {
                if (changed === activity) onInvalidated()
            }

            override fun onActivityDestroyed(changed: Activity) {
                if (changed === activity) onInvalidated()
            }
        }

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
        const val REVIEW_TIMEOUT_MILLIS = 120_000L
        const val PRESENCE_TIMEOUT_MILLIS = 60_000L
    }
}
