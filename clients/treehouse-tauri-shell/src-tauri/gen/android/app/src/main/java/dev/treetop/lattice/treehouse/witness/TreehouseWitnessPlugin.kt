package dev.treetop.lattice.treehouse.witness

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal interface WitnessPrivateRuntime {
    fun execute(request: WitnessPrivateRequest, callback: (WitnessResult<ByteArray>) -> Unit)
    fun cancel(operationId: WitnessBytes, session: WitnessBytes): Boolean
}

/** The only conversion at the Tauri boundary: raw closed JSON in, JSON object out. */
internal object WitnessInvokeBoundary {
    fun decode(raw: String): WitnessPrivateRequest? =
        WitnessPrivateProtocol.decodeRequest(raw.toByteArray(StandardCharsets.UTF_8))
    fun response(bytes: ByteArray): JSObject? = try {
        JSObject(String(bytes, StandardCharsets.UTF_8))
    } catch (_: Exception) { null }
}

/** Serializes every private custody operation and suppresses all callbacks after lifecycle loss. */
internal class WitnessPrivateDispatch(private val runtime: WitnessPrivateRuntime) {
    private enum class Phase { RUNNING, PREPARE_DELIVERING, PREPARED, SIGNING }
    private class Active(val operationId: WitnessBytes, val session: WitnessBytes, var phase: Phase,
        var callback: (WitnessResult<ByteArray>) -> Unit) {
        val delivered = AtomicBoolean(false)
    }
    private val lock = Any()
    private var active: Active? = null

    fun dispatch(request: WitnessPrivateRequest, callback: (WitnessResult<ByteArray>) -> Unit) {
        if (request is WitnessPrivateRequest.Cancel) {
            var cancelledCallback: ((WitnessResult<ByteArray>) -> Unit)? = null
            val cancelled = synchronized(lock) {
                val current = active
                if (current == null || current.operationId != request.targetOperationId || current.session != request.sessionDigest) false
                else if (current.phase == Phase.PREPARE_DELIVERING) false
                else runtime.cancel(current.operationId, current.session).also { won ->
                    if (won) {
                        active = null
                        if (current.phase != Phase.PREPARED && current.delivered.compareAndSet(false, true))
                            cancelledCallback = current.callback
                    }
                }
            }
            cancelledCallback?.invoke(WitnessResult.Refused("cancelled"))
            callback(if (cancelled) terminal(request, WitnessTerminalStatus.CANCELLED)
                else terminal(request, WitnessTerminalStatus.MISSING))
            return
        }
        val selected = synchronized(lock) {
            val current = active
            when {
                request is WitnessPrivateRequest.SignPrepared && current != null &&
                    current.operationId == request.operationId && current.session == request.sessionDigest &&
                    current.phase in setOf(Phase.PREPARED, Phase.PREPARE_DELIVERING) ->
                    Active(current.operationId, current.session, Phase.SIGNING, callback).also { active = it }
                current != null -> null
                request is WitnessPrivateRequest.SignPrepared -> null
                else -> Active(request.operationId, request.sessionDigest, Phase.RUNNING, callback).also { active = it }
            }
        }
        if (selected == null) {
            callback(terminal(request, WitnessTerminalStatus.REFUSED, "storage_busy")); return
        }
        runtime.execute(request) { result ->
            var preparedDelivery = false
            val deliver = synchronized(lock) {
                if (active !== selected) false
                else if (!selected.delivered.compareAndSet(false, true)) false
                else if (request is WitnessPrivateRequest.Proof && result is WitnessResult.Stored) {
                    selected.phase = Phase.PREPARE_DELIVERING; preparedDelivery = true; true
                } else { active = null; true }
            }
            if (deliver) {
                try { callback(result) } finally {
                    if (preparedDelivery) synchronized(lock) {
                        if (active === selected && selected.phase == Phase.PREPARE_DELIVERING) {
                            selected.phase = Phase.PREPARED
                        }
                    }
                }
            }
        }
    }

