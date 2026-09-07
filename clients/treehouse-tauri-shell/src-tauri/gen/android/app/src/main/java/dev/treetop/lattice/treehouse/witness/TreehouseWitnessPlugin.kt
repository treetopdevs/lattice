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
import java.util.concurrent.atomic.AtomicReference

/** The only conversion at the Tauri boundary: raw closed JSON in, JSON object out. */
internal object WitnessInvokeBoundary {
    fun decode(raw: String): WitnessPrivateRequest? =
        WitnessPrivateProtocol.decodeRequest(raw.toByteArray(StandardCharsets.UTF_8))
    fun response(bytes: ByteArray): JSObject? = try {
        JSObject(String(bytes, StandardCharsets.UTF_8))
    } catch (_: Exception) { null }
}

@TauriPlugin
class TreehouseWitnessPlugin(private val activity: Activity) : Plugin(activity) {
    private val worker = Executors.newSingleThreadExecutor { task ->
        Thread(task, "treehouse-witness-private-dispatch").apply { isDaemon = true }
    }
    private val flow = AtomicReference<WitnessFlow?>(null)
    private fun selectedFlow(): WitnessFlow? {
        flow.get()?.let { return it }
        val signer = when (val observed = AndroidWitnessProvider(activity).observeCurrentAppSigner()) {
            is WitnessResult.Stored -> observed.value
            else -> return null
        }
        return WitnessFlow(activity, signer.copyBytes(), WitnessNativeReview(activity)).also(flow::set)
    }

    override fun load(webView: WebView) {
        super.load(webView)
        activity.application.registerActivityLifecycleCallbacks(WitnessPluginLifecycle(activity) { flow.get()?.invalidate() })
    }

    @Command
    fun dispatch(invoke: Invoke) {
        val request = WitnessInvokeBoundary.decode(invoke.getRawArgs())
        if (request == null) { invoke.reject("invalid_private_request"); return }
        worker.execute {
            val selected = selectedFlow()
            if (selected == null) { invoke.reject("app_identity_mismatch"); return@execute }
            selected.submit(request) { result ->
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

    private fun kind(request: WitnessPrivateRequest) = when (request) {
        is WitnessPrivateRequest.Identity -> WitnessPrivateKind.IDENTITY
        is WitnessPrivateRequest.Prepare -> WitnessPrivateKind.PREPARE
        is WitnessPrivateRequest.Generate -> WitnessPrivateKind.GENERATE
        is WitnessPrivateRequest.Proof, is WitnessPrivateRequest.SignPrepared -> WitnessPrivateKind.PROOF
        is WitnessPrivateRequest.Cancel -> WitnessPrivateKind.CANCEL
    }
}

private class WitnessPluginLifecycle(private val owner: Activity, private val invalidateFlow: () -> Unit) :
    Application.ActivityLifecycleCallbacks {
    private fun invalidate(changed: Activity) { if (changed === owner) invalidateFlow() }
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
