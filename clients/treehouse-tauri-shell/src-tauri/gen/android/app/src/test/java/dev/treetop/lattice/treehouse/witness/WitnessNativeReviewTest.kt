package dev.treetop.lattice.treehouse.witness

import androidx.activity.ComponentActivity
import android.app.Activity
import android.app.AlertDialog
import android.Manifest
import android.content.Context
import android.content.DialogInterface
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.widget.TextView
import java.security.Signature
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.android.controller.ActivityController
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.annotation.Resetter
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.util.ReflectionHelpers
import org.robolectric.util.ReflectionHelpers.ClassParameter

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [33],
    shadows = [WitnessBiometricBuilderShadow::class, WitnessBiometricPromptShadow::class]
)
class WitnessNativeReviewTest {
    private lateinit var activity: Activity
    private lateinit var controller: ActivityController<ComponentActivity>

    @Before
    fun setUp() {
        controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        activity = controller.get()
        activity.setTheme(android.R.style.Theme_Material_Light)
    }

    @After
    fun tearDown() {
        if (!activity.isDestroyed) controller.pause().stop().destroy()
        WitnessBiometricBuilderShadow.reset()
        WitnessBiometricPromptShadow.reset()
    }

    @Test
    fun promptCancellationAcknowledgesOnlyAfterSignalCancelAndSuppressesLateCallbacks() {
        var cleaned = 0
        val outcomes = mutableListOf<WitnessPresenceResult>()
        val cancellation = WitnessNativeReview(activity).authenticate(Signature.getInstance("Ed25519"), { cleaned++ }, outcomes::add)
        idleMain()
        val signal = WitnessBiometricPromptShadow.cancellationSignal!!
        cancellation.cancel()
        assertEquals(0, cleaned); assertFalse(signal.isCanceled)
        idleMain()
        assertTrue(signal.isCanceled); assertEquals(1, cleaned)
        WitnessBiometricPromptShadow.succeedExact(); WitnessBiometricPromptShadow.failLate(); idleMain()
        assertEquals(1, cleaned); assertEquals(listOf(WitnessPresenceResult.Refused("cancelled")), outcomes)
    }

    @Test
    @Config(shadows = [WitnessBiometricBuilderShadow::class, WitnessBiometricPromptShadow::class, WitnessFailingCleanupSignalShadow::class])
    fun failedActualSignalCleanupDoesNotAcknowledgeSuccess() {
        var cleaned = 0
        val cancellation = WitnessNativeReview(activity).authenticate(Signature.getInstance("Ed25519"), { cleaned++ }) {}
        idleMain(); cancellation.cancel()
        var failed = false
        try { idleMain() } catch (_: RuntimeException) { failed = true }
        assertTrue(failed); assertEquals(0, cleaned)
    }

    @Test
    fun cancellationPostingDoesNotAcknowledgeBeforeActualMainThreadDialogCleanup() {
        var cleaned = 0
        val outcomes = mutableListOf<Boolean>()
        val cancellation = WitnessNativeReview(activity).review(
            WitnessReviewDetails.prepareCreation("replica", bytes(1), bytes(2)), { cleaned++ }, outcomes::add)
        idleMain()
        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertTrue(dialog.isShowing)
        cancellation.cancel()
        assertEquals(0, cleaned)
        assertTrue(dialog.isShowing)
        idleMain()
        assertFalse(dialog.isShowing)
        assertEquals(1, cleaned)
        cancellation.cancel(); idleMain()
        assertEquals(1, cleaned)
        assertEquals(listOf(false), outcomes)
    }

