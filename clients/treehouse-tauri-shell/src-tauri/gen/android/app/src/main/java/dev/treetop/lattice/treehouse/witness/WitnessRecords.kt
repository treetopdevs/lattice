package dev.treetop.lattice.treehouse.witness

import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.Collections

/** Owned public bytes only. Neither this value nor any storage receipt authorizes a key operation. */
internal class WitnessBytes(value: ByteArray) {
    private val bytes = value.copyOf()
    val size: Int get() = bytes.size
    fun copyBytes(): ByteArray = bytes.copyOf()
    override fun equals(other: Any?): Boolean = other is WitnessBytes && bytes.contentEquals(other.bytes)
    override fun hashCode(): Int = bytes.contentHashCode()
}

internal fun witnessUtf8(value: String, maximum: Int): ByteArray {
    val buffer = try {
        StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(value))
    } catch (error: CharacterCodingException) { throw IllegalArgumentException("invalid_replica", error) }
    return ByteArray(buffer.remaining()).also { buffer.get(it); require(it.size in 1..maximum) { "invalid_replica" } }
}

internal fun witness32(value: ByteArray): WitnessBytes {
    require(value.size == 32) { "invalid_public_field" }
    return WitnessBytes(value)
}

internal class WitnessEnrollment(enrollmentId: ByteArray, val replica: String, recipient: ByteArray, creationAttemptId: ByteArray) {
    val enrollmentId = witness32(enrollmentId)
    val recipient = witness32(recipient)
    val creationAttemptId = witness32(creationAttemptId)
    init { witnessUtf8(replica, 512) }
    override fun equals(other: Any?): Boolean = other is WitnessEnrollment && enrollmentId == other.enrollmentId &&
        replica == other.replica && recipient == other.recipient && creationAttemptId == other.creationAttemptId
    override fun hashCode(): Int = enrollmentId.hashCode()
}

/** Captured public metadata supplied by the later trusted coordinator, not independently attested here. */
internal class CapturedWitnessIdentity(publicKey: ByteArray, spki: ByteArray, appSignerSha256: ByteArray,
    val creationVersionCode: String, certificateChain: List<ByteArray>) {
    val publicKey = witness32(publicKey)
    val spki = WitnessBytes(spki)
    val appSignerSha256 = witness32(appSignerSha256)
    val certificateChain: List<WitnessBytes> = Collections.unmodifiableList(certificateChain.map { WitnessBytes(it) })
    init {
        val prefix = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
        require(spki.contentEquals(prefix + publicKey)) { "invalid_spki" }
        val version = creationVersionCode.toLongOrNull()
        require(version != null && version > 0 && version.toString() == creationVersionCode) { "invalid_creation_version" }
        require(certificateChain.size in 1..8 && certificateChain.all { it.size in 1..16384 } &&
            certificateChain.sumOf { it.size.toLong() } <= 65536L) { "invalid_certificate_chain" }
    }
    override fun equals(other: Any?): Boolean = other is CapturedWitnessIdentity && publicKey == other.publicKey &&
        spki == other.spki && appSignerSha256 == other.appSignerSha256 && creationVersionCode == other.creationVersionCode &&
        certificateChain == other.certificateChain
    override fun hashCode(): Int = publicKey.hashCode()
}

internal enum class WitnessPhase(val stored: String) {
    PREPARED("prepared"), GENERATION_STARTED("generation_started"), GENERATED_UNVALIDATED("generated_unvalidated")
}

internal class WitnessIdentityRecord(val creationAttemptId: WitnessBytes, val phase: WitnessPhase,
    val generationChallenge: WitnessBytes?, val metadata: CapturedWitnessIdentity?, val revision: Long)

internal class SpentNonceRecord(val validatorNonce: WitnessBytes, val enrollmentId: WitnessBytes,
    val attemptId: WitnessBytes, val nativeNonce: WitnessBytes, val sessionDigest: WitnessBytes)

internal class WitnessSnapshot(val identity: WitnessIdentityRecord, enrollments: List<WitnessEnrollment>, spentNonces: List<SpentNonceRecord>) {
    val enrollments: List<WitnessEnrollment> = Collections.unmodifiableList(enrollments.toList())
    val spentNonces: List<SpentNonceRecord> = Collections.unmodifiableList(spentNonces.toList())
    val certificateChain: List<WitnessBytes> get() = identity.metadata?.certificateChain ?: emptyList()
}

/** Opaque journal-issued receipt. Implementing this interface does not pass the journal's owner/identity check. */
internal interface GenerationFence {
    val revision: Long
    val creationAttemptId: WitnessBytes
    val generationChallenge: WitnessBytes
}

internal class ConsentRecord(val revision: Long, val enrollment: WitnessEnrollment, val nonce: SpentNonceRecord)

internal sealed interface WitnessResult<out T> {
    data class Stored<T>(val value: T) : WitnessResult<T>
    data class Refused(val reason: String) : WitnessResult<Nothing>
    object Missing : WitnessResult<Nothing>
}
