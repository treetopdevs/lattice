package com.android.keyattestation.verifier

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import java.nio.file.Files
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

class TreehousePossessionVerifierTest {
  @Test fun canonicalClaimMatchesReviewedCrossRuntimeFixture() {
    val fields = mapOf(
      "enrollmentId" to b64("UguLZpVhl+Vwmd3Ax7FrdmCi+WjFHjj5BA+gY9upGhg="),
      "recipient" to b64("Ozeh7aa9VkE820AOKdohTEdA8pOUUw3087koD/+XKf0="),
      "creationAttemptId" to b64("ubTESHvwce9Bt0ywR1zRz92ND++u4ARmxEULLxl4F+Q="),
      "actualWitnessPublicKey" to b64("IA4HJufmss8Kr3pFi65JdFYAKQB1XIkVMrAE5dCZ5nY="),
      "generationChallengeDigest" to b64("5Rb8XUWirBqMxZJOcSB9ow+NN7JDyXfrbkRwTlHjc4g="),
      "freshValidatorNonce" to b64("dDkY/sOMSv7aRO2pXxvfYIfjUxKUwXoHQgP0FLX84Dk="),
      "nativeRandomNonce" to b64("NdKoRj26FC0LsHkxdWL9boI2ucbO+Qt1T3QxxBpqr0o="),
      "nativeCallerSessionDigest" to b64("znYnCbzmQOuxuaGW91TnWxMG/gYt++B/kzk/YDt34bE="),
    )
    assertContentEquals(b64("jVgkbGF0dGljZS13aXRuZXNzLWJpbmRpbmctY2hhbGxlbmdlLXYxAUl0cmVlaG91c2VYHWRldi50cmVldG9wLmxhdHRpY2UudHJlZWhvdXNlWB90cmVlaG91c2U6c3BhY2U6YmluZGluZy1maXh0dXJlWCBSC4tmlWGX5XCZ3cDHsWt2YKL5aMUeOPkED6Bj26kaGFggOzeh7aa9VkE820AOKdohTEdA8pOUUw3087koD/+XKf1YILm0xEh78HHvQbdMsEdc0c/djQ/vruAEZsRFCy8ZeBfkWCAgDgcm5+ayzwqvekWLrkl0VgApAHVciRUysATl0Jnmdlgg5Rb8XUWirBqMxZJOcSB9ow+NN7JDyXfrbkRwTlHjc4hYIHQ5GP7DjEr+2kTtqV8b32CH41MSlMF6B0ID9BS1/OA5WCA10qhGPboULQuweTF1Yv1ugja5xs75C3VPdDHEGmqvSlggznYnCbzmQOuxuaGW91TnWxMG/gYt++B/kzk/YDt34bE="), encodeCanonicalPossessionClaim("treehouse:space:binding-fixture", fields))
  }

