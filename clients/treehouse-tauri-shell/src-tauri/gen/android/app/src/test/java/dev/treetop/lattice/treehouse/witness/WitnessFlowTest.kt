package dev.treetop.lattice.treehouse.witness

import android.content.Context
import android.content.ContextWrapper
import java.io.File
import java.security.Signature
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [WitnessDirectoryOsShadow::class])
class WitnessFlowTest {
    @get:Rule val temporary = TemporaryFolder()
    @After fun cleanup() { WitnessDirectoryOsShadow.reset() }
    @Test fun cancellationDoesNotReadmitWhileBackendStillDrains() {
        val context = context(); prepared(context)
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val completed = CountDownLatch(1); val cancelled = CountDownLatch(1)
        val platform = Platform()
        platform.generateAction = { entered.countDown(); assertTrue(release.await(10, TimeUnit.SECONDS)) }
        val flow = flow(context, platform); val results = mutableListOf<WitnessResult<ByteArray>>()
        flow.submit(generate()) { results.add(it); completed.countDown() }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        assertEquals(WitnessTerminalStatus.MISSING, terminal(run(flow, cancel(8))).status)
        flow.submit(cancel(5)) { assertEquals(WitnessTerminalStatus.CANCELLED, terminal(it).status); cancelled.countDown() }
        try {
            assertFalse(completed.await(50, TimeUnit.MILLISECONDS)); assertFalse(cancelled.await(50, TimeUnit.MILLISECONDS))
            assertBusy(flow)
            WitnessJournal(context, bytes(7)).use { assertEquals(WitnessResult.Refused("storage_busy"), it.observeExisting()) }
            repeat(20) { assertEquals(WitnessTerminalStatus.MISSING, terminal(run(flow, cancel(5))).status) }
        } finally { release.countDown() }
        assertTrue(completed.await(10, TimeUnit.SECONDS)); assertTrue(cancelled.await(10, TimeUnit.SECONDS))
        WitnessJournal(context, bytes(7)).use { assertEquals(WitnessPhase.GENERATED_UNVALIDATED, stored(it.observeExisting()).identity.phase) }
        assertEquals(listOf(WitnessResult.Refused("cancelled")), results); assertEquals(1, platform.calls)
    }