    @Test
    fun closedPreparationReviewCopiesValuesEscapesControlsAndAcceptsOnlyFromButton() {
        val completeValue = "line\nvalue" + "x".repeat(480) + "-exact-tail"
        val enrollment = bytes(1)
        val recipient = bytes(2)
        val details = WitnessReviewDetails.prepareCreation(completeValue, enrollment, recipient)
        enrollment.fill(99)
        recipient.fill(99)
        val outcomes = mutableListOf<Boolean>()

        val cancellation = WitnessNativeReview(activity).review(details, {}, outcomes::add)
        idleMain()

        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertTrue(dialog.isShowing)
        assertEquals("Prepare Treehouse witness enrollment", shadowOf(dialog).title.toString())
        val message = dialog.findViewById<TextView>(android.R.id.message).text.toString()
        assertTrue(message.startsWith("Review a proposed Treehouse witness enrollment and key-possession request."))
        assertTrue(message.contains("This does not establish group authority."))
        assertTrue(message.contains("Product: treehouse"))
        assertTrue(message.contains("Purpose: Prepare witness enrollment"))
        assertTrue(message.contains("Replica: line\\u000Avalue"))
        assertTrue(message.contains("Enrollment ID: ${hex(bytes(1))}"))
        assertTrue(message.contains("Recipient: ${hex(bytes(2))}"))
        assertTrue(message.contains("-exact-tail"))
        assertFalse(message.contains("…"))

        dialog.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        idleMain()
        assertEquals(listOf(true), outcomes)

        cancellation.cancel()
        idleMain()
        assertEquals(listOf(true), outcomes)
    }

    @Test
    fun applicationDeclaresOnlyTheRequiredBiometricPermissionForThisComponent() {
        val info =
            activity.packageManager.getPackageInfo(
                activity.packageName,
                PackageManager.GET_PERMISSIONS
            )
        assertTrue(info.requestedPermissions.orEmpty().contains(Manifest.permission.USE_BIOMETRIC))
    }

    @Test
    fun reviewNegativeButtonAndCancellationEachRefuseExactlyOnce() {
        val buttonOutcomes = mutableListOf<Boolean>()
        val buttonCancellation =
            WitnessNativeReview(activity).review(
                WitnessReviewDetails.prepareCreation("replica", bytes(1), bytes(2)),
                {}, buttonOutcomes::add
            )
        idleMain()
        ShadowAlertDialog.getLatestAlertDialog()
            .getButton(DialogInterface.BUTTON_NEGATIVE)
            .performClick()
        idleMain()
        buttonCancellation.cancel()
        idleMain()
        assertEquals(listOf(false), buttonOutcomes)

        val cancelledOutcomes = mutableListOf<Boolean>()
        val cancellation =
            WitnessNativeReview(activity).review(
                WitnessReviewDetails.prepareCreation("replica", bytes(1), bytes(2)),
                {}, cancelledOutcomes::add
            )
        cancellation.cancel()
        idleMain()
        assertEquals(listOf(false), cancelledOutcomes)

        val raceOutcomes = mutableListOf<Boolean>()
        val raceCancellation =
            WitnessNativeReview(activity).review(
                WitnessReviewDetails.prepareCreation("replica", bytes(1), bytes(2)),
                {}, raceOutcomes::add
            )
        idleMain()
        val raceDialog = ShadowAlertDialog.getLatestAlertDialog()
        Handler(Looper.getMainLooper()).post {
            raceDialog.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        }
        raceCancellation.cancel()
        idleMain()
        assertEquals(listOf(false), raceOutcomes)
    }

    @Test
    fun fixedReviewVariantsShowEveryBoundValueWithNoCallerPromptSurface() {
        val generation = WitnessReviewDetails.generate(
            "replica", bytes(1), bytes(2), bytes(3), bytes(4)
        )
        WitnessNativeReview(activity).review(generation, {}) {}
        idleMain()
        var dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertEquals("Generate Treehouse witness identity", shadowOf(dialog).title.toString())
        var message = dialog.findViewById<TextView>(android.R.id.message).text.toString()
        assertTrue(message.contains("Purpose: Generate witness identity"))
        assertTrue(message.contains("Creation attempt ID: ${hex(bytes(3))}"))
        assertTrue(message.contains("Generation challenge: ${hex(bytes(4))}"))
        dialog.getButton(DialogInterface.BUTTON_NEGATIVE).performClick()

        val binding = WitnessReviewDetails.proveBinding(
            "replica", bytes(1), bytes(2), bytes(5), bytes(3), bytes(6), bytes(7), bytes(8), bytes(9)
        )
        WitnessNativeReview(activity).review(binding, {}) {}
        idleMain()
        dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertEquals("Prove Treehouse witness key possession", shadowOf(dialog).title.toString())
        message = dialog.findViewById<TextView>(android.R.id.message).text.toString()
        for ((label, value) in listOf(
            "Witness public key" to bytes(5), "Creation attempt ID" to bytes(3),
            "Generation challenge digest" to bytes(6), "Validator nonce" to bytes(7),
            "Native nonce" to bytes(8), "Native session digest" to bytes(9)
        )) assertTrue(message.contains("$label: ${hex(value)}"))
    }

