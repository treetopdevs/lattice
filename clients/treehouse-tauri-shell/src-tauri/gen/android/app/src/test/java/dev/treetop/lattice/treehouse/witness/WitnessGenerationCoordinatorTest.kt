package dev.treetop.lattice.treehouse.witness

import android.content.Context
import android.content.ContextWrapper
import java.io.File
import java.security.Signature
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.After
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
class WitnessGenerationCoordinatorTest {
    @get:Rule val temporary = TemporaryFolder()
    @After fun cleanup() { WitnessDirectoryOsShadow.reset() }

    @Test fun generationRunsOnlyAfterDurableFenceAndRetainsOriginalAcrossRetry() {
        val context = context()
        val enrollment = WitnessEnrollment(bytes(1), "replica:test", bytes(2), bytes(3))
        WitnessJournal(context, bytes(7)).use { stored(it.prepareAccepted(enrollment, bytes(3))) }
        val fake = FakePlatform()
        fake.onGenerate = { original, fence ->
            assertEquals(WitnessPhase.GENERATION_STARTED, original.phase)
            assertEquals(2L, fence.revision)
            WitnessJournal(context, bytes(7)).use {
                assertEquals(WitnessResult.Refused("storage_busy"), it.observeExisting())
            }
        }
        val coordinator = WitnessGenerationCoordinator(context, bytes(7), Review(true), fake, { true })
        val result = stored(run(coordinator, request(1)))
        assertEquals(WitnessPhase.GENERATED_UNVALIDATED, result.identity.phase)
        assertEquals(1, fake.calls)
        assertEquals(3L, result.identity.revision)
        assertEquals(result.identity.metadata, stored(run(coordinator, request(3))).identity.metadata)
        assertEquals(1, fake.calls)
    }

    @Test fun refusalAndStartedMissingAliasNeverInvokeGenerator() {
        val context = context()
        WitnessJournal(context, bytes(7)).use { stored(it.prepareAccepted(WitnessEnrollment(bytes(1), "replica:test", bytes(2), bytes(3)), bytes(3))) }
        val fake = FakePlatform()
        val denied = WitnessGenerationCoordinator(context, bytes(7), Review(false), fake, { true })
        assertEquals(WitnessResult.Refused("cancelled"), run(denied, request(1)))
        assertEquals(0, fake.calls)
        WitnessJournal(context, bytes(7)).use { stored(it.commitGenerationStarted(1, bytes(3), bytes(4))) }
        val retry = WitnessGenerationCoordinator(context, bytes(7), Review(true), fake, { true })
        assertEquals(WitnessResult.Refused("identity_incomplete"), run(retry, request(2)))
        assertEquals(0, fake.calls)
    }

    @Test fun cancelDuringGeneratorRetainsLeaseAndPersistsOriginalBeforeRefusing() {
        val context = context()
        WitnessJournal(context, bytes(7)).use { stored(it.prepareAccepted(WitnessEnrollment(bytes(1), "replica:test", bytes(2), bytes(3)), bytes(3))) }
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val done = CountDownLatch(1)
        val result = AtomicReference<WitnessResult<WitnessSnapshot>>()
        val fake = FakePlatform()
        fake.onGenerate = { _, _ -> entered.countDown(); assertTrue(release.await(10, TimeUnit.SECONDS)) }
        val coordinator = WitnessGenerationCoordinator(context, bytes(7), Review(true), fake, { true })
        coordinator.generate(request(1)) { result.set(it); done.countDown() }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        try {
            assertFalse(coordinator.cancel(bytes(8), bytes(6)))
            assertFalse(coordinator.cancel(bytes(5), bytes(8)))
            assertTrue(coordinator.cancel(bytes(5), bytes(6)))
            assertFalse(done.await(100, TimeUnit.MILLISECONDS))
            WitnessJournal(context, bytes(7)).use { assertEquals(WitnessResult.Refused("storage_busy"), it.observeExisting()) }
            assertEquals(WitnessResult.Refused("storage_busy"), run(coordinator, request(1)))
        } finally { release.countDown() }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        assertEquals(WitnessResult.Refused("cancelled"), result.get())
        WitnessJournal(context, bytes(7)).use { assertEquals(WitnessPhase.GENERATED_UNVALIDATED, stored(it.observeExisting()).identity.phase) }
        assertEquals(1, fake.calls)
    }

    @Test fun cancellationAfterCommittedFenceStillDrainsOneOriginalGeneration() {
        val context = context()
        WitnessJournal(context, bytes(7)).use { stored(it.prepareAccepted(WitnessEnrollment(bytes(1), "replica:test", bytes(2), bytes(3)), bytes(3))) }
        val fake = FakePlatform()
        lateinit var coordinator: WitnessGenerationCoordinator
        coordinator = WitnessGenerationCoordinator(context, bytes(7), Review(true), fake, { true }, { stage ->
            if (stage == "before_response") coordinator.cancel(bytes(5), bytes(6))
        })
        assertEquals(WitnessResult.Refused("cancelled"), run(coordinator, request(1)))
        assertEquals(1, fake.calls)
        WitnessJournal(context, bytes(7)).use { assertEquals(WitnessPhase.GENERATED_UNVALIDATED, stored(it.observeExisting()).identity.phase) }
    }

