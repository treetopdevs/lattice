package dev.treetop.lattice.treehouse.witness

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class WitnessPrivateSnapshotResponsesTest {
    @Test fun preparedSnapshotHasExactClosedShapeAndEnrollment() {
        val enrollment = WitnessEnrollment(bytes(2), "line\n\"é😀", bytes(3), bytes(4))
        val snapshot = WitnessSnapshot(WitnessIdentityRecord(w(4), WitnessPhase.PREPARED, null, null, 7), listOf(enrollment), emptyList())
        val json = JSONObject(String(checkNotNull(WitnessPrivateSnapshotResponses.encode(WitnessPrivateKind.PREPARE,
            w(1), w(9), snapshot, enrollment))))
        assertEquals(setOf("protocol","kind","operationId","sessionDigest","status","eligible","identity","enrollment"), keys(json))
        assertFalse(json.getBoolean("eligible"))
        assertEquals("7", json.getJSONObject("identity").getString("revision"))
        assertEquals("line\n\"é😀", json.getJSONObject("enrollment").getString("replica"))
    }

    @Test fun inconsistentPhaseEnrollmentAndOversizedEnvelopeRefuse() {
        val bad = WitnessSnapshot(WitnessIdentityRecord(w(4), WitnessPhase.GENERATION_STARTED, null, null, 1), emptyList(), emptyList())
        assertNull(WitnessPrivateSnapshotResponses.encode(WitnessPrivateKind.IDENTITY, w(1), w(9), bad, null))
        val other = WitnessEnrollment(bytes(2), "replica", bytes(3), bytes(5))
        val good = WitnessSnapshot(WitnessIdentityRecord(w(4), WitnessPhase.PREPARED, null, null, 1), emptyList(), emptyList())
        assertNull(WitnessPrivateSnapshotResponses.encode(WitnessPrivateKind.PREPARE, w(1), w(9), good, other))
    }

    private fun keys(value: JSONObject) = value.keys().asSequence().toSet()
    private fun bytes(value: Int) = ByteArray(32) { value.toByte() }
    private fun w(value: Int) = WitnessBytes(bytes(value))
}
