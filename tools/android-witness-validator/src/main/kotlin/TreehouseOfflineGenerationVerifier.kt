package com.android.keyattestation.verifier

import com.google.common.util.concurrent.Futures
import com.google.protobuf.ByteString
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.TrustAnchor
import java.time.Instant
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer

private const val TREEHOUSE_PACKAGE = "dev.treetop.lattice.treehouse"

class GenerationIssuance(
  issuanceId: ByteArray,
  generationChallenge: ByteArray,
  creationAttemptId: ByteArray,
  val replica: String,
  enrollmentId: ByteArray,
  recipient: ByteArray,
  expectedPublicKey: ByteArray,
  expectedSignerCertificateSha256: ByteArray,
  val expectedCreationVersionCode: Long,
) {
  init {
    require(listOf(issuanceId, generationChallenge, creationAttemptId, enrollmentId, recipient,
      expectedPublicKey, expectedSignerCertificateSha256).all { it.size == 32 })
    val replicaBytes = replica.toByteArray(Charsets.UTF_8)
    require(replicaBytes.isNotEmpty() && replicaBytes.size <= 512 && replicaBytes.toString(Charsets.UTF_8) == replica)
    require(expectedCreationVersionCode > 0)
  }
  internal val issuanceIdBytes = issuanceId.copyOf()
  internal val challengeBytes = generationChallenge.copyOf()
  internal val attemptBytes = creationAttemptId.copyOf()
  internal val enrollmentBytes = enrollmentId.copyOf()
  internal val recipientBytes = recipient.copyOf()
  internal val publicKeyBytes = expectedPublicKey.copyOf()
  internal val signerBytes = expectedSignerCertificateSha256.copyOf()
  val issuanceId: ByteArray get() = issuanceIdBytes.copyOf()
  val generationChallenge: ByteArray get() = challengeBytes.copyOf()
  val creationAttemptId: ByteArray get() = attemptBytes.copyOf()
  val enrollmentId: ByteArray get() = enrollmentBytes.copyOf()
  val recipient: ByteArray get() = recipientBytes.copyOf()
  val expectedPublicKey: ByteArray get() = publicKeyBytes.copyOf()
  val expectedSignerCertificateSha256: ByteArray get() = signerBytes.copyOf()
}

class GenerationCandidate(certificateChain: List<ByteArray>) {
  internal val chain = certificateChain.map(ByteArray::copyOf)
  init {
    require(chain.size in 1..8)
    require(chain.all { it.size in 1..16_384 })
    require(chain.sumOf(ByteArray::size) <= 65_536)
  }
}

enum class TrustBlocker { UNAVAILABLE, EXPIRED, NOT_YET_VALID }

sealed interface TrustSnapshotAvailability {
  class Available internal constructor(internal val snapshot: TrustSnapshot) : TrustSnapshotAvailability
  data class Unavailable(val blocker: TrustBlocker) : TrustSnapshotAvailability
}

class TrustSnapshot private constructor(
  internal val anchors: Set<TrustAnchor>,
  internal val revokedSerials: Set<String>,
  val provenance: String,
  val fetchedAt: Instant,
  val expiresAt: Instant,
  digest: ByteArray,
) {
  private val digestBytes = digest.copyOf()
  val digest: ByteArray get() = digestBytes.copyOf()
  companion object {
    /** Called only after validator-controlled acquisition authenticates and freezes official inputs.
     * The recorded provenance string is audit context; it does not itself authenticate a source. */
    internal fun fromValidatorConfiguration(
      anchors: Set<TrustAnchor>, revokedSerials: Set<String>, provenance: String,
      fetchedAt: Instant, expiresAt: Instant,
    ): TrustSnapshotAvailability.Available {
      require(anchors.isNotEmpty() && provenance.isNotEmpty() && expiresAt > fetchedAt)
      require(revokedSerials.all { it.matches(Regex("(?:0|[1-9a-f][0-9a-f]*)")) })
      val ownedAnchors = anchors.map { anchor ->
        val certificate = requireNotNull(anchor.trustedCert) { "certificate trust anchor required" }
        TrustAnchor(parseExactCertificate(certificate.encoded), anchor.nameConstraints?.copyOf())
      }.toSet()
      val ownedRevoked = revokedSerials.toSet()
      return TrustSnapshotAvailability.Available(TrustSnapshot(
        ownedAnchors, ownedRevoked, provenance, fetchedAt, expiresAt,
        snapshotDigest(ownedAnchors, ownedRevoked, provenance, fetchedAt, expiresAt),
      ))
    }
  }
}

class OfflineGenerationRequest(
  val issuance: GenerationIssuance,
  val candidate: GenerationCandidate,
  val trust: TrustSnapshotAvailability,
  val validationTime: Instant,
)

