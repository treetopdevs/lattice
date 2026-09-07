package dev.treetop.lattice.treehouse.witness

import android.content.Context
import java.security.SecureRandom
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal class WitnessPreparationRequest(operationId: ByteArray, sessionDigest: ByteArray,
    val replica: String, enrollmentId: ByteArray, recipient: ByteArray) {
    val operationId = witness32(operationId)
    val sessionDigest = witness32(sessionDigest)
    val enrollmentId = witness32(enrollmentId)
    val recipient = witness32(recipient)
    init { witnessUtf8(replica, 512) }
}

internal class PreparedWitnessCreation internal constructor(
    val enrollment: WitnessEnrollment,
    val creationAttemptId: WitnessBytes,
    val revision: Long,
)

/** Reviews one fixed enrollment and durably prepares it without touching the platform key. */
internal class WitnessPreparationCoordinator(
    private val context: Context,
    signer: ByteArray,
    private val ui: WitnessReviewUi,
    private val sessionValid: (WitnessBytes) -> Boolean,
    private val random32: () -> ByteArray = { ByteArray(32).also(SecureRandom()::nextBytes) },
    private val journalCheckpoint: (String) -> Unit = {},
) {
    private val expectedSigner = witness32(signer)
    private val active = AtomicReference<Attempt?>(null)
    private val lifecycle = Any()
    private enum class State { RUNNING, DELIVERING, TERMINAL }
    private class Attempt(val request: WitnessPreparationRequest) {
        val state = AtomicReference(State.RUNNING)
        val cancelled = AtomicBoolean(false)
        val review = CompletableFuture<Boolean>()
        val cancellation = AtomicReference<WitnessUiCancellation?>(null)
    }

    fun prepare(request: WitnessPreparationRequest,
        callback: (WitnessResult<PreparedWitnessCreation>) -> Unit) {
        val attempt = Attempt(request)
        if (!active.compareAndSet(null, attempt)) {
            callback(WitnessResult.Refused("storage_busy")); return
        }
        worker.execute {
            val computed = try {
                WitnessJournal(context, expectedSigner.copyBytes(), journalCheckpoint).use { journal ->
                    val observed = journal.observeExisting()
                    requireCurrent(attempt)
                    val existing = (observed as? WitnessResult.Stored)?.value
                    val found = existing?.enrollments?.find { it.enrollmentId == request.enrollmentId }
                    val snapshot = if (found != null) {
                        if (found.replica != request.replica || found.recipient != request.recipient)
                            throw Failure("enrollment_conflict")
                        requireCurrent(attempt)
                        existing
                    } else {
                        if (existing != null && existing.identity.phase != WitnessPhase.GENERATED_UNVALIDATED)
                            throw Failure("identity_incomplete")
                        val creationAttempt = existing?.identity?.creationAttemptId ?: witness32(random32())
                        val enrollment = WitnessEnrollment(request.enrollmentId.copyBytes(), request.replica,
                            request.recipient.copyBytes(), creationAttempt.copyBytes())
                        val details = WitnessReviewDetails.prepareCreation(request.replica,
                            request.enrollmentId.copyBytes(), request.recipient.copyBytes())
                        attempt.cancellation.set(ui.review(details) { attempt.review.complete(it) })
                        if (!attempt.review.get(120, TimeUnit.SECONDS)) throw Failure("cancelled")
                        requireCurrent(attempt)
                        stored(journal.prepareAccepted(enrollment, creationAttempt.copyBytes()))
                    }
                    snapshot to null
                }
            } catch (error: Exception) {
                null to WitnessResult.Refused(if (error is Failure) error.reason
                    else if (error is TimeoutException) "cancelled" else "preparation_failed")
            }
            val result: WitnessResult<PreparedWitnessCreation> = computed.second ?: run {
                val snapshot = checkNotNull(computed.first)
                val enrollment = snapshot.enrollments.single { it.enrollmentId == request.enrollmentId }
                WitnessResult.Stored(PreparedWitnessCreation(enrollment,
                    snapshot.identity.creationAttemptId, snapshot.identity.revision))
            }
            val deliver = synchronized(lifecycle) {
                if (isCurrent(attempt) && attempt.state.compareAndSet(State.RUNNING, State.DELIVERING)) result
                else {
                    attempt.state.set(State.TERMINAL)
                    WitnessResult.Refused("cancelled")
                }
            }
            try { callback(deliver) } finally {
                synchronized(lifecycle) { attempt.state.set(State.TERMINAL); active.compareAndSet(attempt, null) }
            }
        }
    }

    fun cancel(operationId: ByteArray, sessionDigest: ByteArray): Boolean {
        if (operationId.size != 32 || sessionDigest.size != 32) return false
        val attempt = synchronized(lifecycle) {
            val current = active.get() ?: return false
            if (current.request.operationId != WitnessBytes(operationId) ||
                current.request.sessionDigest != WitnessBytes(sessionDigest) || current.state.get() != State.RUNNING)
                return false
            current.cancelled.set(true)
            current
        }
        attempt.cancellation.get()?.cancel()
        attempt.review.complete(false)
        return true
    }

    private fun isCurrent(attempt: Attempt) = active.get() === attempt && !attempt.cancelled.get() &&
        try { sessionValid(attempt.request.sessionDigest) } catch (_: Exception) { false }
    private fun requireCurrent(attempt: Attempt) { if (!isCurrent(attempt)) throw Failure("cancelled") }
    private fun <T> stored(result: WitnessResult<T>): T = when (result) {
        is WitnessResult.Stored -> result.value
        is WitnessResult.Refused -> throw Failure(result.reason)
        WitnessResult.Missing -> throw Failure("identity_incomplete")
    }
    private class Failure(val reason: String): Exception(reason)
    companion object {
        private val worker = Executors.newCachedThreadPool { task ->
            Thread(task, "treehouse-witness-preparation").apply { isDaemon = true }
        }
    }
}
