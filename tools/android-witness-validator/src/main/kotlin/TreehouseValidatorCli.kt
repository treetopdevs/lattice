package com.android.keyattestation.verifier

import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import java.io.ByteArrayInputStream
import java.nio.file.Path
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.time.Instant
import java.util.Base64

fun interface TrustedSnapshotProvider { fun load(): TrustSnapshotAvailability }

/** Closed, local-only executable boundary. Trust acquisition is deliberately unavailable. */
object TreehouseValidatorCli {
  private val unavailableTrust = TrustedSnapshotProvider { TrustSnapshotAvailability.Unavailable(TrustBlocker.UNAVAILABLE) }
  fun execute(storeDirectory: Path, command: String, input: ByteArray, identifiers: List<String> = emptyList(),
    trustProvider: TrustedSnapshotProvider = unavailableTrust, clock: () -> Instant = Instant::now): ByteArray {
    val store = ValidatorCustodyStore(storeDirectory)
    return try {
      when (command) {
        "issue-generation" -> { arity(identifiers, 0); issueGeneration(store, parse(input)) }
        "verify-generation" -> { arity(identifiers, 1); verifyGeneration(store, id(identifiers, 0), parse(input), trustProvider, clock()) }
        "issue-possession" -> { arity(identifiers, 1); issuePossession(store, id(identifiers, 0), parse(input)) }
        "verify-possession" -> { arity(identifiers, 2); verifyPossession(store, ticket(identifiers), input) }
        "abandon-possession" -> { arity(identifiers, 2); require(input.isEmpty()); abandon(store, ticket(identifiers)) }
        else -> refused("unknown_command")
      }.toString().toByteArray(Charsets.UTF_8)
    } catch (_: IllegalArgumentException) { refused("invalid_request").toString().toByteArray() }
      catch (_: IllegalStateException) { incomplete("store_unavailable").toString().toByteArray() }
      catch (_: Exception) { incomplete("internal_failure").toString().toByteArray() }
  }

  private fun issueGeneration(store: ValidatorCustodyStore, root: JsonObject): JsonObject {
    root.exact("version", "kind", "expected"); require(root.int("version") == 1 && root.string("kind") == "issue_generation")
    val expected = root.obj("expected").expected()
    val ticket = store.issueGeneration(expected)
    return base("generation_challenge", "issued").apply {
      addProperty("issuanceId", enc(ticket.issuanceId))
      add("uiRequest", JsonObject().apply {
        addProperty("creationAttemptId", enc(expected.creationAttemptId))
        addProperty("generationChallenge", enc(ticket.generationChallenge))
      })
    }
  }

  private fun issuePossession(store: ValidatorCustodyStore, id: ByteArray, root: JsonObject): JsonObject {
    root.exact("version", "kind", "expected"); require(root.int("version") == 1 && root.string("kind") == "issue_possession")
    val expected = root.obj("expected").expected()
    val ticket = store.issuePossession(id, expected)
    return base("possession_challenge", "issued").apply {
      addProperty("issuanceId", enc(id)); addProperty("freshValidatorNonce", enc(ticket.validatorNonce))
      add("uiRequest", JsonObject().apply {
        addProperty("replica", expected.replica); addProperty("enrollmentId", enc(expected.enrollmentId))
        addProperty("recipient", enc(expected.recipient)); addProperty("freshValidatorNonce", enc(ticket.validatorNonce))
      })
    }
  }

  private fun verifyPossession(store: ValidatorCustodyStore, ticket: PossessionTicket, raw: ByteArray): JsonObject {
    val report = TreehousePossessionVerifier.verify(store, ticket, raw)
    return possessionReport(report)
  }

  private fun abandon(store: ValidatorCustodyStore, ticket: PossessionTicket): JsonObject {
    val spent = store.abandonPossession(ticket)
    return base("possession_abandonment", if (spent) "spent" else "missing_or_spent")
  }

  private fun verifyGeneration(store: ValidatorCustodyStore, id: ByteArray, root: JsonObject, trustProvider: TrustedSnapshotProvider,
    validationTime: Instant): JsonObject {
    val retained = store.retainedIssuance(id) ?: return refused("unknown_issuance")
    val chain = generated(root, retained)
    // The production trust source is intentionally absent. Parsing and retained-context comparison
    // are executable, but no caller JSON can promote trust to Available.
    val trust = trustProvider.load()
    val associated = store.verifyAndAssociateGeneration(id, chain, trust, validationTime)
    val unavailable = trust as? TrustSnapshotAvailability.Unavailable
    return base("generation_verification", if (associated || unavailable != null) "incomplete" else "refused").apply {
      addProperty("reason", if (associated) "challenge_freshness_unestablished" else when (unavailable?.blocker) {
        TrustBlocker.EXPIRED -> "trust_snapshot_expired"; TrustBlocker.NOT_YET_VALID -> "trust_snapshot_not_yet_valid"
        else -> if (unavailable != null) "trust_snapshot_unavailable" else "generation_verification_failed"
      }); addProperty("issuanceId", enc(id)); addProperty("associated", associated)
      val digest = (trust as? TrustSnapshotAvailability.Available)?.snapshot?.digest
      if (digest == null) add("trustSnapshotDigest", JsonNull.INSTANCE) else addProperty("trustSnapshotDigest", enc(digest))
      addProperty("currentState", "not_established"); add("currentStateBlockers", blockers())
    }
  }