    fun invalidate() {
        val selected = synchronized(lock) { active.also { active = null } } ?: return
        runtime.cancel(selected.operationId, selected.session)
        if (selected.phase != Phase.PREPARED && selected.delivered.compareAndSet(false, true))
            selected.callback(WitnessResult.Refused("cancelled"))
    }

    private fun terminal(request: WitnessPrivateRequest, status: WitnessTerminalStatus,
        reason: String? = null): WitnessResult<ByteArray> {
        val kind = when (request) {
            is WitnessPrivateRequest.Identity -> WitnessPrivateKind.IDENTITY
            is WitnessPrivateRequest.Prepare -> WitnessPrivateKind.PREPARE
            is WitnessPrivateRequest.Generate -> WitnessPrivateKind.GENERATE
            is WitnessPrivateRequest.Proof, is WitnessPrivateRequest.SignPrepared -> WitnessPrivateKind.PROOF
            is WitnessPrivateRequest.Cancel -> WitnessPrivateKind.CANCEL
        }
        val bytes = WitnessPrivateProtocol.encodeTerminal(WitnessTerminalResponse(kind, request.operationId, status, reason))
            ?: return WitnessResult.Refused("invalid_private_response")
        return WitnessResult.Stored(bytes)
    }
}

@TauriPlugin
class TreehouseWitnessPlugin(private val activity: Activity) : Plugin(activity) {
    private val worker = Executors.newSingleThreadExecutor { task ->
        Thread(task, "treehouse-witness-private-dispatch").apply { isDaemon = true }
    }
    private val runtime = AtomicReference<WitnessPrivateRuntime?>(null)
    private val dispatch = WitnessPrivateDispatch(object : WitnessPrivateRuntime {
        override fun execute(request: WitnessPrivateRequest, callback: (WitnessResult<ByteArray>) -> Unit) {
            val selected = runtime.get() ?: createRuntime()?.also(runtime::set)
            if (selected == null) callback(WitnessResult.Refused("app_identity_mismatch")) else selected.execute(request, callback)
        }
        override fun cancel(operationId: WitnessBytes, session: WitnessBytes): Boolean =
            runtime.get()?.cancel(operationId, session) ?: false
    })

    override fun load(webView: WebView) {
        super.load(webView)
        activity.application.registerActivityLifecycleCallbacks(WitnessPluginLifecycle(activity, dispatch))
    }

    @Command
    fun dispatch(invoke: Invoke) {
        val request = WitnessInvokeBoundary.decode(invoke.getRawArgs())
        if (request == null) { invoke.reject("invalid_private_request"); return }
        worker.execute {
            dispatch.dispatch(request) { result ->
                val bytes = when (result) {
                    is WitnessResult.Stored -> result.value
                    is WitnessResult.Refused -> WitnessPrivateProtocol.encodeTerminal(WitnessTerminalResponse(kind(request), request.operationId,
                        WitnessTerminalStatus.REFUSED, result.reason))
                    WitnessResult.Missing -> WitnessPrivateProtocol.encodeTerminal(WitnessTerminalResponse(kind(request), request.operationId,
                        WitnessTerminalStatus.MISSING))
                }
                if (bytes == null) invoke.reject("invalid_private_response")
                else WitnessInvokeBoundary.response(bytes)?.let(invoke::resolve)
                    ?: invoke.reject("invalid_private_response")
            }
        }
    }

    private fun createRuntime(): WitnessPrivateRuntime? {
        val signer = when (val observed = AndroidWitnessProvider(activity).observeCurrentAppSigner()) {
            is WitnessResult.Stored -> observed.value
            else -> return null
        }
        return AndroidWitnessPrivateRuntime(activity, signer)
    }

    private fun kind(request: WitnessPrivateRequest) = when (request) {
        is WitnessPrivateRequest.Identity -> WitnessPrivateKind.IDENTITY
        is WitnessPrivateRequest.Prepare -> WitnessPrivateKind.PREPARE
        is WitnessPrivateRequest.Generate -> WitnessPrivateKind.GENERATE
        is WitnessPrivateRequest.Proof, is WitnessPrivateRequest.SignPrepared -> WitnessPrivateKind.PROOF
        is WitnessPrivateRequest.Cancel -> WitnessPrivateKind.CANCEL
    }
}

