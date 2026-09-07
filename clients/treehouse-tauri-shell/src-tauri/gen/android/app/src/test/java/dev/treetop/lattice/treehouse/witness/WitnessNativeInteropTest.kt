package dev.treetop.lattice.treehouse.witness

import java.io.File
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Host-only codec evidence. This public RFC8032 software seed is never a custody key. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class WitnessNativeInteropTest {
    private val replica = "line\n\"é😀"
    private fun bytes(n: Int) = ByteArray(32) { n.toByte() }
    private fun w(n: Int) = WitnessBytes(bytes(n))
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private val publicKey = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    private fun fixture(name: String) = checkNotNull(javaClass.getResourceAsStream("/native_interop/$name")).use { it.readBytes() }
    private fun compareOrExport(name: String, bytes: ByteArray) {
        val export = System.getenv("TREEHOUSE_INTEROP_EXPORT_DIR")
        if (export != null) File(export, name).writeBytes(bytes) else assertArrayEquals(name, fixture(name), bytes)
    }

    @Test fun actualRustRequestsDecodeToExactNativeValues() {
        val requests = JSONArray(String(fixture("rust_requests.json"), Charsets.UTF_8))
        val expected = listOf(
            WitnessPrivateRequest.Identity(w(7), w(8)),
            WitnessPrivateRequest.Prepare(w(7), w(8), replica, w(1), w(2), w(3)),
            WitnessPrivateRequest.Generate(w(7), w(8), Long.MAX_VALUE, w(3), w(4)),
            WitnessPrivateRequest.Proof(w(7), w(8), 1, replica, w(1), w(2), w(5), w(6)),
            WitnessPrivateRequest.SignPrepared(w(7), w(8), w(9)),
            WitnessPrivateRequest.Cancel(w(7), w(8), w(10)),
        )
        assertEquals(expected.size, requests.length())
        expected.forEachIndexed { index, request ->
            val raw = requests.getString(index)
            assertEquals(request, WitnessPrivateProtocol.decodeRequest(raw.toByteArray()))
            for (field in listOf("operationId", "sessionDigest")) {
                assertNull(WitnessPrivateProtocol.decodeRequest(JSONObject(raw).put(field, JSONObject.NULL).toString().toByteArray()))
            }
            assertNull(WitnessPrivateProtocol.decodeRequest(raw.replaceFirst("{", "{\"extra\":\"caller\",").toByteArray()))
            assertNull(WitnessPrivateProtocol.decodeRequest(raw.replaceFirst("{", "{\"operati\\u006fnId\":\"duplicate\",").toByteArray()))
        }
        for ((index, field) in listOf(3 to "nativeNonce", 3 to "freshValidatorNonce", 4 to "handle")) {
            val value = JSONObject(requests.getString(index))
            for (bad in listOf("AA==", "", "A".repeat(43)))
                assertNull(WitnessPrivateProtocol.decodeRequest(JSONObject(value.toString()).put(field, bad).toString().toByteArray()))
            value.remove(field)
            assertNull(WitnessPrivateProtocol.decodeRequest(value.toString().toByteArray()))
        }
    }

    @Test fun actualKotlinProducersReproduceSnapshotsProofAndTerminalBytes() {
        val metadata = CapturedWitnessIdentity(publicKey,
            hex("302a300506032b6570032100") + publicKey, bytes(12), "9223372036854775807", listOf(byteArrayOf(1, 2, 3)))
        val enrollment = WitnessEnrollment(bytes(1), replica, bytes(2), bytes(3))
        for ((phase, label) in listOf(WitnessPhase.PREPARED to "prepared", WitnessPhase.GENERATION_STARTED to "started", WitnessPhase.GENERATED_UNVALIDATED to "generated")) {
            val identity = WitnessIdentityRecord(w(3), phase, if (phase == WitnessPhase.PREPARED) null else w(4),
                if (phase == WitnessPhase.GENERATED_UNVALIDATED) metadata else null, 9)
            val snapshot = WitnessSnapshot(identity, listOf(enrollment), emptyList())
            compareOrExport("kotlin_identity_$label.json", checkNotNull(WitnessPrivateSnapshotResponses.encode(
                WitnessPrivateKind.IDENTITY, w(7), w(8), snapshot, null)))
            if (phase == WitnessPhase.PREPARED) compareOrExport("kotlin_prepare.json", checkNotNull(WitnessPrivateSnapshotResponses.encode(
                WitnessPrivateKind.PREPARE, w(7), w(8), snapshot, enrollment)))
            if (phase == WitnessPhase.GENERATED_UNVALIDATED) compareOrExport("kotlin_generate.json", checkNotNull(WitnessPrivateSnapshotResponses.encode(
                WitnessPrivateKind.GENERATE, w(7), w(8), snapshot, null)))
        }
        val claim = PublicBindingClaim(replica, bytes(1), bytes(2), bytes(3), publicKey, bytes(4), bytes(5), bytes(6), bytes(8))
        val claimBytes = BindingCodec.encode(claim)
        compareOrExport("kotlin_claim.bin", claimBytes)
        val privateKey = KeyFactory.getInstance("Ed25519").generatePrivate(PKCS8EncodedKeySpec(
            hex("302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")))
        val signature = Signature.getInstance("Ed25519").run { initSign(privateKey); update(claimBytes); sign() }
        compareOrExport("kotlin_prepared.json", checkNotNull(WitnessPrivateBindingResponses.prepared(w(7), w(8), w(9),
            PreparedWitnessBinding(object: WitnessBindingHandle {}, claim, 60_000))))
        compareOrExport("kotlin_signed.json", checkNotNull(WitnessPrivateBindingResponses.signed(w(7), w(8), w(9), SignedWitnessBinding(claim, signature))))
        for ((status, name) in listOf(WitnessTerminalStatus.MISSING to "missing", WitnessTerminalStatus.REFUSED to "refused", WitnessTerminalStatus.CANCELLED to "cancelled")) {
            compareOrExport("kotlin_$name.json", checkNotNull(WitnessPrivateProtocol.encodeTerminal(WitnessTerminalResponse(
                WitnessPrivateKind.PROOF, w(7), status, if (status == WitnessTerminalStatus.REFUSED) "storage_busy" else null))))
        }
    }
}
