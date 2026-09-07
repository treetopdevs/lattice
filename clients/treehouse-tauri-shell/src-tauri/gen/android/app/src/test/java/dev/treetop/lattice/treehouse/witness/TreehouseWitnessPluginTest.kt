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