private class WitnessPluginLifecycle(private val owner: Activity, private val dispatch: WitnessPrivateDispatch) :
    Application.ActivityLifecycleCallbacks {
    private fun invalidate(changed: Activity) { if (changed === owner) dispatch.invalidate() }
    override fun onActivityPaused(activity: Activity) = invalidate(activity)
    override fun onActivityStopped(activity: Activity) = invalidate(activity)
    override fun onActivityDestroyed(activity: Activity) {
        invalidate(activity)
        if (activity === owner) activity.application.unregisterActivityLifecycleCallbacks(this)
    }
    override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
}

private class AndroidWitnessPrivateRuntime(private val activity: Activity, private val signer: WitnessBytes) : WitnessPrivateRuntime {
    private val ui = WitnessNativeReview(activity)
    private val validSession = AtomicReference<WitnessBytes?>(null)
    private val binding = WitnessBindingCoordinator(activity, signer.copyBytes(), ui,
        sessionValid = { validSession.get() == it })
    private val handles = WitnessPreparedHandleRegistry(binding)
    private val cancelCurrent = AtomicReference<((WitnessBytes, WitnessBytes) -> Boolean)?>(null)

    override fun execute(request: WitnessPrivateRequest, callback: (WitnessResult<ByteArray>) -> Unit) {
        validSession.set(request.sessionDigest)
        when (request) {
            is WitnessPrivateRequest.Identity -> { cancelCurrent.set(null); callback(observe().mapSnapshot(request, null)) }
            is WitnessPrivateRequest.Prepare -> prepare(request, callback)
            is WitnessPrivateRequest.Generate -> generate(request, callback)
            is WitnessPrivateRequest.Proof -> proof(request, callback)
            is WitnessPrivateRequest.SignPrepared -> {
                cancelCurrent.set(handles::cancel)
                handles.signPrepared(request, callback)
            }
            is WitnessPrivateRequest.Cancel -> callback(WitnessResult.Missing)
        }
    }

    override fun cancel(operationId: WitnessBytes, session: WitnessBytes): Boolean {
        validSession.compareAndSet(session, null)
        return cancelCurrent.getAndSet(null)?.invoke(operationId, session) ?: false
    }

    private fun observe(): WitnessResult<WitnessSnapshot> = try {
        WitnessJournal(activity, signer.copyBytes()).use { journal ->
            when (val stored = journal.observeExisting()) {
                WitnessResult.Missing -> when (val platform = AndroidWitnessProvider(activity).observeFixedIdentity(null)) {
                    WitnessKeyObservation.Absent -> WitnessResult.Missing
                    is WitnessKeyObservation.Refused -> WitnessResult.Refused(platform.reason)
                    is WitnessKeyObservation.Present -> WitnessResult.Refused("identity_incomplete")
                }
                is WitnessResult.Refused -> stored
                is WitnessResult.Stored -> {
                    val snapshot = stored.value
                    when (val platform = AndroidWitnessProvider(activity).observeFixedIdentity(snapshot.identity)) {
                        is WitnessKeyObservation.Refused -> WitnessResult.Refused(platform.reason)
                        WitnessKeyObservation.Absent -> if (snapshot.identity.phase == WitnessPhase.PREPARED) stored
                            else WitnessResult.Refused("identity_incomplete")
                        is WitnessKeyObservation.Present -> if (snapshot.identity.phase == WitnessPhase.PREPARED)
                            WitnessResult.Refused("identity_incomplete") else stored
                    }
                }
            }
        }
    } catch (_: Exception) { WitnessResult.Refused("storage_failed") }