    @Test
    fun closedReviewFactoriesRejectInvalidReplicaAndWrongSizedBindings() {
        for (replica in listOf("", "x".repeat(513), "broken\ud800")) {
            try {
                WitnessReviewDetails.prepareCreation(replica, bytes(1), bytes(2))
                fail("invalid replica must be refused")
            } catch (_: IllegalArgumentException) {
                // Expected at the typed native boundary.
            }
        }
        for (invalid in listOf(ByteArray(31), ByteArray(33))) {
            try {
                WitnessReviewDetails.generate("replica", invalid, bytes(2), bytes(3), bytes(4))
                fail("wrong-sized review field must be refused")
            } catch (_: IllegalArgumentException) {
                // Expected at the typed native boundary.
            }
        }
    }

    @Test
    fun reviewTimesOutAt120SecondsAndActivityTeardownRefusesExactlyOnce() {
        val outcomes = mutableListOf<Boolean>()
        WitnessNativeReview(activity).review(
            WitnessReviewDetails.prepareCreation("replica", bytes(1), bytes(2)), {}, outcomes::add
        )
        idleMain()
        shadowOf(Looper.getMainLooper()).idleFor(119, TimeUnit.SECONDS)
        assertTrue(outcomes.isEmpty())
        shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS)
        assertEquals(listOf(false), outcomes)

