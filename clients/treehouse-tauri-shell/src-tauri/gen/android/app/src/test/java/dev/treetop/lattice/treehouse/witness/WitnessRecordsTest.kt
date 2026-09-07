package dev.treetop.lattice.treehouse.witness

import org.junit.Assert.*
import org.junit.Test

class WitnessRecordsTest {
    @Test fun namedRecordsOwnAllInputAndOutputBytes() {
        val original = ByteArray(32) { (it + 1).toByte() }
        val enrollment = WitnessEnrollment(original, "replica", original, original)
        original.fill(0)
        enrollment.enrollmentId.copyBytes().fill(0)
        assertEquals(1.toByte(), enrollment.enrollmentId.copyBytes()[0])
        val key = ByteArray(32) { 9 }
        val chain = mutableListOf(byteArrayOf(1, 2, 3))
        val capture = CapturedWitnessIdentity(key, ed25519Prefix() + key, ByteArray(32) { 7 }, "1", chain)
        chain[0].fill(0); chain.clear(); key.fill(0)
        capture.certificateChain[0].copyBytes().fill(0)
        assertArrayEquals(byteArrayOf(1, 2, 3), capture.certificateChain.single().copyBytes())
        assertEquals(9.toByte(), capture.publicKey.copyBytes()[0])
    }

    @Test fun malformedOrOversizedPublicRecordsRefuse() {
        val key = ByteArray(32) { 9 }
        for (width in listOf(0, 31, 33)) assertThrows(IllegalArgumentException::class.java) {
            WitnessEnrollment(ByteArray(width), "replica", key, key)
        }
        for (replica in listOf("", "x".repeat(513), "🌲".repeat(129), "\uD800")) assertThrows(IllegalArgumentException::class.java) {
            WitnessEnrollment(key, replica, key, key)
        }
        for (version in listOf("0", "01", "+1", "1.0", "9223372036854775808")) assertThrows(IllegalArgumentException::class.java) {
            CapturedWitnessIdentity(key, ed25519Prefix() + key, key, version, listOf(byteArrayOf(1)))
        }
        for (chain in listOf(emptyList(), List(9) { byteArrayOf(1) }, listOf(ByteArray(0)), listOf(ByteArray(16385)), List(5) { ByteArray(16384) })) {
            assertThrows(IllegalArgumentException::class.java) { CapturedWitnessIdentity(key, ed25519Prefix() + key, key, "1", chain) }
        }
        val valid = CapturedWitnessIdentity(key, ed25519Prefix() + key, key, "9223372036854775807", List(4) { ByteArray(16384) })
        assertEquals(65536, valid.certificateChain.sumOf { it.size })
        assertThrows(IllegalArgumentException::class.java) { CapturedWitnessIdentity(key, ed25519Prefix() + ByteArray(32), key, "1", listOf(byteArrayOf(1))) }
    }

    private fun ed25519Prefix() = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
}
