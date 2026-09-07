package dev.treetop.lattice.treehouse.witness

import android.content.Context
import java.security.MessageDigest
import java.security.Signature
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal class WitnessBindingRequest(val expectedRevision: Long, val replica: String,
    enrollmentId: ByteArray, recipient: ByteArray, validatorNonce: ByteArray,
    attemptId: ByteArray, nativeNonce: ByteArray, sessionDigest: ByteArray) {
    val enrollmentId = witness32(enrollmentId)
    val recipient = witness32(recipient)
    val validatorNonce = witness32(validatorNonce)
    val attemptId = witness32(attemptId)
    val nativeNonce = witness32(nativeNonce)
    val sessionDigest = witness32(sessionDigest)
    init { require(expectedRevision > 0); witnessUtf8(replica, 512) }
}

internal interface WitnessBindingHandle

internal class PreparedWitnessBinding internal constructor(
    val handle: WitnessBindingHandle,
    val claim: PublicBindingClaim,
    val remainingMillis: Long,
)

internal class SignedWitnessBinding internal constructor(
    val claim: PublicBindingClaim,
    signature: ByteArray,
) {
    private val ownedSignature = WitnessBytes(signature.also { require(it.size == 64) { "invalid_signature" } })
    val signature: ByteArray get() = ownedSignature.copyBytes()
}

internal interface WitnessBindingPlatform {
    fun prepareSignature(original: WitnessIdentityRecord): WitnessResult<Signature>
}

internal fun interface WitnessExpiry { fun cancel() }

