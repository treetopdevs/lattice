package com.android.keyattestation.verifier

import com.google.common.util.concurrent.Futures
import com.google.protobuf.ByteString
import java.security.MessageDigest
import java.security.cert.TrustAnchor
import java.time.Instant

private const val TREEHOUSE_PACKAGE = "dev.treetop.lattice.treehouse"

class GenerationIssuance(
  val issuanceId: ByteArray,
  val generationChallenge: ByteArray,
  val creationAttemptId: ByteArray,
  val replica: String,
  val enrollmentId: ByteArray,
  val recipient: ByteArray,
  val expectedPublicKey: ByteArray,
  val expectedSignerCertificateSha256: ByteArray,
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
  val digest: ByteArray,
) {
  companion object {
    /** Called only after validator-controlled acquisition authenticates and freezes official inputs. */
    internal fun fromValidatorConfiguration(
      anchors: Set<TrustAnchor>, revokedSerials: Set<String>, provenance: String,
      fetchedAt: Instant, expiresAt: Instant,
    ): TrustSnapshotAvailability.Available {
      require(anchors.isNotEmpty() && provenance.isNotEmpty() && expiresAt > fetchedAt)
      require(revokedSerials.all { it.isNotEmpty() })
      val ownedAnchors = anchors.toSet()
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
  CHAIN_VALIDATION_FAILED, CHALLENGE_MISMATCH, PROFILE_MISMATCH,
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
  val issuanceId: ByteArray,
  val trustSnapshotDigest: ByteArray?,
  val validationTime: Instant,
  val generationTime: GenerationTimeChecks,
  val currentState: CurrentState,
  val currentStateBlockers: Set<CurrentStateBlocker>,
)

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
    val certificates = try { request.candidate.chain.map { it.inputStream().asX509Certificate() } }
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
      return report(request, GenerationStatus.INCOMPLETE, GenerationReason.TRUST_SNAPSHOT_UNAVAILABLE, snapshot)
    }
    return when (result) {
      is VerificationResult.Success -> report(request, GenerationStatus.VERIFIED_GENERATION_TIME, GenerationReason.VERIFIED, snapshot,
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

  private fun report(request: OfflineGenerationRequest, status: GenerationStatus, reason: GenerationReason,
    snapshot: TrustSnapshot? = null, checks: GenerationTimeChecks = GenerationTimeChecks(false, false, false, false, false, true)) = OfflineGenerationReport(
      version = 1, kind = "generation_attestation", status = status, reason = reason,
      issuanceId = request.issuance.issuanceIdBytes.copyOf(),
      trustSnapshotDigest = snapshot?.digest?.copyOf(), validationTime = request.validationTime,
      generationTime = checks, currentState = CurrentState.NOT_ESTABLISHED,
      currentStateBlockers = CurrentStateBlocker.entries.toSet(),
    )
}

private fun snapshotDigest(anchors: Set<TrustAnchor>, revoked: Set<String>, provenance: String,
  fetchedAt: Instant, expiresAt: Instant): ByteArray {
  val digest = MessageDigest.getInstance("SHA-256")
  fun add(bytes: ByteArray) { digest.update(bytes.size.toString().toByteArray()); digest.update(0); digest.update(bytes) }
  add(provenance.toByteArray(Charsets.UTF_8)); add(fetchedAt.toString().toByteArray()); add(expiresAt.toString().toByteArray())
  anchors.map { requireNotNull(it.trustedCert).encoded }.sortedWith(::compareBytes).forEach(::add)
  revoked.sorted().forEach { add(it.toByteArray(Charsets.US_ASCII)) }
  return digest.digest()
}

private fun compareBytes(left: ByteArray, right: ByteArray): Int {
  for (index in 0 until minOf(left.size, right.size)) {
    val compared = (left[index].toInt() and 255).compareTo(right[index].toInt() and 255)
    if (compared != 0) return compared
  }
  return left.size.compareTo(right.size)
}