  private fun generated(root: JsonObject, retained: RetainedIssuance): List<ByteArray> {
    root.exact("version", "status", "eligible", "identity")
    require(root.int("version") == 1 && root.string("status") == "generated_unvalidated" && !root.bool("eligible"))
    val identity = root.obj("identity"); identity.exact("creationAttemptId", "phase", "generationChallenge", "metadata", "revision")
    require(identity.string("phase") == "generated_unvalidated" && identity.string("revision").matches(Regex("[1-9][0-9]{0,18}")))
    val e = retained.expected
    require(identity.bytes32("creationAttemptId").contentEquals(e.creationAttemptId))
    require(identity.bytes32("generationChallenge").contentEquals(retained.generationChallenge))
    val metadata = identity.obj("metadata"); metadata.exact("publicKey", "spki", "appSignerSha256", "creationVersionCode", "certificateChain")
    val key = metadata.bytes32("publicKey"); val spki = metadata.bytes("spki", 44, 44)
    require(spki.copyOfRange(0, 12).contentEquals(byteArrayOf(0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00)))
    require(spki.copyOfRange(12, 44).contentEquals(key))
    require(metadata.bytes32("appSignerSha256").contentEquals(e.signerCertificateSha256))
    require(metadata.string("creationVersionCode") == e.creationVersionCode.toString())
    return metadata.getAsJsonArray("certificateChain").map { canonical(it.asString, 1, 16_384) }.also {
      require(it.size in 1..8 && it.sumOf(ByteArray::size) <= 65_536)
      val source = ByteArrayInputStream(it.first())
      val leaf = CertificateFactory.getInstance("X.509").generateCertificate(source) as X509Certificate
      require(source.available() == 0 && leaf.encoded.contentEquals(it.first()))
      require(leaf.publicKey.encoded.contentEquals(spki) && leaf.publicKey.encoded.copyOfRange(12, 44).contentEquals(key))
    }
  }

  private fun possessionReport(r: PossessionReport) = base("possession_verification", r.status.name.lowercase()).apply {
    addProperty("reason", r.reason.name.lowercase()); add("checks", JsonObject().apply {
      addProperty("nonceIssued", r.checks.nonceIssued); addProperty("nonceSpent", r.checks.nonceSpent)
      addProperty("retainedCandidateMatched", r.checks.retainedCandidateMatched); addProperty("enrollmentContextMatched", r.checks.enrollmentContextMatched)
      addProperty("canonicalClaimMatched", r.checks.canonicalClaimMatched); addProperty("signatureVerified", r.checks.signatureVerified)
    }); addProperty("currentState", "not_established"); add("currentStateBlockers", blockers())
  }
  private fun blockers() = JsonArray().apply { CurrentStateBlocker.entries.map { it.name.lowercase() }.sorted().forEach(::add) }
  private fun base(kind: String, status: String) = JsonObject().apply { addProperty("version", 1); addProperty("kind", kind); addProperty("status", status) }
  private fun refused(reason: String) = base("command", "refused").apply { addProperty("reason", reason) }
  private fun incomplete(reason: String) = base("command", "incomplete").apply { addProperty("reason", reason) }

  private fun JsonObject.expected(): ExpectedEnrollment { exact("replica", "enrollmentId", "recipient", "creationAttemptId", "appSignerSha256", "creationVersionCode")
    val version = string("creationVersionCode"); require(version.matches(Regex("[1-9][0-9]{0,18}")))
    return ExpectedEnrollment(string("replica"), bytes32("enrollmentId"), bytes32("recipient"), bytes32("creationAttemptId"), bytes32("appSignerSha256"), version.toLong()) }
  private fun JsonObject.exact(vararg names: String) = require(keySet() == names.toSet())
  private fun JsonObject.obj(name: String) = requireNotNull(get(name).takeIf { it.isJsonObject }?.asJsonObject)
  private fun JsonObject.string(name: String) = requireNotNull(get(name).takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString)
  private fun JsonObject.int(name: String) = requireNotNull(get(name).takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asString?.also { require(it.matches(Regex("0|[1-9][0-9]*"))) }?.toIntOrNull())
  private fun JsonObject.bool(name: String) = requireNotNull(get(name).takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean)
  private fun JsonObject.bytes32(name: String) = bytes(name, 32, 32)
  private fun JsonObject.bytes(name: String, min: Int, max: Int) = canonical(string(name), min, max)
  private fun canonical(text: String, min: Int, max: Int): ByteArray { val b = Base64.getDecoder().decode(text); require(b.size in min..max && Base64.getEncoder().encodeToString(b) == text); return b }
  private fun enc(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)
  private fun id(values: List<String>, index: Int) = canonical(values.getOrElse(index) { throw IllegalArgumentException("identifier") }, 32, 32)
  private fun arity(values: List<String>, expected: Int) = require(values.size == expected)
  private fun ticket(values: List<String>) = PossessionTicket(id(values, 0), id(values, 1))
  private fun parse(bytes: ByteArray): JsonObject = strictPublicJson(bytes).also { require(it.isJsonObject) }.asJsonObject
}

fun main(args: Array<String>) {
  require(args.size >= 2) { "usage: <store-directory> <command> [identifiers...]" }
  System.out.write(TreehouseValidatorCli.execute(Path.of(args[0]), args[1], System.`in`.readNBytes(131_073), args.drop(2)))
}
