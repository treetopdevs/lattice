package dev.treetop.lattice.treehouse.witness

import android.content.Context
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Trusted native platform boundary; synthetic implementations belong only in tests. */
internal interface WitnessGenerationPlatform {
    fun observe(original: WitnessIdentityRecord): WitnessKeyObservation
    fun generate(original: WitnessIdentityRecord, fence: GenerationFence)
}

/** Owned internal fields; a later Rust bridge supplies actual native operation/session identity. */
internal class WitnessGenerationRequest(val expectedRevision: Long, creationAttempt: ByteArray,
    challenge: ByteArray, operationId: ByteArray, session: ByteArray) {
    val creationAttempt = witness32(creationAttempt)
    val challenge = witness32(challenge)
    val operationId = witness32(operationId)
    val session = witness32(session)
    init { require(expectedRevision >= 0) }
}

/**
 * One original generation attempt. Cancellation remains independently dispatchable while blocking
 * platform work drains. Its journal lease is released only after original metadata reconciliation.
 * No witness plugin, public command, signing or eligibility surface is introduced here.
 */
internal class WitnessGenerationCoordinator(private val context: Context, signer: ByteArray,
    private val ui: WitnessReviewUi,
    private val platform: WitnessGenerationPlatform = FixedGenerationPlatform(context),
    private val sessionValid: (WitnessBytes) -> Boolean,
    private val journalCheckpoint: (String) -> Unit = {}) {
    private val expectedSigner = witness32(signer)
    private val active = AtomicReference<Attempt?>(null)

    private class Attempt(val request: WitnessGenerationRequest) {
        val cancelled = AtomicBoolean(false)
        val review = CompletableFuture<Boolean>()
        val cancellation = AtomicReference<WitnessUiCancellation?>(null)
    }

    fun generate(request: WitnessGenerationRequest, callback: (WitnessResult<WitnessSnapshot>) -> Unit) {
        val attempt = Attempt(request)
        if (!active.compareAndSet(null, attempt)) {
            callback(WitnessResult.Refused("storage_busy"))
            return
        }
        worker.execute {
            val result = try {
                WitnessJournal(context, expectedSigner.copyBytes(), journalCheckpoint).use { journal ->
                    perform(attempt, journal)
                }
            } catch (error: Exception) {
                WitnessResult.Refused(if (error is Failure) error.reason else "generation_failed")
            }
            // use/close above has drained storage and platform work before another attempt can enter.
            active.compareAndSet(attempt, null)
            val released = if (isCurrent(attempt)) result else WitnessResult.Refused("cancelled")
            callback(released)
        }
    }

    fun cancel(operationId: ByteArray, session: ByteArray): Boolean {
        if (operationId.size != 32 || session.size != 32) return false
        val attempt = active.get() ?: return false
        if (attempt.request.operationId != WitnessBytes(operationId) || attempt.request.session != WitnessBytes(session)) return false
        attempt.cancelled.set(true)
        attempt.cancellation.get()?.cancel()
        attempt.review.complete(false)
        return true
    }

    private fun perform(attempt: Attempt, journal: WitnessJournal): WitnessResult<WitnessSnapshot> {
        requireCurrent(attempt)
        val request = attempt.request
        var snapshot = stored(journal.retainExistingForAttempt(request.expectedRevision, request.creationAttempt.copyBytes()))
        val original = snapshot.identity
        if (original.generationChallenge != null && original.generationChallenge != request.challenge) throw Failure("original_identity_mismatch")
        val enrollment = snapshot.enrollments.firstOrNull() ?: throw Failure("identity_incomplete")
        val details = WitnessReviewDetails.generate(enrollment.replica, enrollment.enrollmentId.copyBytes(),
            enrollment.recipient.copyBytes(), original.creationAttemptId.copyBytes(), request.challenge.copyBytes())
        val cancellation = ui.review(details) { attempt.review.complete(it) }
        attempt.cancellation.set(cancellation)
        if (!isCurrent(attempt)) { cancellation.cancel(); attempt.review.complete(false) }
        val accepted = try { attempt.review.get(120, TimeUnit.SECONDS) } catch (_: Exception) {
            cancellation.cancel()
            false
        }
        if (!accepted) throw Failure("cancelled")
        requireCurrent(attempt)
        // The held lease makes this a stable exact revision and original-attempt check after review.
        snapshot = stored(journal.retainExistingForAttempt(original.revision, request.creationAttempt.copyBytes()))
        val observed = platform.observe(snapshot.identity)
        if (snapshot.identity.phase != WitnessPhase.PREPARED) {
            val metadata = present(observed)
            val completed = stored(journal.reconcileOriginalGeneration(snapshot.identity.revision,
                request.creationAttempt.copyBytes(), request.challenge.copyBytes(), metadata))
            requireCurrent(attempt)
            return WitnessResult.Stored(completed)
        }
        when (observed) {
            WitnessKeyObservation.Absent -> Unit
            is WitnessKeyObservation.Present -> throw Failure("identity_incomplete")
            is WitnessKeyObservation.Refused -> throw Failure(observed.reason)
        }
        requireCurrent(attempt)
        val fence = stored(journal.commitGenerationStarted(snapshot.identity.revision,
            request.creationAttempt.copyBytes(), request.challenge.copyBytes()))
        snapshot = stored(journal.retainExistingForAttempt(fence.revision, request.creationAttempt.copyBytes()))
        // Accepted consent plus the durable fence commits this one invocation. Cancellation now
        // suppresses release, while the native operation and original metadata still drain.
        var generatorFailed = false
        try { platform.generate(snapshot.identity, fence) } catch (_: Exception) { generatorFailed = true }
        // Do not abort this completion on cancellation/session loss: a generated key must retain its
        // original public metadata, and no competing native attempt may enter before this drains.
        val metadata = present(platform.observe(snapshot.identity))
        val completed = stored(journal.finishOriginalGeneration(fence, metadata))
        requireCurrent(attempt)
        return if (generatorFailed) WitnessResult.Refused("generation_failed") else WitnessResult.Stored(completed)
    }

    private fun present(observation: WitnessKeyObservation): CapturedWitnessIdentity = when (observation) {
        is WitnessKeyObservation.Present -> observation.metadata
        WitnessKeyObservation.Absent -> throw Failure("identity_incomplete")
        is WitnessKeyObservation.Refused -> throw Failure(observation.reason)
    }
    private fun isCurrent(attempt: Attempt): Boolean = !attempt.cancelled.get() && try { sessionValid(attempt.request.session) } catch (_: Exception) { false }
    private fun requireCurrent(attempt: Attempt) { if (!isCurrent(attempt)) throw Failure("cancelled") }
    private fun <T> stored(result: WitnessResult<T>): T = when (result) {
        is WitnessResult.Stored -> result.value
        is WitnessResult.Refused -> throw Failure(result.reason)
        WitnessResult.Missing -> throw Failure("identity_incomplete")
    }
    private class Failure(val reason: String): Exception(reason)
    private companion object {
        val worker = Executors.newCachedThreadPool { task -> Thread(task, "treehouse-witness-generation").apply { isDaemon = true } }
    }
}

private class FixedGenerationPlatform(context: Context): WitnessGenerationPlatform {
    private val provider = AndroidWitnessProvider(context)
    override fun observe(original: WitnessIdentityRecord): WitnessKeyObservation = provider.observeFixedIdentity(original)
    override fun generate(original: WitnessIdentityRecord, fence: GenerationFence) {
        require(original.revision == fence.revision && original.creationAttemptId == fence.creationAttemptId && original.generationChallenge == fence.generationChallenge)
        val spec = provider.originalGenerationSpec(original, fence.creationAttemptId.copyBytes(), fence.generationChallenge.copyBytes())
            ?: throw IllegalStateException("unsupported_profile")
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
    }
}
