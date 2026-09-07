package dev.treetop.lattice.treehouse.witness

import java.util.Base64
import java.util.Properties
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import dev.treetop.lattice.treehouse.BuildConfig
import org.junit.Assert.*
import org.junit.Test

class BindingCodecTest {
    private val keys = listOf("enrollmentId", "recipient", "creationAttemptId", "actualWitnessPublicKey",
        "generationChallengeDigest", "freshValidatorNonce", "nativeRandomNonce", "nativeCallerSessionDigest")

    @Test fun exactBeamBytesAndOwnedInputs() {
        val fixture = Properties().apply {
            BindingCodecTest::class.java.classLoader!!.getResourceAsStream("binding_vectors.properties")!!.use { load(it) }
        }
        assertEquals("treehouse", BuildConfig.LATTICE_PRODUCT)
        assertEquals(BuildConfig.APPLICATION_ID, BuildConfig.LATTICE_APP_ID)
        assertFalse(BuildConfig.WITNESS_ELIGIBILITY_IMPLEMENTED)
        assertEquals(BuildConfig.BUILD_TYPE == "release", BuildConfig.PILOT_SIGNED)
        for (index in 0 until fixture.getProperty("count").toInt()) {
            val binary = keys.map { Base64.getDecoder().decode(fixture.getProperty("$index.$it")) }
            val claim = namedClaim(fixture.getProperty("$index.replica"), binary)
            val expected = Base64.getDecoder().decode(fixture.getProperty("$index.canonicalBase64"))
            assertArrayEquals(expected, BindingCodec.encode(claim))
            val prefix = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
            val key = KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(prefix + binary[3]))
            val verifier = Signature.getInstance("Ed25519")
            verifier.initVerify(key); verifier.update(expected)
            assertTrue(verifier.verify(Base64.getDecoder().decode(fixture.getProperty("$index.signatureBase64"))))
            for (field in binary.indices) {
                val swapped = binary.toMutableList()
                val other = (field + 1) % binary.size
                swapped[field] = binary[other]
                swapped[other] = binary[field]
                val changed = BindingCodec.encode(namedClaim(fixture.getProperty("$index.replica"), swapped))
                assertFalse(expected.contentEquals(changed))
                verifier.initVerify(key); verifier.update(changed)
                assertFalse(verifier.verify(Base64.getDecoder().decode(fixture.getProperty("$index.signatureBase64"))))
            }
            claim.enrollmentId.fill(0)
            claim.nativeCallerSessionDigest.fill(0)
            binary.forEach { it.fill(0) }
            BindingCodec.encode(claim).fill(0)
            assertArrayEquals(expected, BindingCodec.encode(claim))
        }
    }

    private fun namedClaim(replica: String, fields: List<ByteArray>) = PublicBindingClaim(
        replica = replica, enrollmentId = fields[0], recipient = fields[1],
        creationAttemptId = fields[2], actualWitnessPublicKey = fields[3],
        generationChallengeDigest = fields[4], freshValidatorNonce = fields[5],
        nativeRandomNonce = fields[6], nativeCallerSessionDigest = fields[7])

    @Test fun malformedShapeRefuses() {
        val valid = List(8) { ByteArray(32) }
        for (replica in listOf("", "a".repeat(513), "🌲".repeat(129), "\uD800", "\uDC00")) {
            assertThrows(Exception::class.java) { namedClaim(replica, valid) }
        }
        for (field in valid.indices) for (width in listOf(0, 31, 33)) {
            val malformed = valid.toMutableList().also { it[field] = ByteArray(width) }
            assertThrows(IllegalArgumentException::class.java) { namedClaim("replica", malformed) }
        }
    }
}
