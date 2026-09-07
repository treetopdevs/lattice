package dev.treetop.lattice.treehouse.witness

import java.nio.charset.StandardCharsets
import java.io.ByteArrayOutputStream
import dev.treetop.lattice.treehouse.BuildConfig

/** Proposed public facts only. It has no native consent, key or signing interface. */
class PublicBindingClaim(
    replica: String,
    enrollmentId: ByteArray,
    recipient: ByteArray,
    creationAttemptId: ByteArray,
    actualWitnessPublicKey: ByteArray,
    generationChallengeDigest: ByteArray,
    freshValidatorNonce: ByteArray,
    nativeRandomNonce: ByteArray,
    nativeCallerSessionDigest: ByteArray,
) {
    private val replicaBytes = witnessUtf8(replica, 512)
    private val binaryFields = listOf(enrollmentId, recipient, creationAttemptId, actualWitnessPublicKey,
        generationChallengeDigest, freshValidatorNonce, nativeRandomNonce, nativeCallerSessionDigest)
        .map { require(it.size == 32) { "invalid_binding_fields" }; it.copyOf() }
    val enrollmentId: ByteArray get() = binaryFields[0].copyOf()
    val recipient: ByteArray get() = binaryFields[1].copyOf()
    val creationAttemptId: ByteArray get() = binaryFields[2].copyOf()
    val actualWitnessPublicKey: ByteArray get() = binaryFields[3].copyOf()
    val generationChallengeDigest: ByteArray get() = binaryFields[4].copyOf()
    val freshValidatorNonce: ByteArray get() = binaryFields[5].copyOf()
    val nativeRandomNonce: ByteArray get() = binaryFields[6].copyOf()
    val nativeCallerSessionDigest: ByteArray get() = binaryFields[7].copyOf()
    internal fun fieldCopies(): List<ByteArray> = binaryFields.map { it.copyOf() }
    internal fun replicaCopy(): ByteArray = replicaBytes.copyOf()
}

object BindingCodec {
    fun encode(claim: PublicBindingClaim): ByteArray {
        val output = ByteArrayOutputStream()
        output.write(0x8d)
        binary(output, "lattice-witness-binding-challenge-v1".toByteArray(StandardCharsets.UTF_8))
        output.write(1)
        binary(output, BuildConfig.LATTICE_PRODUCT.toByteArray(StandardCharsets.UTF_8))
        binary(output, BuildConfig.LATTICE_APP_ID.toByteArray(StandardCharsets.UTF_8))
        binary(output, claim.replicaCopy())
        claim.fieldCopies().forEach { binary(output, it) }
        return output.toByteArray()
    }

    private fun binary(output: ByteArrayOutputStream, value: ByteArray) {
        when (value.size) {
            in 0..23 -> output.write(0x40 or value.size)
            in 24..255 -> { output.write(0x58); output.write(value.size) }
            else -> { output.write(0x59); output.write(value.size ushr 8); output.write(value.size and 255) }
        }
        output.write(value)
    }
}
