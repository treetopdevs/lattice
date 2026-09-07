package dev.treetop.lattice.treehouse.witness

import android.content.Context
import android.content.ContextWrapper
import java.io.File
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [WitnessDirectoryOsShadow::class])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class WitnessBindingCoordinatorTest {
    @get:Rule val temporary = TemporaryFolder()
    @After fun cleanup() { WitnessDirectoryOsShadow.reset() }

    @Test fun consentIsDurableBeforeExactCryptoObjectAndHandleIsOneShot() {
        val context = completedContext()
        val key = keyPair()
        val signature = signing(key)
        lateinit var coordinator: WitnessBindingCoordinator
        val ui = Ui(onPresence = { actual, callback ->
            assertSame(signature, actual)
            WitnessJournal(context, bytes(7)).use {
                assertEquals(WitnessResult.Refused("storage_busy"), it.observeExisting())
            }
            callback(WitnessPresenceResult.Success(actual))
        })
        coordinator = WitnessBindingCoordinator(context, bytes(7), ui, Platform(signature), { true })
        val prepared = stored(prepare(coordinator, request(3)))
        assertTrue(prepared.remainingMillis in 1..60_000)
        val signed = stored(sign(coordinator, prepared.handle))
        assertEquals(64, signed.signature.size)
        assertTrue(Signature.getInstance("Ed25519").run {
            initVerify(key.public); update(BindingCodec.encode(signed.claim)); verify(signed.signature)
        })
        assertEquals(WitnessResult.Refused("stale_binding_handle"), sign(coordinator, prepared.handle))
        WitnessJournal(context, bytes(7)).use {
            assertEquals(1, stored(it.observeExisting()).spentNonces.size)
        }
    }

    @Test fun cancellationDuringPresenceDrainsAndNeverRestoresSpentNonce() {
        val context = completedContext()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val ui = Ui(onPresence = { signature, callback ->
            entered.countDown()
            Thread { release.await(); callback(WitnessPresenceResult.Success(signature)) }.start()
        })
        val coordinator = WitnessBindingCoordinator(context, bytes(7), ui, Platform(signing(keyPair())), { true })
        val prepared = stored(prepare(coordinator, request(3)))
        val done = CountDownLatch(1)
        val result = AtomicReference<WitnessResult<SignedWitnessBinding>>()
        coordinator.signPrepared(prepared.handle) { result.set(it); done.countDown() }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        assertTrue(coordinator.cancel(bytes(5), bytes(8)))
        release.countDown()
        assertTrue(done.await(10, TimeUnit.SECONDS))
        assertEquals(WitnessResult.Refused("cancelled"), result.get())
        WitnessJournal(context, bytes(7)).use {
            val snapshot = stored(it.observeExisting())
            assertEquals(1, snapshot.spentNonces.size)
            assertEquals(4L, snapshot.identity.revision)
        }
    }

    @Test fun consentDeadlineAndSessionAreCheckedAfterBlockingSign() {
        val context = completedContext()
        var now = 1_000L
        val live = AtomicBoolean(true)
        val signature = signing(keyPair())
        val ui = Ui(onPresence = { actual, callback ->
            now += 60_000_000_001L; live.set(false); callback(WitnessPresenceResult.Success(actual))
        })
        val coordinator = WitnessBindingCoordinator(context, bytes(7), ui, Platform(signature), { live.get() }, { now })
        val prepared = stored(prepare(coordinator, request(3)))
        assertEquals(WitnessResult.Refused("binding_timeout"), sign(coordinator, prepared.handle))
    }

    @Test fun durableConsentTransitConsumesRatherThanRestartsSigningLifetime() {
        val context = completedContext()
        var now = 10L
        val coordinator = WitnessBindingCoordinator(context, bytes(7), Ui(), Platform(signing(keyPair())),
            { true }, { now }, { stage -> if (stage == "before_response") now += 60_000_000_001L })
        assertEquals(WitnessResult.Refused("binding_timeout"), prepare(coordinator, request(3)))
        WitnessJournal(context, bytes(7)).use {
            assertEquals(1, stored(it.observeExisting()).spentNonces.size)
        }
    }

    @Test fun substitutedCryptoObjectAndWrongHandleRefuseWithoutSigning() {
        val context = completedContext()
        val expected = signing(keyPair())
        val substituted = signing(keyPair())
        val ui = Ui(onPresence = { _, callback -> callback(WitnessPresenceResult.Success(substituted)) })
        val coordinator = WitnessBindingCoordinator(context, bytes(7), ui, Platform(expected), { true })
        val prepared = stored(prepare(coordinator, request(3)))
        val fake = object : WitnessBindingHandle {}
        assertEquals(WitnessResult.Refused("stale_binding_handle"), sign(coordinator, fake))
        assertEquals(WitnessResult.Refused("biometric_crypto_mismatch"), sign(coordinator, prepared.handle))
    }

    @Test fun reviewRefusalDoesNotSpendButCommittedNonceIsGloballyOneUse() {
        val context = completedContext()
        val refused = WitnessBindingCoordinator(context, bytes(7), Ui(accepted = false),
            Platform(signing(keyPair())), { true })
        assertEquals(WitnessResult.Refused("cancelled"), prepare(refused, request(3)))
        WitnessJournal(context, bytes(7)).use { assertTrue(stored(it.observeExisting()).spentNonces.isEmpty()) }

        val first = WitnessBindingCoordinator(context, bytes(7), Ui(), Platform(signing(keyPair())), { true })
        stored(prepare(first, request(3)))
        assertTrue(first.cancel(bytes(5), bytes(8)))
        val repeated = WitnessBindingCoordinator(context, bytes(7), Ui(), Platform(signing(keyPair())), { true })
        assertEquals(WitnessResult.Refused("validator_nonce_spent"), prepare(repeated, request(4)))
    }

    private fun completedContext(): Context {
        val context = context()
        val enrollment = WitnessEnrollment(bytes(1), "replica:test", bytes(2), bytes(3))
        WitnessJournal(context, bytes(7)).use { journal ->
            stored(journal.prepareAccepted(enrollment, bytes(3)))
            val fence = stored(journal.commitGenerationStarted(1, bytes(3), bytes(4)))
            stored(journal.finishOriginalGeneration(fence, metadata()))
        }
        return context
    }
    private fun request(revision: Long) = WitnessBindingRequest(revision, "replica:test", bytes(1), bytes(2),
        bytes(6), bytes(5), bytes(9), bytes(8))
    private fun prepare(coordinator: WitnessBindingCoordinator, request: WitnessBindingRequest): WitnessResult<PreparedWitnessBinding> {
        val done = CountDownLatch(1); val result = AtomicReference<WitnessResult<PreparedWitnessBinding>>()
        coordinator.prepareBinding(request) { result.set(it); done.countDown() }
        assertTrue(done.await(10, TimeUnit.SECONDS)); return result.get()
    }
    private fun sign(coordinator: WitnessBindingCoordinator, handle: WitnessBindingHandle): WitnessResult<SignedWitnessBinding> {
        val done = CountDownLatch(1); val result = AtomicReference<WitnessResult<SignedWitnessBinding>>()
        coordinator.signPrepared(handle) { result.set(it); done.countDown() }
        assertTrue(done.await(10, TimeUnit.SECONDS)); return result.get()
    }
    private class Platform(private val signature: Signature): WitnessBindingPlatform {
        override fun prepareSignature(original: WitnessIdentityRecord) = WitnessResult.Stored(signature)
    }
    private class Ui(
        private val accepted: Boolean = true,
        private val onPresence: (Signature, (WitnessPresenceResult) -> Unit) -> Unit = { signature, callback ->
            callback(WitnessPresenceResult.Success(signature))
        },
    ): WitnessReviewUi {
        override fun review(details: WitnessReviewDetails, callback: (Boolean) -> Unit): WitnessUiCancellation {
            callback(accepted); return cancellation()
        }
        override fun authenticate(signature: Signature, callback: (WitnessPresenceResult) -> Unit): WitnessUiCancellation {
            onPresence(signature, callback); return cancellation()
        }
        private fun cancellation() = object : WitnessUiCancellation { override fun cancel() {} }
    }
    private fun keyPair(): KeyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    private fun signing(key: KeyPair): Signature = Signature.getInstance("Ed25519").also { it.initSign(key.private) }
    private fun context(): Context = object: ContextWrapper(RuntimeEnvironment.getApplication()) {
        private val root = temporary.newFolder().also { WitnessDirectoryOsShadow.registerRoot(it) }
        override fun getDataDir(): File = root
        override fun getNoBackupFilesDir(): File = File(root, "no_backup").also { it.mkdirs() }
    }
    private fun <T> stored(result: WitnessResult<T>): T { assertTrue("$result", result is WitnessResult.Stored); return (result as WitnessResult.Stored).value }
    companion object {
        private fun bytes(value: Int) = ByteArray(32) { value.toByte() }
        private fun metadata() = CapturedWitnessIdentity(bytes(9), byteArrayOf(0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00)+bytes(9), bytes(7), "1", listOf(byteArrayOf(1,2,3)))
    }
}
