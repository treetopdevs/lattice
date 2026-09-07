package dev.treetop.lattice.treehouse.witness

import java.util.Base64
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class WitnessPrivateBindingResponsesTest {
    @Test fun coordinatorPreparedAndSignedValuesEncodeExactRustSchemas() {
        val claim = claim()
        val prepared = PreparedWitnessBinding(object: WitnessBindingHandle {}, claim, 60_000)
        val output = checkNotNull(WitnessPrivateBindingResponses.prepared(w(1), w(9), w(2), prepared))
        val decoded = JSONObject(String(output))
        assertEquals(setOf("protocol", "kind", "operationId", "sessionDigest", "status", "handle", "claim", "remainingMillis"), keys(decoded))
        assertEquals(WitnessPrivateProtocol.PROTOCOL, decoded.getString("protocol"))
        assertEquals("proof", decoded.getString("kind"))
        assertEquals("prepared", decoded.getString("status"))
        assertEquals(60_000L, decoded.getLong("remainingMillis"))
        assertEquals(setOf("replica", "enrollmentId", "recipient", "creationAttemptId", "actualWitnessPublicKey", "generationChallengeDigest", "freshValidatorNonce", "nativeRandomNonce", "nativeCallerSessionDigest"), keys(decoded.getJSONObject("claim")))
        assertEquals("line\n\"é😀", decoded.getJSONObject("claim").getString("replica"))
        val signed = JSONObject(String(checkNotNull(WitnessPrivateBindingResponses.signed(w(1), w(9), w(2), SignedWitnessBinding(claim, ByteArray(64) { 5 })))))
        assertEquals(setOf("protocol", "kind", "operationId", "sessionDigest", "status", "handle", "claim", "signature"), keys(signed))
        assertEquals("signed", signed.getString("status"))
        assertEquals("proof", signed.getString("kind"))
        assertArrayEquals(ByteArray(64) { 5 }, Base64.getDecoder().decode(signed.getString("signature")))
        assertTrue(output.size <= WitnessPrivateProtocol.MAX_MESSAGE)
    }

    @Test fun malformedNativeEnvelopeFieldsAndLifetimesRefuse() {
        val handle = object: WitnessBindingHandle {}
        for (remaining in listOf(-1L, 0L, 60_001L, Long.MAX_VALUE))
            assertNull(WitnessPrivateBindingResponses.prepared(w(1), w(9), w(2), PreparedWitnessBinding(handle, claim(), remaining)))
        for (remaining in listOf(1L, 60_000L))
            assertNotNull(WitnessPrivateBindingResponses.prepared(w(1), w(9), w(2), PreparedWitnessBinding(handle, claim(), remaining)))
        val prepared = PreparedWitnessBinding(handle, claim(), 1)
        assertNull(WitnessPrivateBindingResponses.prepared(WitnessBytes(byteArrayOf()), w(9), w(2), prepared))
        assertNull(WitnessPrivateBindingResponses.prepared(w(1), w(9), WitnessBytes(ByteArray(33)), prepared))
        assertNull(WitnessPrivateBindingResponses.prepared(w(1), w(8), w(2), prepared))
        assertNull(WitnessPrivateBindingResponses.signed(w(1), w(8), w(2), SignedWitnessBinding(claim(), ByteArray(64))))
    }

    @Test fun androidBase64PreservesCanonicalPaddingWithoutLineWrapping() {
        val signed = SignedWitnessBinding(claim(), ByteArray(64) { 0xff.toByte() })
        val encoded = JSONObject(String(checkNotNull(WitnessPrivateBindingResponses.signed(w(1), w(9), w(2), signed))))
        val signature = encoded.getString("signature")
        assertEquals(android.util.Base64.encodeToString(signed.signature, android.util.Base64.NO_WRAP), signature)
        assertEquals(88, signature.length)
        assertTrue(signature.endsWith("=="))
        assertFalse(signature.contains('\n'))
        assertEquals(android.util.Base64.encodeToString(w(1).copyBytes(), android.util.Base64.NO_WRAP), encoded.getString("operationId"))
        assertEquals(44, encoded.getString("operationId").length)
        assertArrayEquals(signed.signature, android.util.Base64.decode(signature, android.util.Base64.NO_WRAP))
    }

    private fun keys(json: JSONObject): Set<String> = json.keys().asSequence().toSet()
    private fun w(v: Int) = WitnessBytes(ByteArray(32) { v.toByte() })
    private fun claim() = PublicBindingClaim("line\n\"é😀", bytes(1), bytes(2), bytes(3), bytes(4), bytes(5), bytes(6), bytes(7), bytes(9))
    private fun bytes(v: Int) = ByteArray(32) { v.toByte() }
}