enum class GenerationStatus { VERIFIED_GENERATION_TIME, REFUSED, INCOMPLETE }
enum class GenerationReason {
  VERIFIED, TRUST_SNAPSHOT_UNAVAILABLE, TRUST_SNAPSHOT_EXPIRED, TRUST_SNAPSHOT_NOT_YET_VALID, CHAIN_PARSING_FAILED,
  CHAIN_VALIDATION_FAILED, CHALLENGE_MISMATCH, CHALLENGE_FRESHNESS_UNESTABLISHED, PROFILE_MISMATCH,
  INTERNAL_VALIDATION_FAILURE,
}
enum class CurrentState { NOT_ESTABLISHED }
enum class CurrentStateBlocker { CURRENT_PACKAGE_STATE_UNAVAILABLE, CURRENT_DEVICE_STATE_UNAVAILABLE, PHYSICAL_CANDIDATE_PROOF_REQUIRED }
class GenerationTimeChecks internal constructor(
  val challengeAssociated: Boolean,
  val chainValidated: Boolean,
  val revocationChecked: Boolean,
  val profileMatched: Boolean,
  val publicKeyMatched: Boolean,
  /** This is validator-issued context retained with the issuance; it is not an attested field. */
  val validatorEnrollmentContextRetained: Boolean,
)
class OfflineGenerationReport internal constructor(
  val version: Int,
  val kind: String,
  val status: GenerationStatus,
  val reason: GenerationReason,
  issuanceId: ByteArray,
  trustSnapshotDigest: ByteArray?,
  val validationTime: Instant,
  val generationTime: GenerationTimeChecks,
  val currentState: CurrentState,
  val currentStateBlockers: Set<CurrentStateBlocker>,
)
{
  private val issuanceIdBytes = issuanceId.copyOf()
  private val trustDigestBytes = trustSnapshotDigest?.copyOf()
  val issuanceId: ByteArray get() = issuanceIdBytes.copyOf()
  val trustSnapshotDigest: ByteArray? get() = trustDigestBytes?.copyOf()
}

/** Offline generation-time verification only. This does not acquire trust data, issue or persist
 * challenges, verify fresh possession/current device state, or make an eligibility decision. */
object TreehouseOfflineGenerationVerifier {
  fun verify(request: OfflineGenerationRequest): OfflineGenerationReport {
    val issuance = request.issuance
    val unavailable = request.trust as? TrustSnapshotAvailability.Unavailable
    if (unavailable != null) return report(
      request, GenerationStatus.INCOMPLETE,
      when (unavailable.blocker) {
        TrustBlocker.EXPIRED -> GenerationReason.TRUST_SNAPSHOT_EXPIRED
        TrustBlocker.NOT_YET_VALID -> GenerationReason.TRUST_SNAPSHOT_NOT_YET_VALID
        TrustBlocker.UNAVAILABLE -> GenerationReason.TRUST_SNAPSHOT_UNAVAILABLE
      },
    )
    val snapshot = (request.trust as TrustSnapshotAvailability.Available).snapshot
    if (request.validationTime < snapshot.fetchedAt)
      return report(request, GenerationStatus.INCOMPLETE, GenerationReason.TRUST_SNAPSHOT_NOT_YET_VALID, snapshot)
    if (request.validationTime >= snapshot.expiresAt)
      return report(request, GenerationStatus.INCOMPLETE, GenerationReason.TRUST_SNAPSHOT_EXPIRED, snapshot)
    val certificates = try { request.candidate.chain.map(::parseExactCertificate) }
      catch (_: Exception) { return report(request, GenerationStatus.REFUSED, GenerationReason.CHAIN_PARSING_FAILED, snapshot) }
    val expected = TreehouseWitnessExpected(
      TREEHOUSE_PACKAGE, issuance.signerBytes, issuance.expectedCreationVersionCode, issuance.publicKeyBytes)
    val expectedChallenge = ByteString.copyFrom(issuance.challengeBytes)
    val result = try {
      Verifier(
        trustAnchorsSource = { snapshot.anchors }, revokedSerialsSource = { snapshot.revokedSerials },
        instantSource = InstantSource { request.validationTime }, constraintConfig = treehouseWitnessConstraintConfig(expected),
      ).verify(certificates, object : ChallengeChecker {
        override fun checkChallenge(challenge: ByteString) = Futures.immediateFuture(challenge == expectedChallenge)
      })
    } catch (_: Exception) {
      return report(request, GenerationStatus.INCOMPLETE, GenerationReason.INTERNAL_VALIDATION_FAILURE, snapshot)
    }
    return when (result) {
      is VerificationResult.Success -> report(request, GenerationStatus.INCOMPLETE, GenerationReason.CHALLENGE_FRESHNESS_UNESTABLISHED, snapshot,
        GenerationTimeChecks(true, true, true, true, true, true))
      VerificationResult.ChallengeMismatch -> report(request, GenerationStatus.REFUSED, GenerationReason.CHALLENGE_MISMATCH, snapshot,
        GenerationTimeChecks(false, true, true, false, false, true))
      is VerificationResult.ChainParsingFailure, is VerificationResult.ExtensionParsingFailure ->
        report(request, GenerationStatus.REFUSED, GenerationReason.CHAIN_PARSING_FAILED, snapshot)
      is VerificationResult.PathValidationFailure, VerificationResult.SoftwareAttestationUnsupported ->
        report(request, GenerationStatus.REFUSED, GenerationReason.CHAIN_VALIDATION_FAILED, snapshot)
      is VerificationResult.ConstraintViolation -> report(request, GenerationStatus.REFUSED, GenerationReason.PROFILE_MISMATCH, snapshot,
        GenerationTimeChecks(true, true, true, false, false, true))
    }
  }

