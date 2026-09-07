package dev.treetop.lattice.treehouse.witness

import android.content.Context
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Owns admission, consent lifetime and response delivery through actual backend drain.
 * Journal and UI adapters own their resources; neither grants admission to another operation.
 */
internal class WitnessFlow(
    private val context: Context,
    signer: ByteArray,
    private val ui: WitnessReviewUi,
    private val generation: WitnessGenerationPlatform = FixedGenerationPlatform(context),
    private val identity: (WitnessIdentityRecord?) -> WitnessKeyObservation = AndroidWitnessProvider(context)::observeFixedIdentity,
    private val journalCheckpoint: (String) -> Unit = {},
    private val monotonicNanos: () -> Long = System::nanoTime,
    private val scheduleReviewTimeout: (() -> Unit) -> WitnessUiCancellation = { task ->
        val future = timer.schedule(task, 120, TimeUnit.SECONDS)
        object: WitnessUiCancellation { override fun cancel() { future.cancel(false) } }
    },
    private val bindingFactory: (Context, ByteArray, WitnessReviewUi, (WitnessBytes) -> Boolean, () -> Unit) -> WitnessFlowBinding =
        { ctx, appSigner, review, valid, drained -> WitnessBindingCoordinator(ctx, appSigner, review, sessionValid = valid, onDrained = drained).asFlowBinding() },
) {
    private val signer = witness32(signer)
    private val lock = Any()
    private var active: Attempt? = null
    private enum class Phase { RUNNING, PREPARED, SIGNING }
    private class Delivery(val callback: (WitnessResult<ByteArray>) -> Unit) {
        var delivered = false
        var received = false
    }
    private class Attempt(val request: WitnessPrivateRequest, val initialDelivery: Delivery) {
        var delivery = initialDelivery
        var cancelled = false
        var deliveryDepth = 0
        var drained = false
        val pendingUi = mutableSetOf<Any>()
        var phase = Phase.RUNNING
        val review = CompletableFuture<Boolean>()
        var cancellation: WitnessUiCancellation? = null
        var binding: WitnessFlowBinding? = null
        var handles: WitnessPreparedHandleRegistry? = null
        var bindingAttempt: WitnessBytes? = null
    }

    fun submit(request: WitnessPrivateRequest, callback: (WitnessResult<ByteArray>) -> Unit) {
        if (request is WitnessPrivateRequest.Cancel) {
            val selected = synchronized(lock) { active?.takeIf {
                it.request.operationId == request.targetOperationId && it.request.sessionDigest == request.sessionDigest
            } }
            val won = selected != null && cancel(selected)
            callback(terminal(request, if (won) WitnessTerminalStatus.CANCELLED else WitnessTerminalStatus.MISSING))
            return
        }
        val delivery = Delivery(callback)
        var continuation = false
        val selected = synchronized(lock) {
            val current = active
            if (request is WitnessPrivateRequest.SignPrepared) {
                if (current != null && current.phase == Phase.PREPARED && !current.cancelled &&
                    current.request.operationId == request.operationId && current.request.sessionDigest == request.sessionDigest) {
                    current.phase = Phase.SIGNING
                    current.delivery = delivery
                    continuation = true
                    current
                } else null
            } else if (current == null) Attempt(request, delivery).also { active = it } else null
        }
        if (selected == null) { callback(terminal(request, WitnessTerminalStatus.REFUSED, "storage_busy")); return }
        if (continuation) {
            selected.handles!!.signPrepared(request as WitnessPrivateRequest.SignPrepared) { result ->
                try { deliver(selected, delivery, result) } finally {
                    // A refused token may never enter the coordinator. Revoke its retained
                    // preparation explicitly; only onDrained can release global admission.
                    if (result !is WitnessResult.Stored) cancel(selected, lifecycle = true)
                }
            }
            return
        }
        worker.execute {
            if (request is WitnessPrivateRequest.Proof) {
                try { proof(selected, request) } catch (_: Exception) {
                    deliver(selected, delivery, WitnessResult.Refused("binding_failed")); drain(selected)
                }
            } else {
                val result = try {
                    when (request) {
                        is WitnessPrivateRequest.Identity -> observe().mapSnapshot(request, null)
                        is WitnessPrivateRequest.Prepare -> prepare(selected, request)
                        is WitnessPrivateRequest.Generate -> generate(selected, request).mapSnapshot(request, null)
                        else -> WitnessResult.Refused("invalid_private_request")
                    }
                } catch (error: Exception) {
                    WitnessResult.Refused(if (error is Failure) error.reason else when (request) {
                        is WitnessPrivateRequest.Prepare -> "preparation_failed"
                        is WitnessPrivateRequest.Generate -> "generation_failed"
                        else -> "native_failed"
                    })
                }
                // All journal use blocks and platform effects have finished before drain.
                try { deliver(selected, delivery, result) } finally { drain(selected) }
            }
        }
    }

    fun invalidate() { synchronized(lock) { active }?.let { cancel(it, lifecycle = true) } }

    private fun cancel(attempt: Attempt, lifecycle: Boolean = false): Boolean {
        val selected = synchronized(lock) {
            if (active !== attempt || attempt.cancelled || (!lifecycle && (attempt.deliveryDepth > 0 || (attempt.delivery.delivered && attempt.phase != Phase.PREPARED)))) return false
            attempt.cancelled = true
            Triple(attempt.cancellation, attempt.binding, attempt.bindingAttempt)
        }
        try { selected.first?.cancel() } catch (_: Exception) { }
        attempt.review.complete(false)
        if (selected.second != null && selected.third != null)
            try { selected.second!!.cancel(selected.third!!.copyBytes(), attempt.request.sessionDigest.copyBytes()) } catch (_: Exception) { }
        deliver(attempt, attempt.delivery, WitnessResult.Refused("cancelled"))
        return true
    }

    private fun current(attempt: Attempt) = synchronized(lock) { active === attempt && !attempt.cancelled }
    private fun requireCurrent(attempt: Attempt) { if (!current(attempt)) throw Failure("cancelled") }
    private fun review(attempt: Attempt, details: WitnessReviewDetails) {
        requireCurrent(attempt)
        val started = monotonicNanos()
        val deadline = try { Math.addExact(started, TimeUnit.SECONDS.toNanos(120)) }
            catch (_: ArithmeticException) { throw Failure("cancelled") }
        val timeout = scheduleReviewTimeout { cancel(attempt, lifecycle = true) }
        try {
            val cancellation = ownedUi(attempt).review(details, {}) { attempt.review.complete(it) }
            val now = monotonicNanos()
            val elapsed = now < started || now >= deadline
            val cancelNow = synchronized(lock) { attempt.cancellation = cancellation; elapsed || !current(attempt) }
            if (cancelNow) { cancellation.cancel(); attempt.review.complete(false); throw Failure("cancelled") }
            val accepted = try { attempt.review.get(deadline - now, TimeUnit.NANOSECONDS) }
                catch (_: Exception) { cancellation.cancel(); false }
            val finished = monotonicNanos()
            if (!accepted || finished < now || finished >= deadline) { cancellation.cancel(); throw Failure("cancelled") }
            requireCurrent(attempt)
        } finally { timeout.cancel() }
    }
    private fun claimResult(attempt: Attempt, delivery: Delivery): Boolean = synchronized(lock) {
        if (active !== attempt || attempt.delivery !== delivery || delivery.delivered || delivery.received) false
        else { delivery.received = true; true }
    }
    private fun deliver(attempt: Attempt, delivery: Delivery, result: WitnessResult<ByteArray>, prepared: Boolean = false) {
        val callback = synchronized(lock) {
            if (active !== attempt || attempt.delivery !== delivery || delivery.delivered) return
            delivery.delivered = true
            attempt.deliveryDepth++
            if (prepared && !attempt.cancelled) attempt.phase = Phase.PREPARED
            delivery.callback
        }
        try { callback(if (current(attempt)) result else WitnessResult.Refused("cancelled")) }
        catch (_: Exception) { cancel(attempt, lifecycle = true) }
        finally { synchronized(lock) {
            attempt.deliveryDepth--
            releaseIfDrained(attempt)
        } }
    }
    private fun drain(attempt: Attempt) = synchronized(lock) {
        attempt.drained = true
        releaseIfDrained(attempt)
    }

    /** Called under lock; backend completion and cancellation alone never release UI ownership. */
    private fun releaseIfDrained(attempt: Attempt) {
        if (active === attempt && attempt.drained && attempt.pendingUi.isEmpty() &&
            attempt.delivery.delivered && attempt.deliveryDepth == 0) active = null
    }
    private fun ownedUi(attempt: Attempt): WitnessReviewUi = object: WitnessReviewUi {
        private fun ticket(onLocalCleanup: () -> Unit): () -> Unit {
            val ticket = Any()
            synchronized(lock) { attempt.pendingUi.add(ticket) }
            return acknowledgement@ {
                val first = synchronized(lock) {
                    if (!attempt.pendingUi.remove(ticket)) false
                    else { releaseIfDrained(attempt); true }
                }
                if (first) onLocalCleanup()
            }
        }
        override fun review(details: WitnessReviewDetails, onLocalCleanup: () -> Unit,
            callback: (Boolean) -> Unit): WitnessUiCancellation =
            ui.review(details, ticket(onLocalCleanup), callback)
        override fun authenticate(signature: java.security.Signature, onLocalCleanup: () -> Unit,
            callback: (WitnessPresenceResult) -> Unit): WitnessUiCancellation =
            ui.authenticate(signature, ticket(onLocalCleanup), callback)
    }

    private fun observe(): WitnessResult<WitnessSnapshot> = try {
        WitnessJournal(context, signer.copyBytes()).use { journal ->
            when (val stored = journal.observeExisting()) {
                WitnessResult.Missing -> when (val platform = identity(null)) {
                    WitnessKeyObservation.Absent -> WitnessResult.Missing
                    is WitnessKeyObservation.Refused -> WitnessResult.Refused(platform.reason)
                    is WitnessKeyObservation.Present -> WitnessResult.Refused("identity_incomplete")
                }
                is WitnessResult.Refused -> stored
                is WitnessResult.Stored -> when (val platform = identity(stored.value.identity)) {
                    is WitnessKeyObservation.Refused -> WitnessResult.Refused(platform.reason)
                    WitnessKeyObservation.Absent -> if (stored.value.identity.phase == WitnessPhase.PREPARED) stored else WitnessResult.Refused("identity_incomplete")
                    is WitnessKeyObservation.Present -> if (stored.value.identity.phase == WitnessPhase.PREPARED) WitnessResult.Refused("identity_incomplete") else stored
                }
            }
        }
    } catch (_: Exception) { WitnessResult.Refused("storage_failed") }

    private fun prepare(attempt: Attempt, request: WitnessPrivateRequest.Prepare): WitnessResult<ByteArray> {
        val before = when (val preflight = observe()) {
            is WitnessResult.Refused -> return preflight
            is WitnessResult.Stored -> preflight.value
            WitnessResult.Missing -> null
        }
        requireCurrent(attempt)
        fun existing(snapshot: WitnessSnapshot?): WitnessEnrollment? {
            val found = snapshot?.enrollments?.find { it.enrollmentId == request.enrollmentId }
            if (found != null && (found.replica != request.replica || found.recipient != request.recipient))
                throw Failure("enrollment_conflict")
            if (found == null && snapshot != null && snapshot.identity.phase != WitnessPhase.GENERATED_UNVALIDATED)
                throw Failure("identity_incomplete")
            return found
        }
        val originalEnrollment = existing(before)
        if (originalEnrollment != null) return WitnessResult.Stored(before!!).mapSnapshot(request, originalEnrollment)
        // No journal object or lease crosses native review. Global admission remains owned.
        review(attempt, WitnessReviewDetails.prepareCreation(request.replica, request.enrollmentId.copyBytes(), request.recipient.copyBytes()))
        val snapshot = WitnessJournal(context, signer.copyBytes(), journalCheckpoint).use { journal ->
            val after = when (val observed = journal.observeExisting()) {
                is WitnessResult.Stored -> observed.value
                WitnessResult.Missing -> null
                is WitnessResult.Refused -> throw Failure(observed.reason)
            }
            requireCurrent(attempt)
            if (existing(after) != null) after!!
            else {
                val creationAttempt = after?.identity?.creationAttemptId ?: request.creationAttemptId
                val enrollment = WitnessEnrollment(request.enrollmentId.copyBytes(), request.replica,
                    request.recipient.copyBytes(), creationAttempt.copyBytes())
                stored(journal.prepareAccepted(enrollment, creationAttempt.copyBytes()))
            }
        }
        return observe().mapSnapshot(request, snapshot.enrollments.single { it.enrollmentId == request.enrollmentId })
    }

    private fun generate(attempt: Attempt, request: WitnessPrivateRequest.Generate): WitnessResult<WitnessSnapshot> =
        WitnessJournal(context, signer.copyBytes(), journalCheckpoint).use { journal ->
        requireCurrent(attempt)
        var snapshot = stored(journal.retainExistingForAttempt(request.expectedRevision, request.creationAttemptId.copyBytes()))
        val original = snapshot.identity
        if (original.generationChallenge != null && original.generationChallenge != request.generationChallenge) throw Failure("original_identity_mismatch")
        val enrollment = snapshot.enrollments.firstOrNull() ?: throw Failure("identity_incomplete")
        val details = WitnessReviewDetails.generate(enrollment.replica, enrollment.enrollmentId.copyBytes(),
            enrollment.recipient.copyBytes(), original.creationAttemptId.copyBytes(), request.generationChallenge.copyBytes())
        review(attempt, details)
        // The held lease makes this a stable exact revision and original-attempt check after review.
        snapshot = stored(journal.retainExistingForAttempt(original.revision, request.creationAttemptId.copyBytes()))
        val observed = generation.observe(snapshot.identity)
        if (snapshot.identity.phase != WitnessPhase.PREPARED) {
            val metadata = present(observed)
            val completed = stored(journal.reconcileOriginalGeneration(snapshot.identity.revision,
                request.creationAttemptId.copyBytes(), request.generationChallenge.copyBytes(), metadata))
            requireCurrent(attempt)
            return@use WitnessResult.Stored(completed)
        }
        when (observed) {
            WitnessKeyObservation.Absent -> Unit
            is WitnessKeyObservation.Present -> throw Failure("identity_incomplete")
            is WitnessKeyObservation.Refused -> throw Failure(observed.reason)
        }
        requireCurrent(attempt)
        val fence = stored(journal.commitGenerationStarted(snapshot.identity.revision,
            request.creationAttemptId.copyBytes(), request.generationChallenge.copyBytes()))
        snapshot = stored(journal.retainExistingForAttempt(fence.revision, request.creationAttemptId.copyBytes()))
        // PREPARED is used only for the real provider's fail-closed absence observation; a STARTED
        // record deliberately reports absent custody as incomplete. Generation still uses the
        // retained STARTED snapshot and its opaque fence, never this old observation record.
        when (val afterFence = generation.observe(original)) {
            WitnessKeyObservation.Absent -> Unit
            is WitnessKeyObservation.Present -> throw Failure("identity_incomplete")
            is WitnessKeyObservation.Refused -> throw Failure(afterFence.reason)
        }
        // Accepted consent plus the durable fence commits this one invocation. Cancellation now
        // suppresses release, while the native operation and original metadata still drain.
        var generatorFailed = false
        try { generation.generate(snapshot.identity, fence) } catch (_: Exception) { generatorFailed = true }
        // Do not abort this completion on cancellation/session loss: a generated key must retain its
        // original public metadata, and no competing native attempt may enter before this drains.
        val metadata = present(generation.observe(snapshot.identity))
        val completed = stored(journal.finishOriginalGeneration(fence, metadata))
        requireCurrent(attempt)
        return@use if (generatorFailed) WitnessResult.Refused("generation_failed") else WitnessResult.Stored(completed)
    }

    private fun proof(attempt: Attempt, request: WitnessPrivateRequest.Proof) {
        val snapshot = observe()
        if (snapshot !is WitnessResult.Stored) {
            try { deliver(attempt, attempt.initialDelivery, snapshot.mapSnapshot(request, null)) } finally { drain(attempt) }; return
        }
        val enrollment = snapshot.value.enrollments.singleOrNull { it.enrollmentId == request.enrollmentId }
        if (enrollment == null) {
            try { deliver(attempt, attempt.initialDelivery, WitnessResult.Refused("enrollment_mismatch")) } finally { drain(attempt) }; return
        }
        requireCurrent(attempt)
        val binding = bindingFactory(context, signer.copyBytes(), ownedUi(attempt),
            { current(attempt) && it == request.sessionDigest }, { drain(attempt) })
        val handles = WitnessPreparedHandleRegistry(binding)
        synchronized(lock) {
            attempt.binding = binding
            attempt.handles = handles
            attempt.bindingAttempt = enrollment.creationAttemptId
        }
        binding.prepare(WitnessBindingRequest(request.expectedRevision, request.replica,
            request.enrollmentId.copyBytes(), request.recipient.copyBytes(), request.freshValidatorNonce.copyBytes(),
            enrollment.creationAttemptId.copyBytes(), request.nativeNonce.copyBytes(), request.sessionDigest.copyBytes())) callback@ { result ->
            if (!claimResult(attempt, attempt.initialDelivery)) return@callback
            when (result) {
                is WitnessResult.Stored -> {
                    val registered = handles.register(request.operationId, request.sessionDigest, result.value)
                    deliver(attempt, attempt.initialDelivery, registered, prepared = registered is WitnessResult.Stored)
                    if (registered !is WitnessResult.Stored || !current(attempt))
                        cancel(attempt, lifecycle = true)
                }
                is WitnessResult.Refused -> deliver(attempt, attempt.initialDelivery, result)
                WitnessResult.Missing -> deliver(attempt, attempt.initialDelivery, WitnessResult.Missing)
            }
        }
    }
    private fun present(observation: WitnessKeyObservation): CapturedWitnessIdentity = when (observation) {
        is WitnessKeyObservation.Present -> observation.metadata
        WitnessKeyObservation.Absent -> throw Failure("identity_incomplete")
        is WitnessKeyObservation.Refused -> throw Failure(observation.reason)
    }
    private fun <T> stored(result: WitnessResult<T>): T = when (result) {
        is WitnessResult.Stored -> result.value
        is WitnessResult.Refused -> throw Failure(result.reason)
        WitnessResult.Missing -> throw Failure("identity_incomplete")
    }
    private fun WitnessResult<WitnessSnapshot>.mapSnapshot(request: WitnessPrivateRequest, enrollment: WitnessEnrollment?): WitnessResult<ByteArray> = when (this) {
        is WitnessResult.Stored -> WitnessPrivateSnapshotResponses.encode(kind(request), request.operationId, request.sessionDigest, value, enrollment)
            ?.let { WitnessResult.Stored(it) } ?: WitnessResult.Refused("invalid_private_response")
        is WitnessResult.Refused -> this
        WitnessResult.Missing -> WitnessResult.Missing
    }
    private fun terminal(request: WitnessPrivateRequest, status: WitnessTerminalStatus, reason: String? = null): WitnessResult<ByteArray> =
        WitnessPrivateProtocol.encodeTerminal(WitnessTerminalResponse(kind(request), request.operationId, status, reason))
            ?.let { WitnessResult.Stored(it) } ?: WitnessResult.Refused("invalid_private_response")
    private fun kind(request: WitnessPrivateRequest) = when (request) {
        is WitnessPrivateRequest.Identity -> WitnessPrivateKind.IDENTITY
        is WitnessPrivateRequest.Prepare -> WitnessPrivateKind.PREPARE
        is WitnessPrivateRequest.Generate -> WitnessPrivateKind.GENERATE
        is WitnessPrivateRequest.Proof, is WitnessPrivateRequest.SignPrepared -> WitnessPrivateKind.PROOF
        is WitnessPrivateRequest.Cancel -> WitnessPrivateKind.CANCEL
    }
    private class Failure(val reason: String): Exception(reason)
    private companion object {
        val timer = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "treehouse-witness-review-timeout").apply { isDaemon = true } }
        val worker = Executors.newCachedThreadPool { task -> Thread(task, "treehouse-witness-flow").apply { isDaemon = true } }
    }
}

/** Legacy proof lifetime adapter. It owns no admission or delivery arbitration. */
internal interface WitnessFlowBinding: WitnessPreparedHandleBackend {
    fun prepare(request: WitnessBindingRequest, callback: (WitnessResult<PreparedWitnessBinding>) -> Unit)
}
internal fun WitnessBindingCoordinator.asFlowBinding(): WitnessFlowBinding {
    val coordinator = this
    return object: WitnessFlowBinding {
        override fun prepare(request: WitnessBindingRequest, callback: (WitnessResult<PreparedWitnessBinding>) -> Unit) = coordinator.prepareBinding(request, callback)
        override fun sign(handle: WitnessBindingHandle, callback: (WitnessResult<SignedWitnessBinding>) -> Unit) = coordinator.signPrepared(handle, callback)
        override fun cancel(operationId: ByteArray, sessionDigest: ByteArray) = coordinator.cancel(operationId, sessionDigest)
    }
}