/** One durable consent and one exact fixed-key CryptoObject operation. */
internal class WitnessBindingCoordinator(
    private val context: Context,
    signer: ByteArray,
    private val ui: WitnessReviewUi,
    private val platform: WitnessBindingPlatform = FixedBindingPlatform(context),
    private val sessionValid: (WitnessBytes) -> Boolean,
    private val monotonicNanos: () -> Long = System::nanoTime,
    private val journalCheckpoint: (String) -> Unit = {},
    private val lifecycleCheckpoint: (String) -> Unit = {},
    private val onDrained: () -> Unit = {},
    private val scheduleExpiry: (Long, () -> Unit) -> WitnessExpiry = { delay, task ->
        val future = timer.schedule(task, delay, TimeUnit.MILLISECONDS)
        WitnessExpiry { future.cancel(false) }
    },
) {
    private val expectedSigner = witness32(signer)
    private val active = AtomicReference<Attempt?>(null)
    private val lifecycle = Any()

    private enum class State { REVIEW, PREPARED, PREPARE_DELIVERING, SIGNING, TERMINAL }
    private inner class Handle : WitnessBindingHandle
    private inner class Attempt(val request: WitnessBindingRequest) {
        val handle = Handle()
        val state = AtomicReference(State.REVIEW)
        val cancelled = AtomicBoolean(false)
        val review = CompletableFuture<Boolean>()
        val presence = CompletableFuture<WitnessPresenceResult>()
        val cancellation = AtomicReference<WitnessUiCancellation?>(null)
        lateinit var journal: WitnessJournal
        lateinit var claim: PublicBindingClaim
        var consentRevision = -1L
        var consentStarted = Long.MIN_VALUE
        var expiry: WitnessExpiry? = null
        var expiryPending = false
        fun closeJournal() { if (::journal.isInitialized) journal.close() }
    }

    fun prepareBinding(request: WitnessBindingRequest,
        callback: (WitnessResult<PreparedWitnessBinding>) -> Unit) {
        val attempt = Attempt(request)
        if (!active.compareAndSet(null, attempt)) {
            callback(WitnessResult.Refused("storage_busy"))
            return
        }
        worker.execute {
            var retained = false
            val result = try {
                attempt.journal = WitnessJournal(context, expectedSigner.copyBytes(), journalCheckpoint)
                val snapshot = stored(attempt.journal.observeExisting())
                requireCurrent(attempt)
                if (snapshot.identity.revision != request.expectedRevision ||
                    snapshot.identity.phase != WitnessPhase.GENERATED_UNVALIDATED) throw Failure("stale_revision")
                val enrollment = snapshot.enrollments.singleOrNull { it.enrollmentId == request.enrollmentId }
                    ?: throw Failure("enrollment_mismatch")
                if (enrollment.replica != request.replica || enrollment.recipient != request.recipient)
                    throw Failure("enrollment_mismatch")
                val metadata = snapshot.identity.metadata ?: throw Failure("identity_incomplete")
                val challenge = snapshot.identity.generationChallenge ?: throw Failure("identity_incomplete")
                val digest = MessageDigest.getInstance("SHA-256").digest(challenge.copyBytes())
                attempt.claim = PublicBindingClaim(enrollment.replica, enrollment.enrollmentId.copyBytes(),
                    enrollment.recipient.copyBytes(), snapshot.identity.creationAttemptId.copyBytes(),
                    metadata.publicKey.copyBytes(), digest, request.validatorNonce.copyBytes(),
                    request.nativeNonce.copyBytes(), request.sessionDigest.copyBytes())
                val details = WitnessReviewDetails.proveBinding(enrollment.replica, enrollment.enrollmentId.copyBytes(),
                    enrollment.recipient.copyBytes(), metadata.publicKey.copyBytes(),
                    snapshot.identity.creationAttemptId.copyBytes(), digest, request.validatorNonce.copyBytes(),
                    request.nativeNonce.copyBytes(), request.sessionDigest.copyBytes())
                val reviewCancellation = ui.review(details, {}) { attempt.review.complete(it) }
                attempt.cancellation.set(reviewCancellation)
                if (!isCurrent(attempt)) { reviewCancellation.cancel(); attempt.review.complete(false) }
                if (!attempt.review.get(120, TimeUnit.SECONDS)) throw Failure("cancelled")
                requireCurrent(attempt)
                // Consent time starts before the durable write; storage transit can only consume it.
                attempt.consentStarted = monotonicNanos()
                val consent = stored(attempt.journal.commitBindingConsent(snapshot.identity.revision, enrollment,
                    request.validatorNonce.copyBytes(), request.attemptId.copyBytes(), request.nativeNonce.copyBytes(),
                    request.sessionDigest.copyBytes()))
                attempt.consentRevision = consent.revision
                requireUsable(attempt, checkRevision = true)
                val remaining = remainingMillis(attempt)
                if (remaining <= 0) throw Failure("binding_timeout")
                synchronized(lifecycle) {
                    if (!currentForDelivery(attempt) || !attempt.state.compareAndSet(State.REVIEW, State.PREPARED))
                        throw Failure("cancelled")
                    lifecycleCheckpoint("prepared_published")
                    attempt.expiry = scheduleExpiry(remaining) { expire(attempt) }
                }
                retained = true
                WitnessResult.Stored(PreparedWitnessBinding(attempt.handle, attempt.claim, remaining))
            } catch (error: Exception) {
                WitnessResult.Refused(if (error is Failure) error.reason else if (error is TimeoutException) "cancelled" else "binding_failed")
            }
            if (retained) {
                val revisionValid = isUsable(attempt, checkRevision = true)
                lifecycleCheckpoint("before_prepare_delivery")
                val deliverStored = synchronized(lifecycle) {
                    revisionValid && currentForDelivery(attempt) &&
                        attempt.state.compareAndSet(State.PREPARED, State.PREPARE_DELIVERING)
                }
                if (deliverStored) {
                    lifecycleCheckpoint("prepare_delivery_owned")
                    var delivered = false
                    try { callback(result); delivered = true } catch (_: Exception) { terminatePrepared(attempt) }
                    if (delivered) {
                        var finishNow = false
                        synchronized(lifecycle) {
                            if (attempt.state.get() == State.PREPARE_DELIVERING) {
                                if (currentForDelivery(attempt)) {
                                    attempt.state.set(State.PREPARED)
                                    if (attempt.expiryPending) {
                                        attempt.expiryPending = false
                                        attempt.expiry = scheduleExpiry(remainingMillis(attempt)) { expire(attempt) }
                                    }
                                }
                                else { attempt.state.set(State.TERMINAL); finishNow = true }
                            }
                        }
                        lifecycleCheckpoint("prepare_delivery_complete")
                        if (finishNow) finish(attempt)
                    }
                }
                else {
                    terminatePrepared(attempt)
                    callback(WitnessResult.Refused(if (remainingMillis(attempt) <= 0) "binding_timeout" else "cancelled"))
                }
            } else {
                finish(attempt)
                callback(result)
            }
        }
    }

    fun signPrepared(handle: WitnessBindingHandle, callback: (WitnessResult<SignedWitnessBinding>) -> Unit) {
        val attempt = synchronized(lifecycle) {
            val candidate = active.get()
            val state = candidate?.state?.get()
            if (candidate != null && handle === candidate.handle && currentForDelivery(candidate) &&
                (state == State.PREPARED || state == State.PREPARE_DELIVERING) &&
                candidate.state.compareAndSet(state, State.SIGNING)) candidate else null
        }
        if (attempt == null) {
            callback(WitnessResult.Refused("stale_binding_handle"))
            return
        }
        worker.execute {
            val result = try {
                requireUsable(attempt, checkRevision = true)
                val signature = stored(platform.prepareSignature(stored(attempt.journal.observeExisting()).identity))
                requireUsable(attempt, checkRevision = true)
                val presenceCancellation = ui.authenticate(signature, {}) { attempt.presence.complete(it) }
                attempt.cancellation.set(presenceCancellation)
                if (!isCurrent(attempt)) { presenceCancellation.cancel(); attempt.presence.complete(WitnessPresenceResult.Refused("cancelled")) }
                val presence = attempt.presence.get(remainingMillis(attempt), TimeUnit.MILLISECONDS)
                val returned = when (presence) {
                    is WitnessPresenceResult.Success -> presence.signature
                    is WitnessPresenceResult.Refused -> throw Failure(presence.reason)
                }
                if (returned !== signature) throw Failure("biometric_crypto_mismatch")
                requireUsable(attempt, checkRevision = true)
                returned.update(BindingCodec.encode(attempt.claim))
                val bytes = returned.sign()
                requireUsable(attempt, checkRevision = true)
                WitnessResult.Stored(SignedWitnessBinding(attempt.claim, bytes))
            } catch (error: Exception) {
                WitnessResult.Refused(if (error is Failure) error.reason else if (error is TimeoutException) "binding_timeout" else "binding_failed")
            }
            // Keep the active slot and process lease through the final validity check and release.
            val revisionValid = isUsable(attempt, checkRevision = true)
            lifecycleCheckpoint("before_sign_delivery")
            val released = synchronized(lifecycle) {
                val usable = revisionValid && attempt.state.get() == State.SIGNING && currentForDelivery(attempt)
                attempt.state.set(State.TERMINAL)
                if (usable) result else WitnessResult.Refused(
                    if (remainingMillis(attempt) <= 0) "binding_timeout" else "cancelled")
            }
            try { callback(released) } finally { finish(attempt) }
        }
    }

    fun cancel(attemptId: ByteArray, sessionDigest: ByteArray): Boolean {
        if (attemptId.size != 32 || sessionDigest.size != 32) return false
        val attempt: Attempt
        var finishNow = false
        synchronized(lifecycle) {
            attempt = active.get() ?: return false
            if (attempt.request.attemptId != WitnessBytes(attemptId) ||
                attempt.request.sessionDigest != WitnessBytes(sessionDigest) ||
                attempt.state.get() in arrayOf(State.PREPARE_DELIVERING, State.TERMINAL)) return false
            attempt.cancelled.set(true)
            if (attempt.state.compareAndSet(State.PREPARED, State.TERMINAL)) finishNow = true
        }
        attempt.cancellation.get()?.cancel()
        attempt.review.complete(false)
        attempt.presence.complete(WitnessPresenceResult.Refused("cancelled"))
        if (finishNow) finish(attempt)
        return true
    }

    private fun expire(attempt: Attempt) {
        var finishNow = false
        synchronized(lifecycle) {
            if (active.get() !== attempt || attempt.state.get() == State.TERMINAL) return
            if (attempt.state.get() == State.PREPARE_DELIVERING) {
                attempt.expiryPending = true
                return
            }
            attempt.cancelled.set(true)
            if (attempt.state.compareAndSet(State.PREPARED, State.TERMINAL)) finishNow = true
        }
        attempt.cancellation.get()?.cancel()
        attempt.presence.complete(WitnessPresenceResult.Refused("binding_timeout"))
        if (finishNow) finish(attempt)
    }
    private fun terminatePrepared(attempt: Attempt) {
        val won = synchronized(lifecycle) {
            attempt.state.compareAndSet(State.PREPARED, State.TERMINAL) ||
                attempt.state.compareAndSet(State.PREPARE_DELIVERING, State.TERMINAL)
        }
        if (won) finish(attempt)
    }
    private fun finish(attempt: Attempt) {
        attempt.expiry?.cancel()
        if (!active.compareAndSet(attempt, null)) return
        try { attempt.closeJournal() } catch (_: Exception) { return }
        attempt.state.set(State.TERMINAL)
        onDrained()
    }
    private fun requireCurrent(attempt: Attempt) { if (!isCurrent(attempt)) throw Failure("cancelled") }
    private fun isCurrent(attempt: Attempt) = active.get() === attempt && !attempt.cancelled.get() &&
        try { sessionValid(attempt.request.sessionDigest) } catch (_: Exception) { false }
    private fun currentForDelivery(attempt: Attempt) = active.get() === attempt && !attempt.cancelled.get() &&
        remainingMillis(attempt) > 0 && try { sessionValid(attempt.request.sessionDigest) } catch (_: Exception) { false }
    private fun requireUsable(attempt: Attempt, checkRevision: Boolean) {
        if (!isUsable(attempt, checkRevision)) throw Failure(if (remainingMillis(attempt) <= 0) "binding_timeout" else "cancelled")
    }
    private fun isUsable(attempt: Attempt, checkRevision: Boolean): Boolean {
        if (!isCurrent(attempt) || remainingMillis(attempt) <= 0) return false
        if (!checkRevision) return true
        val snapshot = try { stored(attempt.journal.observeExisting()) } catch (_: Exception) { return false }
        return snapshot.identity.revision == attempt.consentRevision
    }
    private fun remainingMillis(attempt: Attempt): Long {
        val elapsed = monotonicNanos() - attempt.consentStarted
        if (elapsed < 0) return 0
        val nanos = CONSENT_NANOS - elapsed
        return if (nanos <= 0) 0 else (nanos + 999_999L) / 1_000_000L
    }
    private fun <T> stored(result: WitnessResult<T>): T = when (result) {
        is WitnessResult.Stored -> result.value
        is WitnessResult.Refused -> throw Failure(result.reason)
        WitnessResult.Missing -> throw Failure("identity_incomplete")
    }
    private class Failure(val reason: String): Exception(reason)
    companion object {
        private const val CONSENT_NANOS = 60_000_000_000L
        private val worker = Executors.newCachedThreadPool { task -> Thread(task, "treehouse-witness-binding").apply { isDaemon = true } }
        private val timer = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "treehouse-witness-binding-timeout").apply { isDaemon = true } }
    }
}

private class FixedBindingPlatform(context: Context): WitnessBindingPlatform {
    private val provider = AndroidWitnessProvider(context)
    override fun prepareSignature(original: WitnessIdentityRecord): WitnessResult<Signature> = provider.prepareFixedSignature(original)
}