    @Test fun generationRetainsOriginalAndNeverGeneratesOnRetry() {
        val context = context(); prepared(context)
        val platform = Platform()
        val flow = flow(context, platform)
        assertTrue(run(flow, generate()) is WitnessResult.Stored)
        awaitIdle(flow)
        assertTrue(run(flow, generate(3)) is WitnessResult.Stored)
        awaitIdle(flow)
        assertEquals(1, platform.calls)
    }
    @Test fun cancellationBeforeReviewHandlePublicationCancelsPublishedHandleAndCreatesNothing() {
        val context = context()
        lateinit var flow: WitnessFlow
        var cancelled = 0
        val ui = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                onLocalCleanup() // This fake owns no Android UI resources.
                flow.submit(cancel(5)) { assertEquals(WitnessTerminalStatus.CANCELLED, terminal(it).status) }
                callback(true); callback(true)
                return object: WitnessUiCancellation { override fun cancel() { cancelled++ } }
            }
        }
        flow = flow(context, Platform(), ui)
        assertEquals(WitnessResult.Refused("cancelled"), run(flow, prepare()))
        awaitIdle(flow)
        assertEquals(1, cancelled)
        WitnessJournal(context, bytes(7)).use { assertEquals(WitnessResult.Missing, it.observeExisting()) }
    }
    @Test fun preparationReturnsOriginalAndRejectsConflictingEnrollment() {
        val context = context(); val flow = flow(context, Platform())
        assertTrue(run(flow, prepare()) is WitnessResult.Stored); awaitIdle(flow)
        assertTrue(run(flow, prepare()) is WitnessResult.Stored); awaitIdle(flow)
        val conflict = WitnessPrivateRequest.Prepare(w(5), w(6), "other", w(1), w(2), w(3))
        assertEquals(WitnessResult.Refused("enrollment_conflict"), run(flow, conflict)); awaitIdle(flow)
    }
    @Test fun terminalCallbackNoLongerOwnsAdmissionWhileItRuns() {
        val context = context(); val flow = flow(context, Platform()); val done = CountDownLatch(1)
        flow.submit(WitnessPrivateRequest.Identity(w(5), w(6))) {
            assertEquals(WitnessResult.Missing, run(flow, WitnessPrivateRequest.Identity(w(8), w(6))))
            done.countDown()
        }
        assertTrue(done.await(10, TimeUnit.SECONDS))
    }

    @Test fun cancelledReviewCannotGenerateAndStartedMissingKeyCannotRegenerate() {
        val context = context(); prepared(context); val platform = Platform()
        val denied = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                onLocalCleanup() // This fake owns no Android UI resources.
                callback(false); return object: WitnessUiCancellation { override fun cancel() {} }
            }
        }
        val flow = flow(context, platform, denied)
        assertEquals(WitnessResult.Refused("cancelled"), run(flow, generate())); awaitIdle(flow)
        WitnessJournal(context, bytes(7)).use { stored(it.commitGenerationStarted(1, bytes(3), bytes(4))) }
        val retry = flow(context, platform)
        assertEquals(WitnessResult.Refused("identity_incomplete"), run(retry, generate(2))); awaitIdle(retry)
        assertEquals(0, platform.calls)
    }
    @Test fun afterFenceCancellationStillDrainsExactlyOneGeneration() {
        val context = context(); prepared(context); val platform = Platform()
        lateinit var flow: WitnessFlow
        flow = WitnessFlow(context, bytes(7), Review(), platform,
            identity = { if (platform.present) WitnessKeyObservation.Present(metadata()) else WitnessKeyObservation.Absent },
            journalCheckpoint = { if (it == "before_response") flow.invalidate() })
        assertEquals(WitnessResult.Refused("cancelled"), run(flow, generate())); awaitIdle(flow)
        assertEquals(1, platform.calls)
        WitnessJournal(context, bytes(7)).use { assertEquals(WitnessPhase.GENERATED_UNVALIDATED, stored(it.observeExisting()).identity.phase) }
    }
    @Test fun generatorFailureAfterCreatingKeyReconcilesAndRetryDoesNotGenerate() {
        val context = context(); prepared(context); val platform = Platform()
        platform.generateAction = { platform.present = true; throw IllegalStateException("provider failed after creating key") }
        val flow = flow(context, platform)
        assertEquals(WitnessResult.Refused("generation_failed"), run(flow, generate())); awaitIdle(flow)
        assertTrue(run(flow, generate(3)) is WitnessResult.Stored); awaitIdle(flow)
        assertEquals(1, platform.calls)
    }
    @Test fun unexpectedAliasAfterFenceIsNotOverwritten() {
        val context = context(); prepared(context); val platform = Platform()
        val flow = WitnessFlow(context, bytes(7), Review(), platform, identity = { WitnessKeyObservation.Absent },
            journalCheckpoint = { if (it == "before_response") platform.present = true })
        assertEquals(WitnessResult.Refused("identity_incomplete"), run(flow, generate())); awaitIdle(flow)
        assertEquals(0, platform.calls)
    }
    @Test fun mismatchedOriginalChallengeAndRevisionNeverGenerate() {
        val context = context(); prepared(context); val platform = Platform()
        WitnessJournal(context, bytes(7)).use { stored(it.commitGenerationStarted(1, bytes(3), bytes(4))) }
        val flow = flow(context, platform)
        assertEquals(WitnessResult.Refused("original_identity_mismatch"), run(flow, WitnessPrivateRequest.Generate(w(5), w(6), 2, w(3), w(8)))); awaitIdle(flow)
        assertTrue(run(flow, generate(1)) is WitnessResult.Refused); awaitIdle(flow)
        assertEquals(0, platform.calls)
    }
    @Test fun lifecycleLossWhileIdentityReadDrainsSuppressesOldResult() {
        val context = context(); val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val done = CountDownLatch(1); val results = mutableListOf<WitnessResult<ByteArray>>()
        val flow = WitnessFlow(context, bytes(7), Review(), Platform(), identity = {
            entered.countDown(); assertTrue(release.await(10, TimeUnit.SECONDS)); WitnessKeyObservation.Absent
        })
        flow.submit(WitnessPrivateRequest.Identity(w(5), w(6))) { results.add(it); done.countDown() }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        try { flow.invalidate(); flow.invalidate(); assertFalse(done.await(50, TimeUnit.MILLISECONDS)); assertBusy(flow) }
        finally { release.countDown() }
        assertTrue(done.await(10, TimeUnit.SECONDS)); assertEquals(listOf(WitnessResult.Refused("cancelled")), results)
        assertEquals(WitnessResult.Missing, run(flow, WitnessPrivateRequest.Identity(w(8), w(6))))
    }

    @Test fun proofReviewCancellationUsesInternalCreationIdentityAndPromptlyDrains() {
        val context = completedContext(); val reviewEntered = CountDownLatch(1)
        val promptCancelled = CountDownLatch(1)
        val ui = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                onLocalCleanup() // This fake owns no Android UI resources.
                reviewEntered.countDown()
                return object: WitnessUiCancellation { override fun cancel() { promptCancelled.countDown() } }
            }
        }
        val flow = WitnessFlow(context, bytes(7), ui, Platform(), identity = { WitnessKeyObservation.Present(metadata()) })
        val completed = CountDownLatch(1); val results = mutableListOf<WitnessResult<ByteArray>>()
        flow.submit(proof()) { results.add(it); completed.countDown() }
        assertTrue(reviewEntered.await(10, TimeUnit.SECONDS))
        assertEquals(WitnessTerminalStatus.MISSING, terminal(run(flow, cancel(3))).status)
        assertEquals(WitnessTerminalStatus.CANCELLED, terminal(run(flow, cancel(5))).status)
        assertTrue(promptCancelled.await(2, TimeUnit.SECONDS))
        assertTrue(completed.await(2, TimeUnit.SECONDS)); awaitIdle(flow)
        assertEquals(listOf(WitnessResult.Refused("cancelled")), results)
        WitnessJournal(context, bytes(7)).use { assertTrue(it.observeExisting() is WitnessResult.Stored) }
    }
    @Test fun preparedExpiryWithoutAnotherCallbackReleasesAdmissionOnlyAfterLeaseClose() {
        val context = completedContext(); val expiry = AtomicReference<() -> Unit>()
        var now = 1L
        val flow = WitnessFlow(context, bytes(7), Review(), Platform(), identity = { WitnessKeyObservation.Present(metadata()) },
            bindingFactory = { ctx, signer, ui, valid, drained ->
                WitnessBindingCoordinator(ctx, signer, ui, sessionValid = valid, monotonicNanos = { now }, onDrained = drained,
                    scheduleExpiry = { _, task -> expiry.set(task); WitnessExpiry {} }).asFlowBinding()
            })
        val results = mutableListOf<WitnessResult<ByteArray>>(); val done = CountDownLatch(1)
        flow.submit(proof()) { results.add(it); done.countDown() }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        assertTrue(results.single() is WitnessResult.Stored)
        assertEquals("storage_busy", terminal(run(flow, WitnessPrivateRequest.Identity(w(8), w(6)))).reason)
        WitnessJournal(context, bytes(7)).use { assertEquals(WitnessResult.Refused("storage_busy"), it.observeExisting()) }
        now += TimeUnit.SECONDS.toNanos(61); expiry.get().invoke()
        awaitIdle(flow)
        WitnessJournal(context, bytes(7)).use { assertTrue(it.observeExisting() is WitnessResult.Stored) }
        assertEquals(1, results.size)
        expiry.get().invoke(); awaitIdle(flow)
    }
    @Test fun signedCallbackIsPublishedOnlyAfterBindingJournalCloses() {
        val context = completedContext()
        val key = java.security.KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val signature = Signature.getInstance("Ed25519").also { it.initSign(key.private) }
        val ui = object: Review() {
            override fun authenticate(signature: Signature, onLocalCleanup: () -> Unit, callback: (WitnessPresenceResult) -> Unit): WitnessUiCancellation {
                onLocalCleanup() // This fake owns no Android UI resources.
                callback(WitnessPresenceResult.Success(signature))
                return object: WitnessUiCancellation { override fun cancel() {} }
            }
        }
        val flow = WitnessFlow(context, bytes(7), ui, Platform(), identity = { WitnessKeyObservation.Present(metadata()) },
            bindingFactory = { ctx, signer, review, valid, drained ->
                WitnessBindingCoordinator(ctx, signer, review, object: WitnessBindingPlatform {
                    override fun prepareSignature(original: WitnessIdentityRecord) = WitnessResult.Stored(signature)
                }, valid, onDrained = drained).asFlowBinding()
            })
        val prepared = org.json.JSONObject(String(stored(run(flow, proof())), Charsets.UTF_8))
        val handle = WitnessBytes(android.util.Base64.decode(prepared.getString("handle"), android.util.Base64.DEFAULT))
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val replies = mutableListOf<WitnessResult<ByteArray>>()
        flow.submit(WitnessPrivateRequest.SignPrepared(w(5), w(6), handle)) {
            replies.add(it); entered.countDown(); assertTrue(release.await(10, TimeUnit.SECONDS))
        }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        try {
            assertTrue(replies.single() is WitnessResult.Stored)
            assertTrue(run(flow, WitnessPrivateRequest.Identity(w(8), w(6))) is WitnessResult.Stored)
            WitnessJournal(context, bytes(7)).use { assertTrue(it.observeExisting() is WitnessResult.Stored) }
        } finally { release.countDown() }
        awaitIdle(flow)
        WitnessJournal(context, bytes(7)).use { assertTrue(it.observeExisting() is WitnessResult.Stored) }
        assertEquals(1, replies.size)
    }
    @Test fun committedPreparationSurvivesLifecycleLossWithoutReleasingSuccess() {
        val context = context(); lateinit var flow: WitnessFlow
        flow = WitnessFlow(context, bytes(7), Review(), Platform(), identity = { WitnessKeyObservation.Absent },
            journalCheckpoint = { if (it == "before_response") flow.invalidate() })
        assertEquals(WitnessResult.Refused("cancelled"), run(flow, prepare())); awaitIdle(flow)
        WitnessJournal(context, bytes(7)).use { assertEquals(WitnessPhase.PREPARED, stored(it.observeExisting()).identity.phase) }
    }
    @Test fun completedIdentityAddsEnrollmentWithoutRotatingOriginalAttempt() {
        val context = completedContext(); val platform = Platform().also { it.present = true }
        val flow = flow(context, platform)
        val request = WitnessPrivateRequest.Prepare(w(5), w(6), "replica:second", w(12), w(2), w(99))
        assertTrue(run(flow, request) is WitnessResult.Stored); awaitIdle(flow)
        WitnessJournal(context, bytes(7)).use {
            val snapshot = stored(it.observeExisting())
            assertEquals(w(3), snapshot.identity.creationAttemptId)
            assertEquals(2, snapshot.enrollments.size)
            assertEquals(WitnessPhase.GENERATED_UNVALIDATED, snapshot.identity.phase)
        }
        assertEquals(0, platform.calls)
    }
    @Test fun incompleteOrCorruptPreparationRefusesBeforeReview() {
        val context = context(); prepared(context)
        val ui = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation = error("must not review")
        }
        val flow = flow(context, Platform(), ui)
        assertEquals(WitnessResult.Refused("identity_incomplete"), run(flow, WitnessPrivateRequest.Prepare(w(5), w(6), "replica:test", w(12), w(2), w(3)))); awaitIdle(flow)
        val corrupt = context()
        val directory = File(corrupt.noBackupFilesDir, "treehouse-governance-v1").also { it.mkdir() }
        val file = File(directory, "identity.sqlite3").also { it.createNewFile() }
        assertEquals(WitnessResult.Refused("incomplete_store"), run(flow(corrupt, Platform(), ui), prepare()))
        assertEquals(0L, file.length())
    }

    @Test fun refusedContinuationTokenDrainsTheActualPreparedCoordinator() {
        val context = completedContext()
        val flow = WitnessFlow(context, bytes(7), Review(), Platform(), identity = { WitnessKeyObservation.Present(metadata()) })
        assertTrue(run(flow, proof()) is WitnessResult.Stored)
        assertEquals(WitnessResult.Missing, run(flow, WitnessPrivateRequest.SignPrepared(w(5), w(6), w(99))))
        awaitIdle(flow)
        WitnessJournal(context, bytes(7)).use { assertTrue(it.observeExisting() is WitnessResult.Stored) }
    }
    @Test fun lateCancelledReviewCannotCompleteTheNextOwnerAndThrowingCallbackStillDrains() {
        val context = context(); val callbacks = java.util.concurrent.LinkedBlockingQueue<(Boolean) -> Unit>()
        val ui = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                onLocalCleanup() // This fake owns no Android UI resources.
                callbacks.put(callback); return object: WitnessUiCancellation { override fun cancel() {} }
            }
        }
        val flow = flow(context, Platform(), ui)
        flow.submit(prepare()) { throw IllegalStateException("consumer lost") }
        val old = callbacks.poll(10, TimeUnit.SECONDS)!!
        assertEquals(WitnessTerminalStatus.CANCELLED, terminal(run(flow, cancel(5))).status)
        awaitIdle(flow)
        val done = CountDownLatch(1); val results = mutableListOf<WitnessResult<ByteArray>>()
        flow.submit(prepare()) { results.add(it); done.countDown() }
        val current = callbacks.poll(10, TimeUnit.SECONDS)!!
        old(true); old(false)
        assertFalse(done.await(50, TimeUnit.MILLISECONDS))
        current(false); current(true)
        assertTrue(done.await(10, TimeUnit.SECONDS)); awaitIdle(flow)
        assertEquals(listOf(WitnessResult.Refused("cancelled")), results)
        WitnessJournal(context, bytes(7)).use { assertEquals(WitnessResult.Missing, it.observeExisting()) }
    }

    @Test fun prepareReviewAllowsIndependentJournalObservationAndRevalidatesAfterConsent() {
        val context = context(); val entered = CountDownLatch(1)
        val answer = AtomicReference<(Boolean) -> Unit>()
        val ui = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                onLocalCleanup() // This fake owns no Android UI resources.
                answer.set(callback); entered.countDown()
                return object: WitnessUiCancellation { override fun cancel() {} }
            }
        }
        val flow = flow(context, Platform(), ui); val done = CountDownLatch(1)
        val result = AtomicReference<WitnessResult<ByteArray>>()
        flow.submit(prepare()) { result.set(it); done.countDown() }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        WitnessJournal(context, bytes(7)).use {
            assertEquals(WitnessResult.Missing, it.observeExisting())
            stored(it.prepareAccepted(WitnessEnrollment(bytes(1), "changed", bytes(2), bytes(3)), bytes(3)))
        }
        answer.get().invoke(true)
        assertTrue(done.await(10, TimeUnit.SECONDS)); awaitIdle(flow)
        assertEquals(WitnessResult.Refused("enrollment_conflict"), result.get())
    }
    @Test fun absoluteReviewDeadlineIncludesBlockedHandlePublication() {
        val context = context(); val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val timeout = AtomicReference<() -> Unit>(); val cancelled = CountDownLatch(1)
        val now = java.util.concurrent.atomic.AtomicLong(1)
        val ui = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                onLocalCleanup() // This fake owns no Android UI resources.
                entered.countDown(); assertTrue(release.await(10, TimeUnit.SECONDS)); callback(true)
                return object: WitnessUiCancellation { override fun cancel() { cancelled.countDown() } }
            }
        }
        val flow = WitnessFlow(context, bytes(7), ui, Platform(), identity = { WitnessKeyObservation.Absent },
            monotonicNanos = now::get, scheduleReviewTimeout = { task -> timeout.set(task); object: WitnessUiCancellation { override fun cancel() {} } })
        val result = AtomicReference<WitnessResult<ByteArray>>(); val done = CountDownLatch(1)
        flow.submit(prepare()) { result.set(it); done.countDown() }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        now.addAndGet(TimeUnit.SECONDS.toNanos(120)); timeout.get().invoke()
        assertFalse(done.await(50, TimeUnit.MILLISECONDS))
        assertEquals("storage_busy", terminal(run(flow, WitnessPrivateRequest.Identity(w(8), w(6)))).reason)
        release.countDown(); assertTrue(cancelled.await(2, TimeUnit.SECONDS)); assertTrue(done.await(10, TimeUnit.SECONDS))
        assertEquals(WitnessResult.Refused("cancelled"), result.get()); awaitIdle(flow)
        WitnessJournal(context, bytes(7)).use { assertEquals(WitnessResult.Missing, it.observeExisting()) }
    }
    @Test fun deadlineOverrunOrBackwardsClockRefusesEvenWithAlreadyAcceptedCallback() {
        for (clockDelta in listOf(TimeUnit.SECONDS.toNanos(121), -1L)) {
            val context = context(); var now = 100L
            val ui = object: Review() {
                override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                onLocalCleanup() // This fake owns no Android UI resources.
                    callback(true); now += clockDelta
                    return object: WitnessUiCancellation { override fun cancel() {} }
                }
            }
            val flow = WitnessFlow(context, bytes(7), ui, Platform(), identity = { WitnessKeyObservation.Absent }, monotonicNanos = { now })
            assertEquals(WitnessResult.Refused("cancelled"), run(flow, prepare())); awaitIdle(flow)
            WitnessJournal(context, bytes(7)).use { assertEquals(WitnessResult.Missing, it.observeExisting()) }
        }
    }
    @Test fun duplicateOldProofCallbacksCannotResolveOrCancelReentrantSigningInvocation() {
        val context = completedContext()
        val signature = Signature.getInstance("Ed25519").also { it.initSign(java.security.KeyPairGenerator.getInstance("Ed25519").generateKeyPair().private) }
        val presence = AtomicReference<(WitnessPresenceResult) -> Unit>(); val presenceEntered = CountDownLatch(1)
        val oldCallback = AtomicReference<(WitnessResult<PreparedWitnessBinding>) -> Unit>()
        val oldResult = AtomicReference<WitnessResult<PreparedWitnessBinding>>()
        val ui = object: Review() {
            override fun authenticate(signature: Signature, onLocalCleanup: () -> Unit, callback: (WitnessPresenceResult) -> Unit): WitnessUiCancellation {
                onLocalCleanup() // This fake owns no Android UI resources.
                presence.set(callback); presenceEntered.countDown()
                return object: WitnessUiCancellation { override fun cancel() {} }
            }
        }
        val flow = WitnessFlow(context, bytes(7), ui, Platform(), identity = { WitnessKeyObservation.Present(metadata()) },
            bindingFactory = { ctx, signer, review, valid, drained ->
                val backend = WitnessBindingCoordinator(ctx, signer, review, object: WitnessBindingPlatform {
                    override fun prepareSignature(original: WitnessIdentityRecord) = WitnessResult.Stored(signature)
                }, valid, onDrained = drained).asFlowBinding()
                object: WitnessFlowBinding {
                    override fun prepare(request: WitnessBindingRequest, callback: (WitnessResult<PreparedWitnessBinding>) -> Unit) {
                        oldCallback.set(callback)
                        backend.prepare(request) { result -> oldResult.set(result); callback(result); callback(result); callback(WitnessResult.Refused("late_prepare")) }
                    }
                    override fun sign(handle: WitnessBindingHandle, callback: (WitnessResult<SignedWitnessBinding>) -> Unit) = backend.sign(handle, callback)
                    override fun cancel(operationId: ByteArray, sessionDigest: ByteArray) = backend.cancel(operationId, sessionDigest)
                }
            })
        val preparedReplies = mutableListOf<WitnessResult<ByteArray>>(); val signedReplies = mutableListOf<WitnessResult<ByteArray>>()
        val signedDone = CountDownLatch(1)
        flow.submit(proof()) { prepared ->
            preparedReplies.add(prepared)
            val handle = WitnessBytes(android.util.Base64.decode(org.json.JSONObject(String(stored(prepared), Charsets.UTF_8)).getString("handle"), android.util.Base64.DEFAULT))
            flow.submit(WitnessPrivateRequest.SignPrepared(w(5), w(6), handle)) { signedReplies.add(it); signedDone.countDown() }
            throw AssertionError("prepared consumer failed after starting signing")
        }
        assertTrue(presenceEntered.await(10, TimeUnit.SECONDS))
        oldCallback.get().invoke(oldResult.get()); oldCallback.get().invoke(WitnessResult.Refused("late_prepare"))
        assertFalse(signedDone.await(50, TimeUnit.MILLISECONDS))
        presence.get().invoke(WitnessPresenceResult.Success(signature))
        assertTrue(signedDone.await(10, TimeUnit.SECONDS)); awaitIdle(flow)
        assertEquals(1, preparedReplies.size); assertEquals(1, signedReplies.size)
        assertTrue(signedReplies.single() is WitnessResult.Stored)
    }

    @Test fun backendCompletionDoesNotPublishTerminalUntilOwnedLocalCleanupAcknowledges() {
        val context = context(); val cleanup = AtomicReference<() -> Unit>(); val committed = CountDownLatch(1)
        val ui = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                cleanup.set(onLocalCleanup); callback(true)
                return object: WitnessUiCancellation { override fun cancel() {} }
            }
        }
        val flow = WitnessFlow(context, bytes(7), ui, Platform(), identity = { WitnessKeyObservation.Absent },
            journalCheckpoint = { if (it == "before_response") committed.countDown() })
        val done = CountDownLatch(1); val result = AtomicReference<WitnessResult<ByteArray>>()
        flow.submit(prepare()) { result.set(it); done.countDown() }
        assertTrue(committed.await(10, TimeUnit.SECONDS)); assertFalse(done.await(50, TimeUnit.MILLISECONDS))
        repeat(20) { assertBusy(flow) }
        cleanup.get().invoke(); assertTrue(done.await(10, TimeUnit.SECONDS)); assertTrue(result.get() is WitnessResult.Stored)
        assertTrue(run(flow, WitnessPrivateRequest.Identity(w(8), w(6))) is WitnessResult.Stored)
    }

    @Test fun duplicateOldCleanupCannotReleaseSuccessorAndMissingCleanupStaysClosed() {
        val context = completedContext(); val cleanups = java.util.concurrent.LinkedBlockingQueue<() -> Unit>()
        val ui = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                cleanups.put(onLocalCleanup); callback(true)
                return object: WitnessUiCancellation { override fun cancel() {} }
            }
        }
        val flow = flow(context, Platform().also { it.present = true }, ui)
        fun request(id: Int) = WitnessPrivateRequest.Prepare(w(5), w(6), "replica:test", w(id), w(2), w(3))
        val firstDone = CountDownLatch(1); flow.submit(request(12)) { firstDone.countDown() }
        val old = cleanups.poll(10, TimeUnit.SECONDS)!!
        assertBusy(flow); old(); assertTrue(firstDone.await(10, TimeUnit.SECONDS))
        val nextDone = CountDownLatch(1); flow.submit(request(13)) { nextDone.countDown() }
        val next = cleanups.poll(10, TimeUnit.SECONDS)!!
        repeat(20) { old(); assertBusy(flow) }; assertFalse(nextDone.await(50, TimeUnit.MILLISECONDS))
        next(); next(); assertTrue(nextDone.await(10, TimeUnit.SECONDS)); awaitIdle(flow)
    }

    @Test fun cancelledUiCleanupFailureDoesNotReopenEvenAfterBackendDrain() {
        val context = context(); val entered = CountDownLatch(1)
        val ui = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                entered.countDown()
                return object: WitnessUiCancellation { override fun cancel() { throw IllegalStateException("local cleanup failed") } }
            }
        }
        val flow = flow(context, Platform(), ui); val done = CountDownLatch(1)
        flow.submit(prepare()) { done.countDown() }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        val cancelDone = CountDownLatch(1); flow.submit(cancel(5)) { cancelDone.countDown() }
        assertFalse(done.await(50, TimeUnit.MILLISECONDS)); assertFalse(cancelDone.await(50, TimeUnit.MILLISECONDS))
        repeat(20) { assertBusy(flow) }
        WitnessJournal(context, bytes(7)).use { assertEquals(WitnessResult.Missing, it.observeExisting()) }
    }
    @Test fun preparedExpiryBeforeReviewCleanupPublishesOnlyExpiredTerminalAfterCleanup() {
        val context = completedContext(); val cleanup = AtomicReference<() -> Unit>()
        val expiry = AtomicReference<() -> Unit>(); val expiryReady = CountDownLatch(1); var now = 1L
        val ui = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                cleanup.set(onLocalCleanup); callback(true)
                return object: WitnessUiCancellation { override fun cancel() {} }
            }
        }
        val flow = WitnessFlow(context, bytes(7), ui, Platform(), identity = { WitnessKeyObservation.Present(metadata()) },
            bindingFactory = { ctx, signer, review, valid, drained ->
                WitnessBindingCoordinator(ctx, signer, review, sessionValid = valid, monotonicNanos = { now }, onDrained = drained,
                    scheduleExpiry = { _, task -> expiry.set(task); expiryReady.countDown(); WitnessExpiry {} }).asFlowBinding()
            })
        val done = CountDownLatch(1); val result = AtomicReference<WitnessResult<ByteArray>>()
        flow.submit(proof()) { result.set(it); done.countDown() }
        assertTrue(expiryReady.await(10, TimeUnit.SECONDS)); assertFalse(done.await(50, TimeUnit.MILLISECONDS))
        now += TimeUnit.SECONDS.toNanos(61); expiry.get().invoke()
        repeat(20) { assertBusy(flow) }; assertFalse(done.await(50, TimeUnit.MILLISECONDS))
        cleanup.get().invoke(); assertTrue(done.await(10, TimeUnit.SECONDS))
        assertEquals(WitnessResult.Refused("binding_timeout"), result.get()); awaitIdle(flow)
    }

    @Test fun timeoutWhileHandlePublicationBlockedRequiresLaterCleanupAcknowledgement() {
        val context = context(); val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val cleanup = AtomicReference<() -> Unit>(); val timer = AtomicReference<() -> Unit>()
        val ui = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                cleanup.set(onLocalCleanup); entered.countDown(); assertTrue(release.await(10, TimeUnit.SECONDS))
                return object: WitnessUiCancellation { override fun cancel() {} }
            }
        }
        val flow = WitnessFlow(context, bytes(7), ui, Platform(), identity = { WitnessKeyObservation.Absent },
            scheduleReviewTimeout = { task -> timer.set(task); object: WitnessUiCancellation { override fun cancel() {} } })
        val done = CountDownLatch(1)
        flow.submit(prepare()) { done.countDown() }
        assertTrue(entered.await(10, TimeUnit.SECONDS)); timer.get().invoke()
        assertFalse(done.await(50, TimeUnit.MILLISECONDS)); assertBusy(flow)
        release.countDown()
        repeat(20) { assertBusy(flow) }
        cleanup.get().invoke(); assertTrue(done.await(10, TimeUnit.SECONDS)); awaitIdle(flow)
    }
    private fun assertBusy(flow: WitnessFlow) {
        val result = run(flow, WitnessPrivateRequest.Identity(w(8), w(6)))
        assertEquals("storage_busy", (result as? WitnessResult.Stored)?.let { WitnessPrivateProtocol.decodeTerminal(it.value)?.reason })
    }

    @Test fun storedTerminalCallbackCanImmediatelyAdmitNextOperation() {
        val context = context(); val flow = flow(context, Platform())
        val next = AtomicReference<WitnessResult<ByteArray>>(); val done = CountDownLatch(1)
        flow.submit(prepare()) { first ->
            assertTrue(first is WitnessResult.Stored)
            flow.submit(WitnessPrivateRequest.Identity(w(8), w(6))) { next.set(it); done.countDown() }
        }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        assertEquals("identity", org.json.JSONObject(String(stored(next.get()), Charsets.UTF_8)).getString("kind"))
        assertFalse(org.json.JSONObject(String(stored(next.get()), Charsets.UTF_8)).optString("reason") == "storage_busy")
    }
    @Test fun cancellationReplyWaitsForDrainThenCanAdmitNextOperationDespiteThrowingOriginalCallback() {
        val context = context(); prepared(context); val platform = Platform()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        platform.generateAction = { entered.countDown(); assertTrue(release.await(10, TimeUnit.SECONDS)) }
        val flow = flow(context, platform)
        val cancelled = CountDownLatch(1); val nextDone = CountDownLatch(1)
        val next = AtomicReference<WitnessResult<ByteArray>>()
        flow.submit(generate()) { throw AssertionError("original consumer failed") }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        flow.submit(cancel(5)) { response ->
            assertEquals(WitnessTerminalStatus.CANCELLED, terminal(response).status)
            cancelled.countDown()
            flow.submit(WitnessPrivateRequest.Identity(w(8), w(6))) { next.set(it); nextDone.countDown() }
        }
        try { assertFalse(cancelled.await(100, TimeUnit.MILLISECONDS)) }
        finally { release.countDown() }
        assertTrue(cancelled.await(10, TimeUnit.SECONDS)); assertTrue(nextDone.await(10, TimeUnit.SECONDS))
        assertFalse(org.json.JSONObject(String(stored(next.get()), Charsets.UTF_8)).optString("reason") == "storage_busy")
    }

    @Test fun preparedWaitsForReviewCleanupAndSignedCallbackWithoutDrainCannotPublish() {
        val context = completedContext(); val reviewCleanup = AtomicReference<() -> Unit>()
        val reviewed = CountDownLatch(1); val preparedReply = CountDownLatch(1)
        val drain = AtomicReference<() -> Unit>(); val drainReady = CountDownLatch(1)
        val signedReply = CountDownLatch(1); val nextReply = CountDownLatch(1)
        val signature = Signature.getInstance("Ed25519").also { it.initSign(java.security.KeyPairGenerator.getInstance("Ed25519").generateKeyPair().private) }
        val ui = object: Review() {
            override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                reviewCleanup.set(onLocalCleanup); reviewed.countDown(); callback(true)
                return object: WitnessUiCancellation { override fun cancel() {} }
            }
            override fun authenticate(signature: Signature, onLocalCleanup: () -> Unit, callback: (WitnessPresenceResult) -> Unit): WitnessUiCancellation {
                onLocalCleanup(); callback(WitnessPresenceResult.Success(signature))
                return object: WitnessUiCancellation { override fun cancel() {} }
            }
        }
        val flow = WitnessFlow(context, bytes(7), ui, Platform(), identity = { WitnessKeyObservation.Present(metadata()) },
            bindingFactory = { ctx, signer, review, valid, drained ->
                WitnessBindingCoordinator(ctx, signer, review, object: WitnessBindingPlatform {
                    override fun prepareSignature(original: WitnessIdentityRecord) = WitnessResult.Stored(signature)
                }, valid, onDrained = { drain.set(drained); drainReady.countDown() }).asFlowBinding()
            })
        val next = AtomicReference<WitnessResult<ByteArray>>()
        flow.submit(proof()) { prepared ->
            val handle = WitnessBytes(android.util.Base64.decode(org.json.JSONObject(String(stored(prepared), Charsets.UTF_8)).getString("handle"), android.util.Base64.DEFAULT))
            preparedReply.countDown()
            flow.submit(WitnessPrivateRequest.SignPrepared(w(5), w(6), handle)) {
                assertTrue(it is WitnessResult.Stored); signedReply.countDown()
                flow.submit(WitnessPrivateRequest.Identity(w(8), w(6))) { identity -> next.set(identity); nextReply.countDown() }
            }
        }
        assertTrue(reviewed.await(10, TimeUnit.SECONDS)); assertFalse(preparedReply.await(50, TimeUnit.MILLISECONDS))
        assertEquals("storage_busy", terminal(run(flow, WitnessPrivateRequest.SignPrepared(w(5), w(6), w(99)))).reason)
        reviewCleanup.get().invoke(); assertTrue(preparedReply.await(10, TimeUnit.SECONDS))
        assertTrue(drainReady.await(10, TimeUnit.SECONDS)); assertFalse(signedReply.await(50, TimeUnit.MILLISECONDS))
        WitnessJournal(context, bytes(7)).use { assertTrue(it.observeExisting() is WitnessResult.Stored) }
        assertBusy(flow)
        drain.get().invoke(); assertTrue(signedReply.await(10, TimeUnit.SECONDS)); assertTrue(nextReply.await(10, TimeUnit.SECONDS))
        assertEquals("identity", org.json.JSONObject(String(stored(next.get()), Charsets.UTF_8)).getString("kind"))
        assertFalse(org.json.JSONObject(String(stored(next.get()), Charsets.UTF_8)).optString("reason") == "storage_busy")
        drain.get().invoke(); reviewCleanup.get().invoke(); awaitIdle(flow)
    }
    @Test fun throwingCancelReplyCannotDisturbSuccessorAdmittedByOriginalTerminal() {
        val context = context(); prepared(context); val platform = Platform()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        platform.generateAction = { entered.countDown(); assertTrue(release.await(10, TimeUnit.SECONDS)) }
        val flow = flow(context, platform); val next = AtomicReference<WitnessResult<ByteArray>>()
        val nextDone = CountDownLatch(1); val cancelDone = CountDownLatch(1)
        flow.submit(generate()) { result ->
            assertEquals(WitnessResult.Refused("cancelled"), result)
            flow.submit(WitnessPrivateRequest.Identity(w(8), w(6))) { next.set(it); nextDone.countDown() }
        }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        flow.submit(cancel(5)) { cancelDone.countDown(); throw AssertionError("cancel consumer failed") }
        release.countDown()
        assertTrue(cancelDone.await(10, TimeUnit.SECONDS)); assertTrue(nextDone.await(10, TimeUnit.SECONDS))
        assertTrue(next.get() is WitnessResult.Stored)
        assertFalse(org.json.JSONObject(String(stored(next.get()), Charsets.UTF_8)).optString("reason") == "storage_busy")
    }

    private fun completedContext(): Context {
        val context = context(); prepared(context)
        WitnessJournal(context, bytes(7)).use { journal ->
            val fence = stored(journal.commitGenerationStarted(1, bytes(3), bytes(4)))
            stored(journal.finishOriginalGeneration(fence, metadata()))
        }
        return context
    }
    private fun proof() = WitnessPrivateRequest.Proof(w(5), w(6), 3, "replica:test", w(1), w(2), w(10), w(11))

    private fun flow(context: Context, platform: Platform, ui: WitnessReviewUi = Review()) = WitnessFlow(context, bytes(7), ui, platform,
        identity = { if (platform.present) WitnessKeyObservation.Present(metadata()) else WitnessKeyObservation.Absent })
    private fun prepared(context: Context) { WitnessJournal(context, bytes(7)).use { stored(it.prepareAccepted(WitnessEnrollment(bytes(1), "replica:test", bytes(2), bytes(3)), bytes(3))) } }
    private fun awaitIdle(flow: WitnessFlow) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            val result = run(flow, WitnessPrivateRequest.Identity(w(20), w(6)))
            if (result !is WitnessResult.Stored || WitnessPrivateProtocol.decodeTerminal(result.value)?.reason != "storage_busy") return
            Thread.yield()
        }
        fail("flow did not drain")
    }
    private fun run(flow: WitnessFlow, request: WitnessPrivateRequest): WitnessResult<ByteArray> {
        val done = CountDownLatch(1); val result = AtomicReference<WitnessResult<ByteArray>>()
        flow.submit(request) { result.set(it); done.countDown() }
        assertTrue(done.await(10, TimeUnit.SECONDS)); return result.get()
    }
    private open class Review: WitnessReviewUi {
        override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit, callback: (Boolean) -> Unit): WitnessUiCancellation {
                onLocalCleanup() // This fake owns no Android UI resources.
            callback(true); return object: WitnessUiCancellation { override fun cancel() {} }
        }
        override fun authenticate(signature: Signature, onLocalCleanup: () -> Unit, callback: (WitnessPresenceResult) -> Unit): WitnessUiCancellation = error("no signing")
    }
    private class Platform: WitnessGenerationPlatform {
        @Volatile var present = false
        var calls = 0
        var generateAction: () -> Unit = {}
        override fun observe(original: WitnessIdentityRecord): WitnessKeyObservation = if (present) WitnessKeyObservation.Present(metadata()) else WitnessKeyObservation.Absent
        override fun generate(original: WitnessIdentityRecord, fence: GenerationFence) {
            assertEquals(WitnessPhase.GENERATION_STARTED, original.phase)
            calls++; generateAction(); present = true
        }
    }
    private fun context(): Context {
        val root = temporary.newFolder().also { WitnessDirectoryOsShadow.registerRoot(it) }
        return object: ContextWrapper(RuntimeEnvironment.getApplication()) {
            override fun getDataDir(): File = root
            override fun getNoBackupFilesDir(): File = File(root, "no_backup").also { it.mkdirs() }
        }
    }
    private fun prepare() = WitnessPrivateRequest.Prepare(w(5), w(6), "replica:test", w(1), w(2), w(3))
    private fun generate(revision: Long = 1) = WitnessPrivateRequest.Generate(w(5), w(6), revision, w(3), w(4))
    private fun cancel(target: Int) = WitnessPrivateRequest.Cancel(w(10), w(6), w(target))
    private fun terminal(value: WitnessResult<ByteArray>) = WitnessPrivateProtocol.decodeTerminal(stored(value))!!
    private fun <T> stored(value: WitnessResult<T>): T { assertTrue("$value", value is WitnessResult.Stored); return (value as WitnessResult.Stored).value }
    companion object {
        private fun bytes(n: Int) = ByteArray(32) { n.toByte() }
        private fun w(n: Int) = WitnessBytes(bytes(n))
        private fun metadata() = CapturedWitnessIdentity(bytes(9), byteArrayOf(0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00)+bytes(9), bytes(7), "1", listOf(byteArrayOf(1,2,3)))
    }
}
