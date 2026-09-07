package dev.treetop.lattice.treehouse.witness

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

    @Before
    fun setUp() {
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        activity.setTheme(android.R.style.Theme_Material_Light)
    }

    @After
    fun tearDown() {
        activity.finish()
        WitnessBiometricBuilderShadow.reset()
        WitnessBiometricPromptShadow.reset()
    }

    @Test
    fun reviewCopiesDetailsEscapesControlsPreservesFullValuesAndAcceptsOnlyFromButton() {
        val completeValue = "line\nvalue" + "x".repeat(4096) + "-exact-tail"
        val mutable = mutableListOf("Replica\u202e" to completeValue)
        val details = WitnessReviewDetails("Proposed\u0000 enrollment", mutable)
        mutable[0] = "changed" to "changed"
        try {
            @Suppress("UNCHECKED_CAST")
            (details.fields as MutableList<Pair<String, String>>).add("forged" to "forged")
            fail("the exposed detail list must be immutable")
        } catch (_: UnsupportedOperationException) {
            // Expected: callers cannot mutate the copied review after construction.
        }
        val outcomes = mutableListOf<Boolean>()

        val cancellation = WitnessNativeReview(activity).review(details, outcomes::add)
        idleMain()

        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertTrue(dialog.isShowing)
        assertEquals("Proposed\\u0000 enrollment", shadowOf(dialog).title.toString())
        val message = dialog.findViewById<TextView>(android.R.id.message).text.toString()
        assertTrue(message.startsWith("Review a proposed Treehouse witness enrollment and key-possession request."))
        assertTrue(message.contains("This does not establish group authority."))
        assertTrue(message.contains("Replica\\u202E: line\\u000Avalue"))
        assertTrue(message.endsWith("-exact-tail"))
        assertFalse(message.contains("changed"))
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
            WitnessNativeReview(activity).review(WitnessReviewDetails("Review", emptyList()), buttonOutcomes::add)
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
            WitnessNativeReview(activity).review(WitnessReviewDetails("Review", emptyList()), cancelledOutcomes::add)
        cancellation.cancel()
        idleMain()
        assertEquals(listOf(false), cancelledOutcomes)

        val raceOutcomes = mutableListOf<Boolean>()
        val raceCancellation =
            WitnessNativeReview(activity).review(WitnessReviewDetails("Review", emptyList()), raceOutcomes::add)
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
    fun api32RefusesBeforeCreatingAPlatformPrompt() {
        val originalSdk = Build.VERSION.SDK_INT
        try {
            ReflectionHelpers.setStaticField(Build.VERSION::class.java, "SDK_INT", 32)
            val outcomes = mutableListOf<WitnessPresenceResult>()
            WitnessNativeReview(activity).authenticate(Signature.getInstance("Ed25519"), outcomes::add)
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

        WitnessNativeReview(activity).authenticate(signature, outcomes::add)
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
        WitnessNativeReview(activity).authenticate(expected, mismatch::add)
        idleMain()
        WitnessBiometricPromptShadow.succeedWithNewCrypto(substituted)
        idleMain()
        assertEquals("biometric_crypto_mismatch", (mismatch.single() as WitnessPresenceResult.Refused).reason)

        WitnessBiometricBuilderShadow.reset()
        WitnessBiometricPromptShadow.reset()
        val cancelled = mutableListOf<WitnessPresenceResult>()
        val cancellation = WitnessNativeReview(activity).authenticate(expected, cancelled::add)
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

    private fun idleMain() = shadowOf(Looper.getMainLooper()).idle()
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
