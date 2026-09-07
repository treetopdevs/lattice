package dev.treetop.lattice.treehouse.witness

import android.content.Context
import android.content.ContextWrapper
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
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
class WitnessPreparationCoordinatorTest {
    @get:Rule val temporary = TemporaryFolder()
    @After fun cleanup() { WitnessDirectoryOsShadow.reset() }

    @Test fun acceptedReviewCreatesOnlyDurablePreparedEnrollment() {
        val context = context()
        val coordinator = coordinator(context, Ui(), 3)
        val result = stored(prepare(coordinator, request()))
        assertEquals(WitnessBytes(bytes(3)), result.creationAttemptId)
        WitnessJournal(context, bytes(7)).use {
            val snapshot = stored(it.observeExisting())
            assertEquals(WitnessPhase.PREPARED, snapshot.identity.phase)
            assertEquals(1, snapshot.enrollments.size)
            assertEquals("replica:test", snapshot.enrollments.single().replica)
        }
    }

    @Test fun refusalAndCancellationDoNotCreateJournalState() {
        for (cancel in listOf(false, true)) {
            val context = context(); val ui = Ui(auto = !cancel, accepted = false)
            val coordinator = coordinator(context, ui, 3)
            if (cancel) {
                val done = CountDownLatch(1); val result = AtomicReference<WitnessResult<PreparedWitnessCreation>>()
                coordinator.prepare(request()) { result.set(it); done.countDown() }
                assertTrue(ui.entered.await(10, TimeUnit.SECONDS))
                assertTrue(coordinator.cancel(bytes(5), bytes(8)))
                ui.answer(true); assertTrue(done.await(10, TimeUnit.SECONDS))
                assertEquals(WitnessResult.Refused("cancelled"), result.get())
            } else assertEquals(WitnessResult.Refused("cancelled"), prepare(coordinator, request()))
            WitnessJournal(context, bytes(7)).use { assertEquals(WitnessResult.Missing, it.observeExisting()) }
        }
    }

    @Test fun identicalPreparationReturnsOriginalAttemptWithoutAnotherReviewOrRandomValue() {
        val context = context(); val firstUi = Ui()
        val first = stored(prepare(coordinator(context, firstUi, 3), request()))
        val secondUi = Ui()
        val second = stored(prepare(coordinator(context, secondUi, 44), request()))
        assertEquals(first.creationAttemptId, second.creationAttemptId)
        assertEquals(1, firstUi.calls.get())
        assertEquals(0, secondUi.calls.get())
    }

    @Test fun completedIdentityAcceptsReviewedEnrollmentUnderOriginalAttemptWithoutRotation() {
        val context = completedContext()
        val result = stored(prepare(coordinator(context, Ui(), 44), request(enrollment = 10)))
        assertEquals(WitnessBytes(bytes(3)), result.creationAttemptId)
        assertEquals(4L, result.revision)
        WitnessJournal(context, bytes(7)).use {
            val snapshot = stored(it.observeExisting())
            assertEquals(WitnessPhase.GENERATED_UNVALIDATED, snapshot.identity.phase)
            assertEquals(2, snapshot.enrollments.size)
        }
    }

    @Test fun incompleteAndConflictingRetainedStateRefuseWithoutReview() {
        val context = context()
        stored(prepare(coordinator(context, Ui(), 3), request()))
        val incompleteUi = Ui()
        assertEquals(WitnessResult.Refused("identity_incomplete"),
            prepare(coordinator(context, incompleteUi, 4), request(enrollment = 10)))
        assertEquals(0, incompleteUi.calls.get())
        val conflictUi = Ui()
        assertEquals(WitnessResult.Refused("enrollment_conflict"),
            prepare(coordinator(context, conflictUi, 4), request(recipient = 11)))
        assertEquals(0, conflictUi.calls.get())
    }