  @Test fun exactSignedImportVerifiesAndDuplicateOrReplayRefusesAfterDurableSpend() {
    val fixture = TreehouseOfflineGenerationVerifierTest().fixture()
    val pair = fixture.leaf
    val publicKey = fixture.publicKey
    var n = 1
    val store = ValidatorCustodyStore(Files.createTempDirectory("possession"), { bytes(n++) }, PersistCheckpoint {})
    val expected = ExpectedEnrollment("replica:test", bytes(4), bytes(5), bytes(3), bytes(7), 42)
    val issuance = store.issueGeneration(expected)
    val chain = fixture.request.candidate.chain
    assertEquals(true, store.verifyAndAssociateGeneration(issuance.issuanceId, chain, fixture.request.trust, fixture.request.validationTime))
    val verifiedKey = fixture.publicKey
    val ticket = store.issuePossession(issuance.issuanceId, expected)
    val packet = packet(expected, issuance.generationChallenge, ticket.validatorNonce, pair.public.encoded, publicKey, chain, pair)
    val verified = TreehousePossessionVerifier.verify(store, ticket, packet)
    assertEquals(PossessionStatus.VERIFIED_POSSESSION, verified.status, verified.reason.toString())
    assertEquals(PossessionReason.NONCE_MISSING_OR_SPENT, TreehousePossessionVerifier.verify(store, ticket, packet).reason)

    val second = store.issuePossession(issuance.issuanceId, expected)
    val duplicate = String(packet).replaceFirst("\"status\":\"signed\"", "\"status\":\"signed\",\"status\":\"signed\"").toByteArray()
    assertEquals(PossessionReason.INVALID_PACKET, TreehousePossessionVerifier.verify(store, second, duplicate).reason)
    assertEquals(PossessionReason.NONCE_MISSING_OR_SPENT, TreehousePossessionVerifier.verify(store, second, packet).reason)

    val third = store.issuePossession(issuance.issuanceId, expected)
    val noncanonicalNumber = String(packet).replaceFirst("\"version\":1", "\"version\":1.0")
      .replace(enc(ticket.validatorNonce), enc(third.validatorNonce)).toByteArray()
    assertEquals(PossessionReason.INVALID_PACKET, TreehousePossessionVerifier.verify(store, third, noncanonicalNumber).reason)

    val fourth = store.issuePossession(issuance.issuanceId, expected)
    val exactFourth = packet(expected, issuance.generationChallenge, fourth.validatorNonce, pair.public.encoded, publicKey, chain, pair)
    val swappedSignedContext = String(exactFourth).replace(enc(bytes(20)), enc(bytes(22))).toByteArray()
    assertEquals(PossessionReason.INVALID_SIGNATURE, TreehousePossessionVerifier.verify(store, fourth, swappedSignedContext).reason)

    val fifth = store.issuePossession(issuance.issuanceId, expected)
    val exactFifth = packet(expected, issuance.generationChallenge, fifth.validatorNonce, pair.public.encoded, publicKey, chain, pair)
    val unsafeRevision = String(exactFifth).replace("\"revision\":\"1\"", "\"revision\":\"9999999999999999999\"").toByteArray()
    assertEquals(PossessionReason.INVALID_PACKET, TreehousePossessionVerifier.verify(store, fifth, unsafeRevision).reason)
  }

  private fun packet(expected: ExpectedEnrollment, challenge: ByteArray, nonce: ByteArray, spki: ByteArray,
    key: ByteArray, chain: List<ByteArray>, pair: java.security.KeyPair): ByteArray {
    val fields = linkedMapOf(
      "enrollmentId" to expected.enrollmentId, "recipient" to expected.recipient,
      "creationAttemptId" to expected.creationAttemptId, "actualWitnessPublicKey" to key,
      "generationChallengeDigest" to MessageDigest.getInstance("SHA-256").digest(challenge),
      "freshValidatorNonce" to nonce, "nativeRandomNonce" to bytes(20), "nativeCallerSessionDigest" to bytes(21),
    )
    val signer = Signature.getInstance("Ed25519").apply { initSign(pair.private); update(encodeCanonicalPossessionClaim(expected.replica, fields)) }
    val metadata = JsonObject().apply {
      addProperty("publicKey", enc(key)); addProperty("spki", enc(spki)); addProperty("appSignerSha256", enc(expected.signerCertificateSha256))
      addProperty("creationVersionCode", expected.creationVersionCode.toString()); add("certificateChain", JsonArray().also { array -> chain.forEach { array.add(enc(it)) } })
    }
    val identity = JsonObject().apply { addProperty("creationAttemptId", enc(expected.creationAttemptId)); addProperty("phase", "generated_unvalidated"); addProperty("generationChallenge", enc(challenge)); add("metadata", metadata); addProperty("revision", "1") }
    val claim = JsonObject().apply { addProperty("domain", "lattice-witness-binding-challenge-v1"); addProperty("version", 1); addProperty("product", "treehouse"); addProperty("appId", "dev.treetop.lattice.treehouse"); addProperty("replica", expected.replica); fields.forEach { (name, value) -> addProperty(name, enc(value)) } }
    return JsonObject().apply { addProperty("version", 1); addProperty("status", "signed"); addProperty("eligible", false); add("identity", identity); add("binding", JsonObject().apply { add("claim", claim); addProperty("signature", enc(signer.sign())) }) }.toString().toByteArray()
  }
  private fun enc(value: ByteArray) = Base64.getEncoder().encodeToString(value)
  private fun b64(value: String) = Base64.getDecoder().decode(value)
  private fun bytes(value: Int) = ByteArray(32) { value.toByte() }
}
