package com.android.keyattestation.verifier

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import java.io.ByteArrayOutputStream
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

enum class PossessionStatus { VERIFIED_POSSESSION, REFUSED, INCOMPLETE }
enum class PossessionReason { VERIFIED, NONCE_MISSING_OR_SPENT, INVALID_PACKET, EXPECTED_CONTEXT_MISMATCH, INVALID_SIGNATURE, INTERNAL_VALIDATION_FAILURE }
class PossessionChecks internal constructor(
  val nonceIssued: Boolean, val nonceSpent: Boolean, val retainedCandidateMatched: Boolean,
  val enrollmentContextMatched: Boolean, val canonicalClaimMatched: Boolean, val signatureVerified: Boolean,
)
class PossessionReport internal constructor(
  val version: Int = 1, val kind: String = "possession", val status: PossessionStatus,
  val reason: PossessionReason, val checks: PossessionChecks,
  val currentState: CurrentState = CurrentState.NOT_ESTABLISHED,
  val currentStateBlockers: Set<CurrentStateBlocker> = CurrentStateBlocker.entries.toSet(),
)

/** Strict manual-import verifier. Its ticket came from the validator-owned store, not phone JSON. */
object TreehousePossessionVerifier {
  fun verify(store: ValidatorCustodyStore, ticket: PossessionTicket, utf8Json: ByteArray): PossessionReport {
    if (utf8Json.size > 131_072) return consumeFailure(store, ticket, PossessionReason.INVALID_PACKET)
    var outcome: PossessionReport? = null
    val consumed = try {
      store.consumePossession(ticket) { expected, candidate, generationChallenge ->
        outcome = verifySpent(ticket, expected, candidate, generationChallenge, utf8Json)
        outcome!!.status == PossessionStatus.VERIFIED_POSSESSION
      }
    } catch (_: Exception) { return report(PossessionStatus.INCOMPLETE, PossessionReason.INTERNAL_VALIDATION_FAILURE, false) }
    return outcome ?: report(PossessionStatus.REFUSED, PossessionReason.NONCE_MISSING_OR_SPENT, consumed)
  }

  private fun consumeFailure(store: ValidatorCustodyStore, ticket: PossessionTicket, reason: PossessionReason): PossessionReport {
    var spent = false
    try { store.consumePossession(ticket) { _, _, _ -> spent = true; false } } catch (_: Exception) {
      return report(PossessionStatus.INCOMPLETE, PossessionReason.INTERNAL_VALIDATION_FAILURE, false)
    }
    return report(PossessionStatus.REFUSED, if (spent) reason else PossessionReason.NONCE_MISSING_OR_SPENT, spent)
  }

