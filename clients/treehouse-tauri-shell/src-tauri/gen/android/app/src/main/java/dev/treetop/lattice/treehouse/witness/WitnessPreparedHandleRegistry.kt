package dev.treetop.lattice.treehouse.witness

import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean

/** Native-only adapter: production construction retains the actual coordinator. */
internal interface WitnessPreparedHandleBackend {
    fun sign(handle: WitnessBindingHandle, callback: (WitnessResult<SignedWitnessBinding>) -> Unit)
    fun cancel(operationId: ByteArray, sessionDigest: ByteArray): Boolean
}

/** Ephemeral tokens never contain signing bytes and are never persisted/restored.
 * Registration begins at the coordinator's prepared callback, not before consent.
 * Cancellation revokes this token even if the coordinator is currently delivering
 * prepare and cannot synchronously cancel; its own expiry still owns lease cleanup.
 */
internal class WitnessPreparedHandleRegistry internal constructor(
    private val backend: WitnessPreparedHandleBackend,
    private val randomHandle: () -> ByteArray,
    private val monotonicMillis: () -> Long,
) {
    constructor(coordinator: WitnessBindingCoordinator): this(
        object: WitnessPreparedHandleBackend {
            override fun sign(handle: WitnessBindingHandle, callback: (WitnessResult<SignedWitnessBinding>) -> Unit) = coordinator.signPrepared(handle, callback)
            override fun cancel(operationId: ByteArray, sessionDigest: ByteArray) = coordinator.cancel(operationId, sessionDigest)
        }, secureHandles(), { System.nanoTime() / 1_000_000L })

    constructor(backend: WitnessPreparedHandleBackend): this(backend, secureHandles(), { System.nanoTime() / 1_000_000L })

    private enum class State { PREPARED, SIGNING, CANCELLED, TERMINAL }
    private class Entry(val operationId: WitnessBytes, val session: WitnessBytes, val token: WitnessBytes,
        val prepared: PreparedWitnessBinding, val deadline: Long) {
        var state = State.PREPARED
        val delivered = AtomicBoolean(false)
    }
    private val lock = Any()
    private val entries = linkedMapOf<WitnessBytes, Entry>()
    private val issued = mutableSetOf<WitnessBytes>()

    fun register(operationId: WitnessBytes, session: WitnessBytes, prepared: PreparedWitnessBinding): WitnessResult<ByteArray> {
        return try {
            synchronized(lock) {
                if (entries.size >= MAX_ACTIVE || issued.size >= MAX_ISSUED ||
                    entries.values.any { it.operationId == operationId }) return WitnessResult.Refused("binding_capacity")
                val token = witness32(randomHandle())
                if (token in issued) return WitnessResult.Refused("binding_handle_collision")
                val bytes = WitnessPrivateBindingResponses.prepared(operationId, session, token, prepared)
                    ?: return WitnessResult.Refused("invalid_private_response")
                val now = monotonicMillis()
                val deadline = Math.addExact(now, prepared.remainingMillis)
                issued.add(token)
                entries[token] = Entry(operationId, session, token, prepared, deadline)
                WitnessResult.Stored(bytes)
            }
        } catch (_: Exception) { WitnessResult.Refused("binding_failed") }
    }

    fun signPrepared(request: WitnessPrivateRequest.SignPrepared, callback: (WitnessResult<ByteArray>) -> Unit) {
        val selected = synchronized(lock) {
            val entry = entries[request.handle]
            when {
                entry == null -> null
                entry.operationId != request.operationId || entry.session != request.sessionDigest -> null
                entry.state != State.PREPARED -> null
                monotonicMillis() >= entry.deadline -> { entry.state = State.TERMINAL; entries.remove(entry.token); null }
                else -> { entry.state = State.SIGNING; entry }
            }
        }
        if (selected == null) { callback(WitnessResult.Missing); return }
        try {
            backend.sign(selected.prepared.handle) { signed ->
                if (!selected.delivered.compareAndSet(false, true)) return@sign
                val result = synchronized(lock) {
                    val usable = entries[selected.token] === selected && selected.state == State.SIGNING && monotonicMillis() < selected.deadline
                    selected.state = State.TERMINAL
                    entries.remove(selected.token)
                    if (!usable) WitnessResult.Refused("cancelled")
                    else when (signed) {
                        is WitnessResult.Stored -> {
                            if (!BindingCodec.encode(signed.value.claim).contentEquals(BindingCodec.encode(selected.prepared.claim)))
                                WitnessResult.Refused("binding_claim_mismatch")
                            else WitnessPrivateBindingResponses.signed(selected.operationId, selected.session, selected.token, signed.value)
                                ?.let { WitnessResult.Stored(it) } ?: WitnessResult.Refused("invalid_private_response")
                        }
                        is WitnessResult.Refused -> signed
                        WitnessResult.Missing -> WitnessResult.Missing
                    }
                }
                callback(result)
            }
        } catch (_: Exception) {
            if (selected.delivered.compareAndSet(false, true)) {
                synchronized(lock) { selected.state = State.TERMINAL; entries.remove(selected.token) }
                callback(WitnessResult.Refused("binding_failed"))
            }
        }
    }

    fun cancel(operationId: WitnessBytes, session: WitnessBytes): Boolean {
        val selected = synchronized(lock) {
            val entry = entries.values.singleOrNull { it.operationId == operationId && it.session == session }
                ?: return false
            if (entry.state !in arrayOf(State.PREPARED, State.SIGNING)) return false
            val wasPrepared = entry.state == State.PREPARED
            entry.state = State.CANCELLED
            if (wasPrepared) entries.remove(entry.token)
            entry
        }
        try { backend.cancel(selected.operationId.copyBytes(), selected.session.copyBytes()) } catch (_: Exception) { }
        return true
    }

    companion object {
        private const val MAX_ACTIVE = 64
        private const val MAX_ISSUED = 4096
        private fun secureHandles(): () -> ByteArray {
            val random = SecureRandom()
            return { ByteArray(32).also(random::nextBytes) }
        }
    }
}