    @Test fun pendingReviewSerializesNativePreparationOperations() {
        val context = context(); val ui = Ui(auto = false)
        val coordinator = coordinator(context, ui, 3)
        val done = CountDownLatch(1)
        coordinator.prepare(request()) { done.countDown() }
        assertTrue(ui.entered.await(10, TimeUnit.SECONDS))
        assertEquals(WitnessResult.Refused("storage_busy"), prepare(coordinator, request(enrollment = 10)))
        ui.answer(false)
        assertTrue(done.await(10, TimeUnit.SECONDS))
    }

    @Test fun sessionLossAfterDurableCommitSuppressesSuccessButRetainsPreparation() {
        val context = context(); val live = java.util.concurrent.atomic.AtomicBoolean(true)
        val coordinator = WitnessPreparationCoordinator(context, bytes(7), Ui(), { live.get() }, { bytes(3) },
            { stage -> if (stage == "before_response") live.set(false) })
        assertEquals(WitnessResult.Refused("cancelled"), prepare(coordinator, request()))
        WitnessJournal(context, bytes(7)).use {
            assertEquals(WitnessPhase.PREPARED, stored(it.observeExisting()).identity.phase)
        }
    }

    private fun coordinator(context: Context, ui: Ui, random: Int) =
        WitnessPreparationCoordinator(context, bytes(7), ui, { true }, { bytes(random) })
    private fun request(enrollment: Int = 1, recipient: Int = 2) =
        WitnessPreparationRequest(bytes(5), bytes(8), "replica:test", bytes(enrollment), bytes(recipient))
    private fun prepare(coordinator: WitnessPreparationCoordinator, request: WitnessPreparationRequest): WitnessResult<PreparedWitnessCreation> {
        val done = CountDownLatch(1); val result = AtomicReference<WitnessResult<PreparedWitnessCreation>>()
        coordinator.prepare(request) { result.set(it); done.countDown() }
        assertTrue(done.await(10, TimeUnit.SECONDS)); return result.get()
    }
    private class Ui(private val auto: Boolean = true, private val accepted: Boolean = true): WitnessReviewUi {
        val calls = AtomicInteger(); val entered = CountDownLatch(1)
        private val callback = AtomicReference<((Boolean) -> Unit)?>()
        override fun review(details: WitnessReviewDetails, callback: (Boolean) -> Unit): WitnessUiCancellation {
            calls.incrementAndGet(); this.callback.set(callback); entered.countDown()
            if (auto) callback(accepted)
            return object: WitnessUiCancellation { override fun cancel() { callback(false) } }
        }
        fun answer(value: Boolean) { callback.get()?.invoke(value) }
        override fun authenticate(signature: java.security.Signature, callback: (WitnessPresenceResult) -> Unit) =
            throw AssertionError("no_key_operation")
    }
    private fun completedContext(): Context {
        val context = context(); val enrollment = WitnessEnrollment(bytes(1), "replica:test", bytes(2), bytes(3))
        WitnessJournal(context, bytes(7)).use { journal ->
            stored(journal.prepareAccepted(enrollment, bytes(3)))
            val fence = stored(journal.commitGenerationStarted(1, bytes(3), bytes(4)))
            stored(journal.finishOriginalGeneration(fence, metadata()))
        }
        return context
    }
    private fun context(): Context = object: ContextWrapper(RuntimeEnvironment.getApplication()) {
        private val root = temporary.newFolder().also { WitnessDirectoryOsShadow.registerRoot(it) }
        override fun getDataDir(): File = root
        override fun getNoBackupFilesDir(): File = File(root, "no_backup").also { it.mkdirs() }
    }
    private fun <T> stored(result: WitnessResult<T>): T {
        assertTrue("$result", result is WitnessResult.Stored); return (result as WitnessResult.Stored).value
    }
    companion object {
        private fun bytes(value: Int) = ByteArray(32) { value.toByte() }
        private fun metadata() = CapturedWitnessIdentity(bytes(9), byteArrayOf(0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00)+bytes(9), bytes(7), "1", listOf(byteArrayOf(1,2,3)))
    }
}