  private fun verifySpent(ticket: PossessionTicket, expected: ExpectedEnrollment, candidate: AssociatedCandidate, retainedChallenge: ByteArray,
    bytes: ByteArray): PossessionReport = try {
    val text = bytes.toString(Charsets.UTF_8)
    require(text.toByteArray(Charsets.UTF_8).contentEquals(bytes))
    val root = strictPublicJson(bytes).obj(setOf("version", "status", "eligible", "identity", "binding"))
    require(root.int("version") == 1 && root.string("status") == "signed" && !root.bool("eligible"))
    val identity = root.get("identity").obj(setOf("creationAttemptId", "phase", "generationChallenge", "metadata", "revision"))
    require(identity.string("phase") == "generated_unvalidated")
    val revision = identity.string("revision")
    require(isCanonicalPositiveI64(revision))
    val attempt = identity.bytes32("creationAttemptId")
    val challenge = identity.bytes32("generationChallenge")
    val metadata = identity.get("metadata").obj(setOf("publicKey", "spki", "appSignerSha256", "creationVersionCode", "certificateChain"))
    val identityKey = metadata.bytes32("publicKey")
    val spki = metadata.bytes("spki", 44, 44)
    val version = metadata.string("creationVersionCode")
    require(isCanonicalPositiveI64(version))
    context(version.toLong() == expected.creationVersionCode)
    context(metadata.bytes32("appSignerSha256").contentEquals(expected.signerCertificateSha256))
    val chain = metadata.getAsJsonArray("certificateChain").map { it.asString.canonicalBytes(1, 16_384) }
    require(chain.size in 1..8 && chain.sumOf(ByteArray::size) <= 65_536)
    context(attempt.contentEquals(expected.creationAttemptId) && identityKey.contentEquals(candidate.publicKey) &&
      spki.contentEquals(candidate.spki) && chain.same(candidate.chain))

    val binding = root.get("binding").obj(setOf("claim", "signature"))
    val claim = binding.get("claim").obj(CLAIM_KEYS)
    require(claim.string("domain") == DOMAIN && claim.int("version") == 1 && claim.string("product") == "treehouse" && claim.string("appId") == APP)
    context(claim.string("replica") == expected.replica)
    val fields = listOf("enrollmentId", "recipient", "creationAttemptId", "actualWitnessPublicKey", "generationChallengeDigest", "freshValidatorNonce", "nativeRandomNonce", "nativeCallerSessionDigest").associateWith(claim::bytes32)
    context(fields.getValue("enrollmentId").contentEquals(expected.enrollmentId) && fields.getValue("recipient").contentEquals(expected.recipient) &&
      fields.getValue("creationAttemptId").contentEquals(expected.creationAttemptId) && fields.getValue("actualWitnessPublicKey").contentEquals(candidate.publicKey) &&
      challenge.contentEquals(retainedChallenge) && fields.getValue("generationChallengeDigest").contentEquals(MessageDigest.getInstance("SHA-256").digest(retainedChallenge)) &&
      fields.getValue("freshValidatorNonce").contentEquals(ticket.validatorNonce))
    val canonical = encodeCanonicalPossessionClaim(expected.replica, fields)
    val signature = binding.bytes("signature", 64, 64)
    val verifier = Signature.getInstance("Ed25519")
    verifier.initVerify(KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(candidate.spki)))
    verifier.update(canonical)
    if (!verifier.verify(signature)) report(PossessionStatus.REFUSED, PossessionReason.INVALID_SIGNATURE, true, context = true, canonical = true)
    else report(PossessionStatus.VERIFIED_POSSESSION, PossessionReason.VERIFIED, true, context = true, canonical = true, signature = true)
  } catch (_: ExpectedContextMismatch) {
    report(PossessionStatus.REFUSED, PossessionReason.EXPECTED_CONTEXT_MISMATCH, true)
  } catch (_: IllegalArgumentException) {
    report(PossessionStatus.REFUSED, PossessionReason.INVALID_PACKET, true)
  } catch (_: Exception) {
    report(PossessionStatus.REFUSED, PossessionReason.INVALID_SIGNATURE, true)
  }

  private fun report(status: PossessionStatus, reason: PossessionReason, spent: Boolean, context: Boolean = false,
    canonical: Boolean = false, signature: Boolean = false) = PossessionReport(status = status, reason = reason,
      checks = PossessionChecks(spent, spent, context, context, canonical, signature))

  private const val DOMAIN = "lattice-witness-binding-challenge-v1"
  private const val APP = "dev.treetop.lattice.treehouse"
  private val CLAIM_KEYS = setOf("domain", "version", "product", "appId", "replica", "enrollmentId", "recipient", "creationAttemptId", "actualWitnessPublicKey", "generationChallengeDigest", "freshValidatorNonce", "nativeRandomNonce", "nativeCallerSessionDigest")
}

private class ExpectedContextMismatch : RuntimeException()
private fun context(matches: Boolean) { if (!matches) throw ExpectedContextMismatch() }

private fun JsonElement.obj(keys: Set<String>): JsonObject = asJsonObject.also { require(it.keySet() == keys) }
private fun JsonObject.string(name: String) = get(name).asJsonPrimitive.also { require(it.isString) }.asString
private fun JsonObject.int(name: String) = stringNumber(name).toInt().also { require(it.toString() == stringNumber(name)) }
private fun JsonObject.stringNumber(name: String) = get(name).asJsonPrimitive.also { require(it.isNumber) }.asString
private fun JsonObject.bool(name: String) = get(name).asJsonPrimitive.also { require(it.isBoolean) }.asBoolean
private fun JsonObject.bytes32(name: String) = bytes(name, 32, 32)
private fun JsonObject.bytes(name: String, min: Int, max: Int) = string(name).canonicalBytes(min, max)
private fun String.canonicalBytes(min: Int, max: Int): ByteArray = Base64.getDecoder().decode(this).also { require(it.size in min..max && Base64.getEncoder().encodeToString(it) == this) }
private fun List<ByteArray>.same(other: List<ByteArray>) = size == other.size && indices.all { this[it].contentEquals(other[it]) }

internal fun encodeCanonicalPossessionClaim(replica: String, fields: Map<String, ByteArray>): ByteArray = ByteArrayOutputStream().also { out ->
  out.write(0x8d)
  fun binary(bytes: ByteArray) {
    require(bytes.size <= 512)
    when {
      bytes.size < 24 -> out.write(0x40 + bytes.size)
      bytes.size <= 255 -> { out.write(0x58); out.write(bytes.size) }
      else -> { out.write(0x59); out.write(bytes.size ushr 8); out.write(bytes.size and 255) }
    }
    out.write(bytes)
  }
  binary("lattice-witness-binding-challenge-v1".toByteArray()); out.write(1)
  binary("treehouse".toByteArray()); binary("dev.treetop.lattice.treehouse".toByteArray()); binary(replica.toByteArray())
  for (name in listOf("enrollmentId", "recipient", "creationAttemptId", "actualWitnessPublicKey", "generationChallengeDigest", "freshValidatorNonce", "nativeRandomNonce", "nativeCallerSessionDigest")) binary(fields.getValue(name))
}.toByteArray()