        val teardown = mutableListOf<Boolean>()
        WitnessNativeReview(activity).review(
            WitnessReviewDetails.prepareCreation("replica", bytes(1), bytes(2)), {}, teardown::add
        )
        idleMain()
        controller.pause().stop().destroy()
        idleMain()
        assertEquals(listOf(false), teardown)
    }

    @Test
    fun pauseAloneInvalidatesReviewAndRefusesNewReviewWhilePaused() {
        val outcomes = mutableListOf<Boolean>()
        val details = WitnessReviewDetails.prepareCreation("replica", bytes(1), bytes(2))
        WitnessNativeReview(activity).review(details, {}, outcomes::add)
        idleMain()
        controller.pause()
        idleMain()
        assertEquals(listOf(false), outcomes)
        val paused = mutableListOf<Boolean>()
        WitnessNativeReview(activity).review(details, {}, paused::add)
        idleMain()
        assertEquals(listOf(false), paused)
        controller.resume()
    }

    @Test
    fun pauseAloneCancelsPresenceAndRefusesNewPresenceWhilePaused() {
        val outcomes = mutableListOf<WitnessPresenceResult>()
        WitnessNativeReview(activity).authenticate(Signature.getInstance("Ed25519"), {}, outcomes::add)
        idleMain()
        val signal = WitnessBiometricPromptShadow.cancellationSignal!!
        controller.pause()
        idleMain()
        assertTrue(signal.isCanceled)
        assertEquals(1, outcomes.size)
        assertTrue(outcomes.single() is WitnessPresenceResult.Refused)
        val paused = mutableListOf<WitnessPresenceResult>()
        WitnessNativeReview(activity).authenticate(Signature.getInstance("Ed25519"), {}, paused::add)
        idleMain()
        assertEquals(1, paused.size)
        assertTrue(paused.single() is WitnessPresenceResult.Refused)
        controller.resume()
    }

    @Test
    fun api32RefusesBeforeCreatingAPlatformPrompt() {
        val originalSdk = Build.VERSION.SDK_INT
        try {
            ReflectionHelpers.setStaticField(Build.VERSION::class.java, "SDK_INT", 32)
            val outcomes = mutableListOf<WitnessPresenceResult>()
            WitnessNativeReview(activity).authenticate(Signature.getInstance("Ed25519"), {}, outcomes::add)
            idleMain()

            assertEquals(
                "biometric_unavailable",
                (outcomes.single() as WitnessPresenceResult.Refused).reason
            )
            assertEquals(null, WitnessBiometricBuilderShadow.title)
            assertEquals(null, WitnessBiometricPromptShadow.cryptoObject)
        } finally {
            ReflectionHelpers.setStaticField(Build.VERSION::class.java, "SDK_INT", originalSdk)
        }
    }

    @Test
    fun presenceUsesStrongBiometricFixedPromptAndReturnsTheExactSignature() {
        val signature = Signature.getInstance("Ed25519")
        val outcomes = mutableListOf<WitnessPresenceResult>()

        WitnessNativeReview(activity).authenticate(signature, {}, outcomes::add)
        idleMain()

        assertEquals("Prove Treehouse witness key possession", WitnessBiometricBuilderShadow.title)
        assertEquals("Cancel", WitnessBiometricBuilderShadow.negativeText)
        assertEquals(
            BiometricManager.Authenticators.BIOMETRIC_STRONG,
            WitnessBiometricBuilderShadow.allowedAuthenticators
        )
        assertSame(signature, WitnessBiometricPromptShadow.cryptoObject?.signature)

        WitnessBiometricPromptShadow.succeedExact()
        idleMain()
        assertEquals(1, outcomes.size)
        assertSame(signature, (outcomes.single() as WitnessPresenceResult.Success).signature)

        WitnessBiometricBuilderShadow.clickNegative()
        WitnessBiometricPromptShadow.failLate()
        idleMain()
        assertEquals(1, outcomes.size)
    }

    @Test
    fun presenceRejectsSubstitutedCryptoAndCancelWinsOverLatePlatformCallbacks() {
        val expected = Signature.getInstance("Ed25519")
        val substituted = Signature.getInstance("Ed25519")
        val mismatch = mutableListOf<WitnessPresenceResult>()
        WitnessNativeReview(activity).authenticate(expected, {}, mismatch::add)
        idleMain()
        WitnessBiometricPromptShadow.succeedWithNewCrypto(substituted)
        idleMain()
        assertEquals("biometric_crypto_mismatch", (mismatch.single() as WitnessPresenceResult.Refused).reason)

        WitnessBiometricBuilderShadow.reset()
        WitnessBiometricPromptShadow.reset()
        val cancelled = mutableListOf<WitnessPresenceResult>()
        val cancellation = WitnessNativeReview(activity).authenticate(expected, {}, cancelled::add)
        idleMain()
        val signal = WitnessBiometricPromptShadow.cancellationSignal
        WitnessBiometricPromptShadow.queueSuccessExact()
        cancellation.cancel()
        idleMain()
        assertTrue(signal?.isCanceled == true)
        assertEquals("cancelled", (cancelled.single() as WitnessPresenceResult.Refused).reason)

        WitnessBiometricPromptShadow.succeedExact()
        WitnessBiometricPromptShadow.failLate()
        idleMain()
        assertEquals(1, cancelled.size)
    }

    @Test
    fun presenceTimesOutAt60SecondsAndCancelsTheExactPlatformOperation() {
        val outcomes = mutableListOf<WitnessPresenceResult>()
        WitnessNativeReview(activity).authenticate(Signature.getInstance("Ed25519"), {}, outcomes::add)
        idleMain()
        val signal = WitnessBiometricPromptShadow.cancellationSignal
        shadowOf(Looper.getMainLooper()).idleFor(59, TimeUnit.SECONDS)
        assertTrue(outcomes.isEmpty())
        shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS)
        assertTrue(signal?.isCanceled == true)
        assertEquals("biometric_timeout", (outcomes.single() as WitnessPresenceResult.Refused).reason)
        WitnessBiometricPromptShadow.succeedExact()
        idleMain()
        assertEquals(1, outcomes.size)
    }

    @Test
    fun activityTeardownCancelsPresenceAndDrainsOneTerminalCallback() {
        val outcomes = mutableListOf<WitnessPresenceResult>()
        WitnessNativeReview(activity).authenticate(Signature.getInstance("Ed25519"), {}, outcomes::add)
        idleMain()
        val signal = WitnessBiometricPromptShadow.cancellationSignal
        controller.pause().stop().destroy()
        idleMain()
        assertTrue(signal?.isCanceled == true)
        assertEquals("cancelled", (outcomes.single() as WitnessPresenceResult.Refused).reason)
        WitnessBiometricPromptShadow.succeedExact()
        WitnessBiometricPromptShadow.failLate()
        idleMain()
        assertEquals(1, outcomes.size)
    }

    private fun idleMain() = shadowOf(Looper.getMainLooper()).idle()
    private fun bytes(value: Int) = ByteArray(32) { value.toByte() }
    private fun hex(value: ByteArray) = value.joinToString("") { "%02X".format(it.toInt() and 0xff) }
}

