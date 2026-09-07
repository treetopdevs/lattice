package dev.treetop.lattice.treehouse.witness

import android.util.Base64
import app.tauri.annotation.Command
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class TreehouseWitnessPluginTest {
    private class Runtime : WitnessPrivateRuntime {
        var callback: ((WitnessResult<ByteArray>) -> Unit)? = null
        val callbacks = mutableListOf<(WitnessResult<ByteArray>) -> Unit>()
        var calls = 0
        var cancels = 0
        var cancelResult = true
        var throwBeforeCallback = false
        var throwAfterCallback = false
        override fun execute(request: WitnessPrivateRequest, callback: (WitnessResult<ByteArray>) -> Unit) {
            if (throwBeforeCallback) throw IllegalStateException("runtime construction failed")
            calls++; this.callback = callback; callbacks.add(callback)
            if (throwAfterCallback) {
                callback(WitnessResult.Stored(byteArrayOf(7)))
                throw IllegalStateException("runtime failed after callback")
            }
        }
        override fun cancel(operationId: WitnessBytes, session: WitnessBytes): Boolean { cancels++; return cancelResult }
    }

    @Test fun runtimeExceptionCompletesExactlyOnceAndReleasesOperationOwnership() {
        val runtime = Runtime().also { it.throwBeforeCallback = true }
        val dispatch = WitnessPrivateDispatch(runtime)
        val results = mutableListOf<WitnessResult<ByteArray>>()
        dispatch.dispatch(WitnessPrivateRequest.Identity(w(1), w(9)), results::add)
        assertEquals(listOf(WitnessResult.Refused("native_failed")), results)
        runtime.throwBeforeCallback = false
        dispatch.dispatch(WitnessPrivateRequest.Identity(w(2), w(9)), results::add)
        assertEquals(1, runtime.calls)
    }

    @Test fun callbackThenRuntimeExceptionCannotResolveTwiceOrStealNextOwner() {
        val runtime = Runtime().also { it.throwAfterCallback = true }
        val dispatch = WitnessPrivateDispatch(runtime)
        val results = mutableListOf<WitnessResult<ByteArray>>()
        dispatch.dispatch(WitnessPrivateRequest.Identity(w(1), w(9)), results::add)
        assertEquals(1, results.size)
        assertArrayEquals(byteArrayOf(7), (results.single() as WitnessResult.Stored).value)
        runtime.throwAfterCallback = false
        dispatch.dispatch(WitnessPrivateRequest.Identity(w(2), w(9)), results::add)
        assertEquals(2, runtime.calls)
    }

    @Test fun overlappingOperationRefusesAndCancellationSuppressesLateResult() {
        val runtime = Runtime(); val dispatch = WitnessPrivateDispatch(runtime)
        val first = WitnessPrivateRequest.Identity(w(1), w(9))
        val results = mutableListOf<WitnessResult<ByteArray>>()
        dispatch.dispatch(first, results::add)
        dispatch.dispatch(WitnessPrivateRequest.Identity(w(2), w(9)), results::add)
        assertEquals(1, runtime.calls)
        assertTrue(results.single().toString(), results.single() is WitnessResult.Stored)
        assertEquals("storage_busy", terminal(results.single()).reason)
        dispatch.dispatch(WitnessPrivateRequest.Cancel(w(3), w(9), w(1)), results::add)
        assertEquals(WitnessResult.Refused("cancelled"), results[1])
        assertEquals(WitnessTerminalStatus.CANCELLED, terminal(results.last()).status)
        runtime.callback!!(WitnessResult.Stored(byteArrayOf(1)))
        assertEquals(3, results.size)
        assertEquals(1, runtime.cancels)
    }

    @Test fun preparedProofKeepsTheSingleOwnerForExactReentrantSign() {
        val runtime = Runtime(); val dispatch = WitnessPrivateDispatch(runtime)
        val results = mutableListOf<WitnessResult<ByteArray>>()
        dispatch.dispatch(proof(), results::add)
        runtime.callback!!(WitnessResult.Stored("prepared".toByteArray()))
        assertArrayEquals("prepared".toByteArray(), (results.single() as WitnessResult.Stored).value)
        dispatch.dispatch(WitnessPrivateRequest.SignPrepared(w(1), w(9), w(8)), results::add)
        assertEquals(2, runtime.calls)
        runtime.callback!!(WitnessResult.Stored("signed".toByteArray()))
        assertArrayEquals("signed".toByteArray(), (results.last() as WitnessResult.Stored).value)
        dispatch.dispatch(WitnessPrivateRequest.SignPrepared(w(1), w(9), w(8)), results::add)
        assertEquals("storage_busy", terminal(results.last()).reason)
    }

    @Test fun preparedDeliveryWinsReentrantCancellationAndRemainsSignable() {
        val runtime = Runtime(); val dispatch = WitnessPrivateDispatch(runtime)
        val results = mutableListOf<WitnessResult<ByteArray>>()
        dispatch.dispatch(proof()) { prepared ->
            results.add(prepared)
            dispatch.dispatch(WitnessPrivateRequest.Cancel(w(7), w(9), w(1)), results::add)
        }
        runtime.callback!!(WitnessResult.Stored("prepared".toByteArray()))
        assertArrayEquals("prepared".toByteArray(), (results.first() as WitnessResult.Stored).value)
        assertEquals(WitnessTerminalStatus.MISSING, terminal(results.last()).status)
        assertEquals(0, runtime.cancels)
        dispatch.dispatch(WitnessPrivateRequest.SignPrepared(w(1), w(9), w(8)), results::add)
        assertEquals(2, runtime.calls)
    }

    @Test fun duplicateAndLateProofCallbacksCannotStealSignDelivery() {
        val runtime = Runtime(); val dispatch = WitnessPrivateDispatch(runtime)
        val results = mutableListOf<WitnessResult<ByteArray>>()
        dispatch.dispatch(proof(), results::add)
        val proofCallback = runtime.callbacks.single()
        proofCallback(WitnessResult.Stored("prepared".toByteArray()))
        proofCallback(WitnessResult.Stored("duplicate".toByteArray()))
        proofCallback(WitnessResult.Refused("duplicate"))
        proofCallback(WitnessResult.Missing)
        assertEquals(1, results.size)
        dispatch.dispatch(WitnessPrivateRequest.SignPrepared(w(1), w(9), w(8)), results::add)
        proofCallback(WitnessResult.Stored("late".toByteArray()))
        assertEquals(1, results.size)
        runtime.callbacks.last()(WitnessResult.Stored("signed".toByteArray()))
        assertEquals(2, results.size)
        assertArrayEquals("signed".toByteArray(), (results.last() as WitnessResult.Stored).value)
    }

    @Test fun lifecycleInvalidationCancelsOwnerAndDropsCallback() {
        val runtime = Runtime(); val dispatch = WitnessPrivateDispatch(runtime)
        val results = mutableListOf<WitnessResult<ByteArray>>()
        dispatch.dispatch(WitnessPrivateRequest.Identity(w(1), w(9)), results::add)
        dispatch.invalidate()
        assertEquals(WitnessResult.Refused("cancelled"), results.single())
        runtime.callback!!(WitnessResult.Stored(byteArrayOf(1)))
        assertEquals(1, results.size)
        assertEquals(1, runtime.cancels)
    }

    @Test fun cancelledPendingProofCannotReleaseLatePreparedHandle() {
        val runtime = Runtime(); val dispatch = WitnessPrivateDispatch(runtime)
        val results = mutableListOf<WitnessResult<ByteArray>>()
        dispatch.dispatch(proof(), results::add)
        dispatch.dispatch(WitnessPrivateRequest.Cancel(w(7), w(9), w(1)), results::add)
        assertEquals(WitnessResult.Refused("cancelled"), results.first())
        assertEquals(WitnessTerminalStatus.CANCELLED, terminal(results.last()).status)
        runtime.callback!!(WitnessResult.Stored("prepared".toByteArray()))
        assertEquals(2, results.size)
    }

    @Test fun cancellationThatLosesDeliveryDoesNotSuppressOwnedResult() {
        val runtime = Runtime().also { it.cancelResult = false }
        val dispatch = WitnessPrivateDispatch(runtime)
        val results = mutableListOf<WitnessResult<ByteArray>>()
        dispatch.dispatch(WitnessPrivateRequest.Identity(w(1), w(9)), results::add)
        dispatch.dispatch(WitnessPrivateRequest.Cancel(w(2), w(9), w(1)), results::add)
        assertEquals(WitnessTerminalStatus.MISSING, terminal(results.single()).status)
        runtime.callback!!(WitnessResult.Stored(byteArrayOf(7)))
        assertArrayEquals(byteArrayOf(7), (results.last() as WitnessResult.Stored).value)
    }

    @Test fun actualCommandBoundaryConsumesRawObjectAndProducesJsObject() {
        val raw = "{\"protocol\":\"${WitnessPrivateProtocol.PROTOCOL}\",\"kind\":\"identity\"," +
            "\"operationId\":\"${b64(1)}\",\"sessionDigest\":\"${b64(9)}\"}"
        assertTrue(WitnessInvokeBoundary.decode(raw) is WitnessPrivateRequest.Identity)
        assertNull(WitnessInvokeBoundary.decode(raw.dropLast(1) + ",\"extra\":\"x\"}"))
        val response = WitnessPrivateProtocol.encodeTerminal(WitnessTerminalResponse(WitnessPrivateKind.IDENTITY,
            w(1), WitnessTerminalStatus.MISSING))!!
        val objectValue = WitnessInvokeBoundary.response(response)!!
        assertEquals("missing", objectValue.getString("status"))
        val method = TreehouseWitnessPlugin::class.java.getDeclaredMethod("dispatch", app.tauri.plugin.Invoke::class.java)
        assertNotNull(method.getAnnotation(Command::class.java))
    }

    private fun terminal(value: WitnessResult<ByteArray>) = WitnessPrivateProtocol.decodeTerminal((value as WitnessResult.Stored).value)!!
    private fun proof() = WitnessPrivateRequest.Proof(w(1), w(9), 1, "replica", w(2), w(3), w(4), w(5))
    private fun w(value: Int) = WitnessBytes(ByteArray(32) { value.toByte() })
    private fun b64(value: Int) = Base64.encodeToString(ByteArray(32) { value.toByte() }, Base64.NO_WRAP)
}
