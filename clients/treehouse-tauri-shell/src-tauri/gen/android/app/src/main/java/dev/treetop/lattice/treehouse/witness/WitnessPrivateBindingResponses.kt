package dev.treetop.lattice.treehouse.witness

import java.nio.charset.StandardCharsets
import java.util.Base64

/** Closed outbound envelopes from coordinator-owned claims only. No public claim decoder. */
internal object WitnessPrivateBindingResponses {
    fun prepared(operationId: WitnessBytes, session: WitnessBytes, token: WitnessBytes,
        result: PreparedWitnessBinding): ByteArray? = encode(operationId, session, token, result.claim) {
        require(result.remainingMillis in 1..60_000)
        "\"status\":\"prepared\",\"remainingMillis\":${result.remainingMillis}"
    }

    fun signed(operationId: WitnessBytes, session: WitnessBytes, token: WitnessBytes,
        result: SignedWitnessBinding): ByteArray? = encode(operationId, session, token, result.claim) {
        val signature = result.signature
        require(signature.size == 64)
        "\"status\":\"signed\",\"signature\":${quote(base64(signature))}"
    }

    private fun encode(operationId: WitnessBytes, session: WitnessBytes, token: WitnessBytes,
        claim: PublicBindingClaim, terminalFields: () -> String): ByteArray? = try {
        require(operationId.size == 32 && session.size == 32 && token.size == 32)
        require(claim.nativeCallerSessionDigest.contentEquals(session.copyBytes()))
        val json = "{\"protocol\":${quote(WitnessPrivateProtocol.PROTOCOL)},\"kind\":\"proof\"," +
            "\"operationId\":${quote(base64(operationId.copyBytes()))},\"sessionDigest\":${quote(base64(session.copyBytes()))}," +
            "\"handle\":${quote(base64(token.copyBytes()))},\"claim\":${claimJson(claim)},${terminalFields()}}"
        json.toByteArray(StandardCharsets.UTF_8).takeIf { it.size <= WitnessPrivateProtocol.MAX_MESSAGE }
    } catch (_: Exception) { null }

    private fun claimJson(claim: PublicBindingClaim): String {
        val fields = linkedMapOf(
            "replica" to String(claim.replicaCopy(), StandardCharsets.UTF_8),
            "enrollmentId" to base64(claim.enrollmentId),
            "recipient" to base64(claim.recipient),
            "creationAttemptId" to base64(claim.creationAttemptId),
            "actualWitnessPublicKey" to base64(claim.actualWitnessPublicKey),
            "generationChallengeDigest" to base64(claim.generationChallengeDigest),
            "freshValidatorNonce" to base64(claim.freshValidatorNonce),
            "nativeRandomNonce" to base64(claim.nativeRandomNonce),
            "nativeCallerSessionDigest" to base64(claim.nativeCallerSessionDigest),
        )
        return fields.entries.joinToString(",", "{", "}") { (key, value) -> "${quote(key)}:${quote(value)}" }
    }

    private fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    private fun quote(value: String): String = buildString {
        append('"')
        for (character in value) when (character) {
            '"' -> { append('\\'); append('"') }
            '\\' -> { append('\\'); append('\\') }
            in '\u0000'..'\u001f' -> { append('\\'); append('u'); append(character.code.toString(16).padStart(4, '0')) }
            else -> append(character)
        }
        append('"')
    }
}