    @Test fun aliasAppearingAfterFenceIsNeverOverwritten() {
      for (refused in listOf(false, true)) {
        val context = context()
        WitnessJournal(context, bytes(7)).use { stored(it.prepareAccepted(WitnessEnrollment(bytes(1), "replica:test", bytes(2), bytes(3)), bytes(3))) }
        val fake = FakePlatform()
        val coordinator = WitnessGenerationCoordinator(context, bytes(7), Review(true), fake, { true }, { stage ->
            if (stage == "before_response") {
                if (refused) fake.refusal = "identity_incomplete" else fake.present = true
            }
        })
        assertEquals(WitnessResult.Refused("identity_incomplete"), run(coordinator, request(1)))
        assertEquals(0, fake.calls)
        WitnessJournal(context, bytes(7)).use { assertEquals(WitnessPhase.GENERATION_STARTED, stored(it.observeExisting()).identity.phase) }
      }
    }

    @Test fun mismatchedChallengeAndDeadSessionRefuseWithoutGeneration() {
        val context = context()
        WitnessJournal(context, bytes(7)).use {
            stored(it.prepareAccepted(WitnessEnrollment(bytes(1), "replica:test", bytes(2), bytes(3)), bytes(3)))
            stored(it.commitGenerationStarted(1, bytes(3), bytes(4)))
        }
        val fake = FakePlatform().also { it.present = true }
        val coordinator = WitnessGenerationCoordinator(context, bytes(7), Review(true), fake, { true })
        val mismatch = WitnessGenerationRequest(2, bytes(3), bytes(8), bytes(5), bytes(6))
        assertEquals(WitnessResult.Refused("original_identity_mismatch"), run(coordinator, mismatch))
        val dead = WitnessGenerationCoordinator(context, bytes(7), Review(true), fake, { false })
        assertEquals(WitnessResult.Refused("cancelled"), run(dead, request(2)))
        assertEquals(0, fake.calls)
        assertEquals(WitnessPhase.GENERATED_UNVALIDATED, stored(run(coordinator, request(2))).identity.phase)
        assertEquals(0, fake.calls)
    }

    private fun run(coordinator: WitnessGenerationCoordinator, request: WitnessGenerationRequest): WitnessResult<WitnessSnapshot> {
        val done = CountDownLatch(1)
        val result = AtomicReference<WitnessResult<WitnessSnapshot>>()
        coordinator.generate(request) { result.set(it); done.countDown() }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        return result.get()
    }
    private class Review(private val accepted: Boolean): WitnessReviewUi {
        override fun review(details: WitnessReviewDetails, callback: (Boolean) -> Unit): WitnessUiCancellation {
            callback(accepted)
            return object: WitnessUiCancellation { override fun cancel() {} }
        }
        override fun authenticate(signature: Signature, callback: (WitnessPresenceResult) -> Unit): WitnessUiCancellation = error("generation cannot sign")
    }
    private class FakePlatform: WitnessGenerationPlatform {
        var calls = 0
        var present = false
        var refusal: String? = null
        var onGenerate: (WitnessIdentityRecord, GenerationFence) -> Unit = { _, _ -> }
        override fun observe(original: WitnessIdentityRecord): WitnessKeyObservation =
            refusal?.let { WitnessKeyObservation.Refused(it) } ?: if (present) WitnessKeyObservation.Present(metadata()) else WitnessKeyObservation.Absent
        override fun generate(original: WitnessIdentityRecord, fence: GenerationFence) {
            onGenerate(original, fence)
            calls++
            present = true
        }
    }
    private fun context(): Context = object: ContextWrapper(RuntimeEnvironment.getApplication()) {
        private val root = temporary.newFolder().also { WitnessDirectoryOsShadow.registerRoot(it) }
        override fun getDataDir(): File = root
        override fun getNoBackupFilesDir(): File = File(root, "no_backup").also { it.mkdirs() }
    }
    private fun request(revision: Long) = WitnessGenerationRequest(revision, bytes(3), bytes(4), bytes(5), bytes(6))
    private fun <T> stored(result: WitnessResult<T>): T { assertTrue("$result", result is WitnessResult.Stored); return (result as WitnessResult.Stored).value }
    companion object {
        private fun bytes(value: Int) = ByteArray(32) { value.toByte() }
        private fun metadata() = CapturedWitnessIdentity(bytes(9), byteArrayOf(0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00)+bytes(9), bytes(7), "1", listOf(byteArrayOf(1,2,3)))
    }
}
