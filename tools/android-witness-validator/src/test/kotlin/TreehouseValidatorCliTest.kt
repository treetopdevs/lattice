package com.android.keyattestation.verifier

import com.google.gson.JsonParser
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import java.security.KeyPairGenerator
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TreehouseValidatorCliTest {
  @Test fun `subprocess emits exact UI generation request and restart preserves issuance`() {
    val dir = Files.createTempDirectory("validator-cli")
    val result = subprocess(dir, "issue-generation", issue("issue_generation"))
    assertEquals(0, result.first)
    val output = JsonParser.parseString(result.second).asJsonObject
    assertEquals(setOf("version", "kind", "status", "issuanceId", "uiRequest"), output.keySet())
    assertEquals(setOf("creationAttemptId", "generationChallenge"), output.getAsJsonObject("uiRequest").keySet())
    val refused = TreehouseValidatorCli.execute(dir, "verify-generation", "{}".toByteArray(), listOf(output["issuanceId"].asString))
    assertEquals("refused", JsonParser.parseString(String(refused)).asJsonObject["status"].asString)
  }

  @Test fun `closed requests reject duplicates noncanonical encodings and oversized input`() {
    val dir = Files.createTempDirectory("validator-cli-closed")
    val duplicate = issue("issue_generation").replaceFirst("\"version\":1", "\"version\":1,\"version\":1")
    assertReason(dir, "issue-generation", duplicate.toByteArray(), "invalid_request")
    assertReason(dir, "issue-generation", issue("issue_generation").replace(enc(bytes(4)), enc(bytes(4)).dropLast(1)).toByteArray(), "invalid_request")
    assertReason(dir, "issue-generation", ByteArray(131_073) { 'x'.code.toByte() }, "invalid_request")
    assertReason(dir, "issue-generation", issue("issue_generation").replace("\"version\":1", "\"version\":1e0").toByteArray(), "invalid_request")
    assertReason(dir, "issue-generation", issue("issue_generation").toByteArray(), "invalid_request", listOf(enc(bytes(1))))
    val deep = "[".repeat(40) + "0" + "]".repeat(40)
    assertReason(dir, "issue-generation", deep.toByteArray(), "invalid_request")
  }

  @Test fun `malformed and oversized possession responses spend before parsing and abandon is durable`() {
    val setup = associated()
    val ticket = setup.store.issuePossession(setup.issuance.issuanceId, setup.expected)
    val ids = listOf(enc(ticket.issuanceId), enc(ticket.validatorNonce))
    val malformed = TreehouseValidatorCli.execute(setup.dir, "verify-possession", ByteArray(131_073), ids)
    assertEquals("invalid_packet", json(malformed)["reason"].asString)
    assertEquals("nonce_missing_or_spent", json(TreehouseValidatorCli.execute(setup.dir, "verify-possession", "{}".toByteArray(), ids))["reason"].asString)

    val abandoned = setup.store.issuePossession(setup.issuance.issuanceId, setup.expected)
    val abandonedIds = listOf(enc(abandoned.issuanceId), enc(abandoned.validatorNonce))
    assertEquals("spent", json(TreehouseValidatorCli.execute(setup.dir, "abandon-possession", byteArrayOf(), abandonedIds))["status"].asString)
    assertEquals("missing_or_spent", json(TreehouseValidatorCli.execute(setup.dir, "abandon-possession", byteArrayOf(), abandonedIds))["status"].asString)

    val untouched = setup.store.issuePossession(setup.issuance.issuanceId, setup.expected)
    val untouchedIds = listOf(enc(untouched.issuanceId), enc(untouched.validatorNonce))
    assertReason(setup.dir, "abandon-possession", "{}".toByteArray(), "invalid_request", untouchedIds)
    assertEquals("spent", json(TreehouseValidatorCli.execute(setup.dir, "abandon-possession", byteArrayOf(), untouchedIds))["status"].asString)
  }

  @Test fun `generated public import is closed retained-bound and cannot mint trust`() {
    val setup = associated(associate = false)
    val fixture = TreehouseOfflineGenerationVerifierTest().fixture()
    val valid = generated(setup, fixture)
    val ids = listOf(enc(setup.issuance.issuanceId))
    val report = json(TreehouseValidatorCli.execute(setup.dir, "verify-generation", valid.toByteArray(), ids))
    assertEquals("incomplete", report["status"].asString)
    assertEquals("trust_snapshot_unavailable", report["reason"].asString)
    assertFalse(report["associated"].asBoolean)
    val extra = valid.dropLast(1) + ",\"roots\":[]}" 
    assertReason(setup.dir, "verify-generation", extra.toByteArray(), "invalid_request", ids)
    val unsafeRevision = valid.replace("\"revision\":\"1\"", "\"revision\":\"9999999999999999999\"")
    assertReason(setup.dir, "verify-generation", unsafeRevision.toByteArray(), "invalid_request", ids)

    val alternate = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    val mismatchedMetadata = valid.replace(enc(fixture.publicKey), enc(alternate.public.encoded.copyOfRange(12,44)))
      .replace(enc(fixture.leaf.public.encoded), enc(alternate.public.encoded))
    assertReason(setup.dir, "verify-generation", mismatchedMetadata.toByteArray(), "invalid_request", ids)

    val available = json(TreehouseValidatorCli.execute(setup.dir, "verify-generation", valid.toByteArray(), ids,
      TrustedSnapshotProvider { fixture.request.trust }, { fixture.request.validationTime }))
    assertTrue(available["associated"].asBoolean)
    assertEquals("incomplete", available["status"].asString)
    assertEquals("challenge_freshness_unestablished", available["reason"].asString)
  }

  private data class Setup(val dir: Path, val store: ValidatorCustodyStore, val expected: ExpectedEnrollment, val issuance: GenerationTicket)
  private fun associated(associate: Boolean = true): Setup {
    val dir = Files.createTempDirectory("validator-cli-associated"); var n = 1
    val store = ValidatorCustodyStore(dir, { bytes(n++) }, PersistCheckpoint {})
    val expected = ExpectedEnrollment("replica:test", bytes(4), bytes(5), bytes(3), bytes(7), 42)
    val issuance = store.issueGeneration(expected)
    if (associate) { val f=TreehouseOfflineGenerationVerifierTest().fixture(); assertTrue(store.verifyAndAssociateGeneration(issuance.issuanceId, f.request.candidate.chain, f.request.trust, f.request.validationTime)) }
    return Setup(dir, store, expected, issuance)
  }
  private fun generated(s: Setup, f: TreehouseOfflineGenerationVerifierTest.Fixture): String = """{"version":1,"status":"generated_unvalidated","eligible":false,"identity":{"creationAttemptId":"${enc(s.expected.creationAttemptId)}","phase":"generated_unvalidated","generationChallenge":"${enc(s.issuance.generationChallenge)}","metadata":{"publicKey":"${enc(f.publicKey)}","spki":"${enc(f.leaf.public.encoded)}","appSignerSha256":"${enc(s.expected.signerCertificateSha256)}","creationVersionCode":"42","certificateChain":[${f.request.candidate.chain.joinToString(",") { "\"${enc(it)}\"" }}]},"revision":"1"}}"""
  private fun issue(kind: String) = """{"version":1,"kind":"$kind","expected":{"replica":"replica:test","enrollmentId":"${enc(bytes(4))}","recipient":"${enc(bytes(5))}","creationAttemptId":"${enc(bytes(3))}","appSignerSha256":"${enc(bytes(7))}","creationVersionCode":"42"}}"""
  private fun subprocess(dir: Path, command: String, input: String): Pair<Int,String> { val p=ProcessBuilder(Path.of(System.getProperty("java.home"),"bin","java").toString(),"-cp",System.getProperty("java.class.path"),"com.android.keyattestation.verifier.TreehouseValidatorCliKt",dir.toString(),command).redirectErrorStream(true).start(); p.outputStream.use { it.write(input.toByteArray()) }; val out=p.inputStream.readBytes().toString(Charsets.UTF_8); return p.waitFor() to out }
  private fun assertReason(dir: Path, command: String, input: ByteArray, reason: String, ids: List<String> = emptyList()) = assertEquals(reason, json(TreehouseValidatorCli.execute(dir,command,input,ids))["reason"].asString)
  private fun json(bytes: ByteArray)=JsonParser.parseString(String(bytes)).asJsonObject
  private fun enc(value: ByteArray)=Base64.getEncoder().encodeToString(value)
  private fun bytes(value: Int)=ByteArray(32){value.toByte()}
}