    private fun prepare(request: WitnessPrivateRequest.Prepare, callback: (WitnessResult<ByteArray>) -> Unit) {
        when (val preflight = observe()) {
            is WitnessResult.Refused -> { callback(preflight); return }
            is WitnessResult.Stored -> if (preflight.value.identity.phase != WitnessPhase.GENERATED_UNVALIDATED &&
                preflight.value.enrollments.none { it.enrollmentId == request.enrollmentId }) {
                callback(WitnessResult.Refused("identity_incomplete")); return
            }
            WitnessResult.Missing -> Unit
        }
        val coordinator = WitnessPreparationCoordinator(activity, signer.copyBytes(), ui,
            sessionValid = { validSession.get() == it }, random32 = { request.creationAttemptId.copyBytes() })
        cancelCurrent.set { operation, session -> coordinator.cancel(operation.copyBytes(), session.copyBytes()) }
        coordinator.prepare(WitnessPreparationRequest(request.operationId.copyBytes(), request.sessionDigest.copyBytes(),
            request.replica, request.enrollmentId.copyBytes(), request.recipient.copyBytes())) { result ->
            callback(when (result) {
                is WitnessResult.Stored -> {
                    val snapshot = observe()
                    if (snapshot is WitnessResult.Stored) snapshot.mapSnapshot(request, result.value.enrollment)
                    else snapshot.mapSnapshot(request, null)
                }
                is WitnessResult.Refused -> result
                WitnessResult.Missing -> WitnessResult.Missing
            })
        }
    }

    private fun generate(request: WitnessPrivateRequest.Generate, callback: (WitnessResult<ByteArray>) -> Unit) {
        val coordinator = WitnessGenerationCoordinator(activity, signer.copyBytes(), ui,
            sessionValid = { validSession.get() == it })
        cancelCurrent.set { operation, session -> coordinator.cancel(operation.copyBytes(), session.copyBytes()) }
        coordinator.generate(WitnessGenerationRequest(request.expectedRevision, request.creationAttemptId.copyBytes(),
            request.generationChallenge.copyBytes(), request.operationId.copyBytes(), request.sessionDigest.copyBytes())) {
            callback(it.mapSnapshot(request, null))
        }
    }

    private fun proof(request: WitnessPrivateRequest.Proof, callback: (WitnessResult<ByteArray>) -> Unit) {
        val snapshot = observe()
        if (snapshot !is WitnessResult.Stored) { callback(snapshot.mapSnapshot(request, null)); return }
        val enrollment = snapshot.value.enrollments.singleOrNull { it.enrollmentId == request.enrollmentId }
        if (enrollment == null) { callback(WitnessResult.Refused("enrollment_mismatch")); return }
        cancelCurrent.set { operation, session -> binding.cancel(operation.copyBytes(), session.copyBytes()) }
        binding.prepareBinding(WitnessBindingRequest(request.expectedRevision, request.replica,
            request.enrollmentId.copyBytes(), request.recipient.copyBytes(), request.freshValidatorNonce.copyBytes(),
            enrollment.creationAttemptId.copyBytes(), request.nativeNonce.copyBytes(), request.sessionDigest.copyBytes())) { result ->
            callback(when (result) {
                is WitnessResult.Stored -> handles.register(request.operationId, request.sessionDigest, result.value).also {
                    if (it is WitnessResult.Stored) cancelCurrent.set(handles::cancel)
                }
                is WitnessResult.Refused -> result
                WitnessResult.Missing -> WitnessResult.Missing
            })
        }
    }

    private fun WitnessResult<WitnessSnapshot>.mapSnapshot(request: WitnessPrivateRequest,
        enrollment: WitnessEnrollment?): WitnessResult<ByteArray> = when (this) {
        is WitnessResult.Stored -> WitnessPrivateSnapshotResponses.encode(kind(request), request.operationId,
            request.sessionDigest, value, enrollment)?.let { WitnessResult.Stored(it) }
            ?: WitnessResult.Refused("invalid_private_response")
        is WitnessResult.Refused -> this
        WitnessResult.Missing -> WitnessResult.Missing
    }

    private fun kind(request: WitnessPrivateRequest) = when (request) {
        is WitnessPrivateRequest.Identity -> WitnessPrivateKind.IDENTITY
        is WitnessPrivateRequest.Prepare -> WitnessPrivateKind.PREPARE
        is WitnessPrivateRequest.Generate -> WitnessPrivateKind.GENERATE
        else -> WitnessPrivateKind.PROOF
    }
}
