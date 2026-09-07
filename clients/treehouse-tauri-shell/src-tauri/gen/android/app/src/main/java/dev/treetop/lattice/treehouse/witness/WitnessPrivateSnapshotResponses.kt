package dev.treetop.lattice.treehouse.witness

import android.util.Base64
import java.nio.charset.StandardCharsets

/** Closed native-only snapshot envelopes. */
internal object WitnessPrivateSnapshotResponses {
    fun encode(kind: WitnessPrivateKind, operationId: WitnessBytes, session: WitnessBytes,
        snapshot: WitnessSnapshot, enrollment: WitnessEnrollment?): ByteArray? = try {
        require(kind in setOf(WitnessPrivateKind.IDENTITY, WitnessPrivateKind.PREPARE, WitnessPrivateKind.GENERATE))
        require(snapshot.identity.revision > 0)
        enrollment?.let { require(it.creationAttemptId == snapshot.identity.creationAttemptId) }
        val identity = snapshot.identity
        when (identity.phase) {
            WitnessPhase.PREPARED -> require(identity.generationChallenge == null && identity.metadata == null)
            WitnessPhase.GENERATION_STARTED -> require(identity.generationChallenge != null && identity.metadata == null)
            WitnessPhase.GENERATED_UNVALIDATED -> require(identity.generationChallenge != null && identity.metadata != null)
        }
        val json = "{\"protocol\":${q(WitnessPrivateProtocol.PROTOCOL)},\"kind\":${q(kind.name.lowercase())}," +
            "\"operationId\":${q(b64(operationId))},\"sessionDigest\":${q(b64(session))}," +
            "\"status\":\"snapshot\",\"eligible\":false,\"identity\":${identity(identity)}," +
            "\"enrollment\":${enrollment?.let(::enrollment) ?: "null"}}"
        json.toByteArray(StandardCharsets.UTF_8).takeIf { it.size <= WitnessPrivateProtocol.MAX_MESSAGE }
    } catch (_: Exception) { null }

    private fun identity(value: WitnessIdentityRecord): String = "{" +
        "\"creationAttemptId\":${q(b64(value.creationAttemptId))},\"phase\":${q(value.phase.stored)}," +
        "\"generationChallenge\":${value.generationChallenge?.let { q(b64(it)) } ?: "null"}," +
        "\"metadata\":${value.metadata?.let(::metadata) ?: "null"},\"revision\":${q(value.revision.toString())}}"

    private fun metadata(value: CapturedWitnessIdentity): String = "{" +
        "\"publicKey\":${q(b64(value.publicKey))},\"spki\":${q(b64(value.spki))}," +
        "\"appSignerSha256\":${q(b64(value.appSignerSha256))},\"creationVersionCode\":${q(value.creationVersionCode)}," +
        "\"certificateChain\":[${value.certificateChain.joinToString(",") { q(b64(it)) }}]}"

    private fun enrollment(value: WitnessEnrollment): String = "{" +
        "\"replica\":${q(value.replica)},\"enrollmentId\":${q(b64(value.enrollmentId))}," +
        "\"recipient\":${q(b64(value.recipient))},\"creationAttemptId\":${q(b64(value.creationAttemptId))}}"

    private fun b64(value: WitnessBytes): String = Base64.encodeToString(value.copyBytes(), Base64.NO_WRAP)
    private fun q(value: String): String = buildString {
        append('"')
        value.forEach { character -> when (character) {
            '"', '\\' -> append('\\').append(character)
            in '\u0000'..'\u001f' -> append("\\u").append(character.code.toString(16).padStart(4, '0'))
            else -> append(character)
        } }
        append('"')
    }
}