  /** Package-internal authority for durable first association. The proof cannot be
   * constructed from a report or caller boolean; it follows this exact candidate's
   * successful PKIX, revocation, challenge, profile and public-key checks. */
  internal fun verifyCandidateForAssociation(request: OfflineGenerationRequest): VerifiedGenerationCandidate? {
    val report = verify(request)
    val checks = report.generationTime
    if (report.status != GenerationStatus.INCOMPLETE ||
      report.reason != GenerationReason.CHALLENGE_FRESHNESS_UNESTABLISHED ||
      !checks.challengeAssociated || !checks.chainValidated || !checks.revocationChecked ||
      !checks.profileMatched || !checks.publicKeyMatched) return null
    return VerifiedGenerationCandidate(
      request.issuance.issuanceId,
      request.issuance.expectedPublicKey,
      request.candidate.chain,
    )
  }

  private fun report(request: OfflineGenerationRequest, status: GenerationStatus, reason: GenerationReason,
    snapshot: TrustSnapshot? = null, checks: GenerationTimeChecks = GenerationTimeChecks(false, false, false, false, false, true)) = OfflineGenerationReport(
      version = 1, kind = "generation_attestation", status = status, reason = reason,
      issuanceId = request.issuance.issuanceIdBytes.copyOf(),
      trustSnapshotDigest = snapshot?.digest?.copyOf(), validationTime = request.validationTime,
      generationTime = checks, currentState = CurrentState.NOT_ESTABLISHED,
      currentStateBlockers = CurrentStateBlocker.entries.toSet(),
    )
}

internal class VerifiedGenerationCandidate internal constructor(
  issuanceId: ByteArray, publicKey: ByteArray, chain: List<ByteArray>,
) {
  internal val issuanceId = issuanceId.copyOf()
  internal val publicKey = publicKey.copyOf()
  internal val chain = chain.map(ByteArray::copyOf)
}

private fun snapshotDigest(anchors: Set<TrustAnchor>, revoked: Set<String>, provenance: String,
  fetchedAt: Instant, expiresAt: Instant): ByteArray {
  val digest = MessageDigest.getInstance("SHA-256")
  digest.update("treehouse-validator-trust-snapshot-v1".toByteArray(Charsets.US_ASCII))
  fun add(bytes: ByteArray) { digest.update(ByteBuffer.allocate(8).putLong(bytes.size.toLong()).array()); digest.update(bytes) }
  add(provenance.toByteArray(Charsets.UTF_8)); add(fetchedAt.toString().toByteArray()); add(expiresAt.toString().toByteArray())
  val orderedAnchors = anchors.map { anchor -> requireNotNull(anchor.trustedCert).encoded to anchor.nameConstraints?.copyOf() }
    .sortedWith { left, right ->
      compareBytes(left.first, right.first).takeIf { it != 0 }
        ?: when {
          left.second == null && right.second != null -> -1
          left.second != null && right.second == null -> 1
          else -> compareBytes(left.second ?: ByteArray(0), right.second ?: ByteArray(0))
        }
    }
  digest.update(ByteBuffer.allocate(8).putLong(orderedAnchors.size.toLong()).array())
  orderedAnchors.forEach { (certificate, constraints) ->
    add(certificate)
    digest.update(if (constraints == null) 0 else 1)
    if (constraints != null) add(constraints)
  }
  val orderedRevoked = revoked.sorted()
  digest.update(ByteBuffer.allocate(8).putLong(orderedRevoked.size.toLong()).array())
  orderedRevoked.forEach { add(it.toByteArray(Charsets.US_ASCII)) }
  return digest.digest()
}

private fun parseExactCertificate(der: ByteArray): java.security.cert.X509Certificate {
  val input = ByteArrayInputStream(der)
  val certificate = CertificateFactory.getInstance("X.509").generateCertificate(input)
  require(input.available() == 0) { "trailing certificate bytes" }
  return certificate as java.security.cert.X509Certificate
}

private fun compareBytes(left: ByteArray, right: ByteArray): Int {
  for (index in 0 until minOf(left.size, right.size)) {
    val compared = (left[index].toInt() and 255).compareTo(right[index].toInt() and 255)
    if (compared != 0) return compared
  }
  return left.size.compareTo(right.size)
}
