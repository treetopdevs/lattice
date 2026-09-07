package dev.treetop.lattice.treehouse.witness

import java.util.Base64
import org.junit.Assert.*
import org.junit.Test

@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk = [33])
class WitnessPrivateProtocolTest {
    @Test fun allClosedRequestsDecode() {
        val common="\"protocol\":\"${WitnessPrivateProtocol.PROTOCOL}\",\"operationId\":\"${b(1)}\",\"sessionDigest\":\"${b(2)}\""
        val requests=listOf(
            "{\"kind\":\"identity\",$common}",
            "{\"kind\":\"prepare\",$common,\"replica\":\"replica:test\",\"enrollmentId\":\"${b(3)}\",\"recipient\":\"${b(4)}\",\"creationAttemptId\":\"${b(5)}\"}",
            "{\"kind\":\"generate\",$common,\"expectedRevision\":\"7\",\"creationAttemptId\":\"${b(5)}\",\"generationChallenge\":\"${b(6)}\"}",
            "{\"kind\":\"proof\",$common,\"expectedRevision\":\"7\",\"replica\":\"replica:test\",\"enrollmentId\":\"${b(3)}\",\"recipient\":\"${b(4)}\",\"freshValidatorNonce\":\"${b(7)}\"}",
            "{\"kind\":\"cancel\",$common,\"targetOperationId\":\"${b(8)}\"}")
        assertTrue(WitnessPrivateProtocol.decodeRequest(requests[0].toByteArray()) is WitnessPrivateRequest.Identity)
        assertTrue(WitnessPrivateProtocol.decodeRequest(requests[1].toByteArray()) is WitnessPrivateRequest.Prepare)
        assertTrue(WitnessPrivateProtocol.decodeRequest(requests[2].toByteArray()) is WitnessPrivateRequest.Generate)
        assertTrue(WitnessPrivateProtocol.decodeRequest(requests[3].toByteArray()) is WitnessPrivateRequest.Proof)
        assertTrue(WitnessPrivateProtocol.decodeRequest(requests[4].toByteArray()) is WitnessPrivateRequest.Cancel)
    }

    @Test fun duplicateExtraWrongTypeNoncanonicalAndBoundsRefuse() {
        val base="{\"kind\":\"identity\",\"protocol\":\"${WitnessPrivateProtocol.PROTOCOL}\",\"operationId\":\"${b(1)}\",\"sessionDigest\":\"${b(2)}\"}"
        val bad=listOf(base.replace("\"operationId\":", "\"extra\":\"x\",\"operationId\":"), base.replace("\"operationId\":", "\"operationId\":\"${b(9)}\",\"operationId\":"), base.replace("\"${b(1)}\"", "7"), base.replace(b(1), b(1).replace("=","")), base+"x")
        bad.forEach { assertNull(WitnessPrivateProtocol.decodeRequest(it.toByteArray())) }
        assertNull(WitnessPrivateProtocol.decodeRequest(ByteArray(WitnessPrivateProtocol.MAX_MESSAGE+1)))
        assertNull(WitnessPrivateProtocol.decodeRequest(byteArrayOf(0xff.toByte())))
    }

    @Test fun sessionDigestMatchesRustAndTerminalFramingIsClosed() {
        assertEquals("+B2fiDqLxK9o9j2jlmOX6x5qPkg4Aj8eLsDRiGIe3po=", b(WitnessPrivateProtocol.sessionDigest(bytes(1),bytes(2)).copyBytes()))
        val response=WitnessTerminalResponse(WitnessPrivateKind.GENERATE, WitnessBytes(bytes(1)), WitnessTerminalStatus.REFUSED, "storage_busy")
        assertEquals(response, WitnessPrivateProtocol.decodeTerminal(checkNotNull(WitnessPrivateProtocol.encodeTerminal(response))))
        assertNull(WitnessPrivateProtocol.encodeTerminal(response.copy(reason="Bad reason")))
        val encoded=String(checkNotNull(WitnessPrivateProtocol.encodeTerminal(response)))
        assertNull(WitnessPrivateProtocol.decodeTerminal(encoded.replace("\"refused\"","\"REFUSED\"").toByteArray()))
        assertNull(WitnessPrivateProtocol.decodeTerminal(encoded.replace("\"reason\":\"storage_busy\"","\"reason\":null").toByteArray()))
    }