@Implements(BiometricPrompt.Builder::class)
class WitnessBiometricBuilderShadow {
    @RealObject private lateinit var realBuilder: BiometricPrompt.Builder

    @Implementation
    fun __constructor__(context: Context) {
        require(context is Activity)
    }

    @Implementation
    fun setTitle(value: CharSequence): BiometricPrompt.Builder {
        title = value.toString()
        return realBuilder
    }

    @Implementation
    fun setAllowedAuthenticators(value: Int): BiometricPrompt.Builder {
        allowedAuthenticators = value
        return realBuilder
    }

    @Implementation
    fun setNegativeButton(
        text: CharSequence,
        executor: Executor,
        listener: DialogInterface.OnClickListener
    ): BiometricPrompt.Builder {
        negativeText = text.toString()
        negativeExecutor = executor
        negativeListener = listener
        return realBuilder
    }

    @Implementation
    fun build(): BiometricPrompt = ReflectionHelpers.callConstructor(BiometricPrompt::class.java)

    companion object {
        var title: String? = null
        var negativeText: String? = null
        var allowedAuthenticators: Int? = null
        private var negativeExecutor: Executor? = null
        private var negativeListener: DialogInterface.OnClickListener? = null

        fun clickNegative() {
            val executor = negativeExecutor ?: error("negative executor was not installed")
            val listener = negativeListener ?: error("negative listener was not installed")
            executor.execute { listener.onClick(null, DialogInterface.BUTTON_NEGATIVE) }
        }

        @JvmStatic
        @Resetter
        fun reset() {
            title = null
            negativeText = null
            allowedAuthenticators = null
            negativeExecutor = null
            negativeListener = null
        }
    }
}

@Implements(BiometricPrompt::class)
class WitnessBiometricPromptShadow {
    @Implementation
    fun authenticate(
        crypto: BiometricPrompt.CryptoObject,
        cancellation: CancellationSignal,
        callbackExecutor: Executor,
        authenticationCallback: BiometricPrompt.AuthenticationCallback
    ) {
        cryptoObject = crypto
        cancellationSignal = cancellation
        executor = callbackExecutor
        callback = authenticationCallback
    }

    companion object {
        var cryptoObject: BiometricPrompt.CryptoObject? = null
        var cancellationSignal: CancellationSignal? = null
        private var executor: Executor? = null
        private var callback: BiometricPrompt.AuthenticationCallback? = null

        fun succeedExact() {
            val exact = cryptoObject ?: error("authentication was not started")
            succeed(exact)
        }

        fun queueSuccessExact() = succeedExact()

        fun succeedWithNewCrypto(signature: Signature) {
            succeed(BiometricPrompt.CryptoObject(signature))
        }

        private fun succeed(resultCrypto: BiometricPrompt.CryptoObject) {
            val result =
                ReflectionHelpers.callConstructor(
                    BiometricPrompt.AuthenticationResult::class.java,
                    ClassParameter.from(
                        BiometricPrompt.CryptoObject::class.java,
                        resultCrypto
                    ),
                    ClassParameter.from(Int::class.javaPrimitiveType, BiometricPrompt.AUTHENTICATION_RESULT_TYPE_BIOMETRIC)
                )
            executor?.execute { callback?.onAuthenticationSucceeded(result) }
                ?: error("authentication was not started")
        }

        fun failLate() {
            executor?.execute { callback?.onAuthenticationError(BiometricPrompt.BIOMETRIC_ERROR_CANCELED, "late") }
                ?: error("authentication was not started")
        }

        @JvmStatic
        @Resetter
        fun reset() {
            cryptoObject = null
            cancellationSignal = null
            executor = null
            callback = null
        }
    }
}

/** A local cleanup failure, not a synthetic biometric acceptance. */
@Implements(CancellationSignal::class)
class WitnessFailingCleanupSignalShadow {
    @Implementation
    fun cancel() { throw IllegalStateException("local cleanup failed") }
}