    @Test fun escapedReplicaAndDecodedDuplicateKeysMatchRustStrictness() {
        val common="\"protocol\":\"${WitnessPrivateProtocol.PROTOCOL}\",\"operationId\":\"${b(1)}\",\"sessionDigest\":\"${b(2)}\""
        val valid="{\"kind\":\"prepare\",$common,\"replica\":\"line\\n\\\"\\u00e9\",\"enrollmentId\":\"${b(3)}\",\"recipient\":\"${b(4)}\",\"creationAttemptId\":\"${b(5)}\"}"
        assertEquals("line\n\"é", (WitnessPrivateProtocol.decodeRequest(valid.toByteArray()) as WitnessPrivateRequest.Prepare).replica)
        assertTrue(WitnessPrivateProtocol.decodeRequest(valid.replace("line\\n\\\"\\u00e9", "raw😀").toByteArray()) is WitnessPrivateRequest.Prepare)
        assertNull(WitnessPrivateProtocol.decodeRequest(valid.replace("\"kind\"", "\"k\\u0069nd\":\"prepare\",\"kind\"").toByteArray()))
    }
    @Test fun unicodeEscapesRequireFourAsciiHexDigits() {
        val common="\"protocol\":\"${WitnessPrivateProtocol.PROTOCOL}\",\"operationId\":\"${b(1)}\",\"sessionDigest\":\"${b(2)}\""
        fun prepare(replica: String) = "{\"kind\":\"prepare\",$common,\"replica\":\"$replica\",\"enrollmentId\":\"${b(3)}\",\"recipient\":\"${b(4)}\",\"creationAttemptId\":\"${b(5)}\"}"
        for (escape in listOf("\\u+061", "\\u-061", "\\u٠٠٦١", "\\u００６１")) {
            assertNull(escape, WitnessPrivateProtocol.decodeRequest(prepare(escape).toByteArray()))
        }
        assertEquals("a", (WitnessPrivateProtocol.decodeRequest(prepare("\\u0061").toByteArray()) as WitnessPrivateRequest.Prepare).replica)
    }

    @Test fun revisionsRequireCanonicalAsciiDecimal() {
        fun generate(revision: String) = "{\"kind\":\"generate\",\"protocol\":\"${WitnessPrivateProtocol.PROTOCOL}\",\"operationId\":\"${b(1)}\",\"sessionDigest\":\"${b(2)}\",\"expectedRevision\":\"$revision\",\"creationAttemptId\":\"${b(3)}\",\"generationChallenge\":\"${b(4)}\"}"
        for (revision in listOf("١", "１", "٠1", "０1", "01", "0", "+1", "9223372036854775808")) {
            assertNull(revision, WitnessPrivateProtocol.decodeRequest(generate(revision).toByteArray()))
        }
        for (revision in listOf("1", "9223372036854775807")) {
            assertEquals(revision.toLong(), (WitnessPrivateProtocol.decodeRequest(generate(revision).toByteArray()) as WitnessPrivateRequest.Generate).expectedRevision)
        }
    }

    @Test fun terminalEncodingRejectsNon32ByteOperationIds() {
        for (size in listOf(0, 1, 31, 33, 64)) {
            val invalid = WitnessTerminalResponse(WitnessPrivateKind.IDENTITY, WitnessBytes(ByteArray(size)), WitnessTerminalStatus.MISSING)
            assertNull("size=$size", WitnessPrivateProtocol.encodeTerminal(invalid))
        }
        val valid = WitnessTerminalResponse(WitnessPrivateKind.IDENTITY, WitnessBytes(bytes(1)), WitnessTerminalStatus.MISSING)
        assertEquals(valid, WitnessPrivateProtocol.decodeTerminal(checkNotNull(WitnessPrivateProtocol.encodeTerminal(valid))))
    }
    private fun bytes(v:Int)=ByteArray(32){v.toByte()}
    private fun b(v:Int)=b(bytes(v))
    private fun b(v:ByteArray)=Base64.getEncoder().encodeToString(v)
}
