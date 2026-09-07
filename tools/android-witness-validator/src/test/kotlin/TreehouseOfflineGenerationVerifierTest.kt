package com.android.keyattestation.verifier

import java.time.Instant
import java.time.temporal.ChronoUnit
import com.google.protobuf.ByteString
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.cert.TrustAnchor
import java.security.cert.X509Certificate
import java.util.Date
import kotlin.test.Test
import kotlin.test.assertEquals
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder

class TreehouseOfflineGenerationVerifierTest {
  private val now = Instant.parse("2026-09-07T12:00:00Z")
  private val issuance = GenerationIssuance(ByteArray(32) { 1 }, ByteArray(32) { 2 }, ByteArray(32) { 3 },
    "replica:test", ByteArray(32) { 4 }, ByteArray(32) { 5 }, ByteArray(32) { 6 }, ByteArray(32) { 7 }, 42)
  private val available = TrustSnapshot.fromValidatorConfiguration(
    GoogleTrustAnchors(), emptySet(), "https://validator.invalid/frozen-official-snapshot",
    now.minus(1, ChronoUnit.HOURS), now.plus(1, ChronoUnit.HOURS))

  @Test fun `expired trust snapshot is incomplete before untrusted chain parsing`() {
    val report = TreehouseOfflineGenerationVerifier.verify(
      OfflineGenerationRequest(issuance, GenerationCandidate(listOf(byteArrayOf(1, 2, 3))),
        TrustSnapshotAvailability.Unavailable(TrustBlocker.EXPIRED), now)
    )
    assertEquals(GenerationStatus.INCOMPLETE, report.status)
    assertEquals(GenerationReason.TRUST_SNAPSHOT_EXPIRED, report.reason)
    assertEquals(false, report.generationTime.chainValidated)
    assertEquals(CurrentState.NOT_ESTABLISHED, report.currentState)
  }

  @Test fun `malformed chain is refused and never becomes a generation verification`() {
    val report = TreehouseOfflineGenerationVerifier.verify(
      OfflineGenerationRequest(issuance, GenerationCandidate(listOf(byteArrayOf(1, 2, 3))), available, now)
    )
    assertEquals(GenerationStatus.REFUSED, report.status)
    assertEquals(GenerationReason.CHAIN_PARSING_FAILED, report.reason)
    assertEquals(false, report.generationTime.chainValidated)
  }

  @Test fun `real verifier binds trust time challenge key and fixed profile`() {
    val fixture = fixture()
    val valid = TreehouseOfflineGenerationVerifier.verify(fixture.request)
    assertEquals(GenerationStatus.INCOMPLETE, valid.status)
    assertEquals(GenerationReason.CHALLENGE_FRESHNESS_UNESTABLISHED, valid.reason)
    assertEquals(true, valid.generationTime.challengeAssociated)
    assertEquals(true, valid.generationTime.validatorEnrollmentContextRetained)

    val wrongChallenge = GenerationIssuance(ByteArray(32) { 1 }, ByteArray(32) { 9 }, ByteArray(32) { 3 },
      "replica:test", ByteArray(32) { 4 }, ByteArray(32) { 5 }, fixture.publicKey, ByteArray(32) { 7 }, 42)
    val refused = TreehouseOfflineGenerationVerifier.verify(
      OfflineGenerationRequest(wrongChallenge, fixture.request.candidate, fixture.request.trust, now))
    assertEquals(GenerationStatus.REFUSED, refused.status)
    assertEquals(GenerationReason.CHALLENGE_MISMATCH, refused.reason)

    val wrongKey = GenerationIssuance(ByteArray(32) { 1 }, ByteArray(32) { 2 }, ByteArray(32) { 3 },
      "replica:test", ByteArray(32) { 4 }, ByteArray(32) { 5 }, ByteArray(32) { 8 }, ByteArray(32) { 7 }, 42)
    val profileRefused = TreehouseOfflineGenerationVerifier.verify(
      OfflineGenerationRequest(wrongKey, fixture.request.candidate, fixture.request.trust, now))
    assertEquals(GenerationReason.PROFILE_MISMATCH, profileRefused.reason)

    val revoked = TrustSnapshot.fromValidatorConfiguration(setOf(TrustAnchor(fixture.root, null)), setOf("2"),
      "https://validator.invalid/frozen-official-snapshot", now.minusSeconds(60), now.plusSeconds(3600))
    val revokedReport = TreehouseOfflineGenerationVerifier.verify(
      OfflineGenerationRequest(fixture.request.issuance, fixture.request.candidate, revoked, now))
    assertEquals(GenerationReason.CHAIN_VALIDATION_FAILED, revokedReport.reason)

    for (suffix in listOf(byteArrayOf(0), fixture.root.encoded)) {
      val trailing = fixture.request.candidate.chain.mapIndexed { index, der -> if (index == 0) der + suffix else der }
      val trailingReport = TreehouseOfflineGenerationVerifier.verify(
        OfflineGenerationRequest(fixture.request.issuance, GenerationCandidate(trailing), fixture.request.trust, now))
      assertEquals(GenerationReason.CHAIN_PARSING_FAILED, trailingReport.reason)
    }
  }

  @Test fun `validator inputs and report bytes are owned and trust digest commits anchor constraints`() {
    val fixture = fixture(); val issuanceId = ByteArray(32) { 1 }
    val issued = GenerationIssuance(issuanceId, ByteArray(32) { 2 }, ByteArray(32) { 3 }, "replica:test",
      ByteArray(32) { 4 }, ByteArray(32) { 5 }, fixture.publicKey, ByteArray(32) { 7 }, 42)
    issuanceId.fill(99)
    val report = TreehouseOfflineGenerationVerifier.verify(
      OfflineGenerationRequest(issued, fixture.request.candidate, fixture.request.trust, now))
    assertEquals(1, report.issuanceId[0])
    report.issuanceId.fill(88)
    assertEquals(1, report.issuanceId[0])
    val constrained = TrustSnapshot.fromValidatorConfiguration(
      setOf(TrustAnchor(fixture.root, byteArrayOf(0x30, 0x00))), emptySet(), "source",
      now.minusSeconds(1), now.plusSeconds(1)).snapshot.digest
    assertEquals(false, constrained.contentEquals((fixture.request.trust as TrustSnapshotAvailability.Available).snapshot.digest))
  }

  private data class Fixture(val request: OfflineGenerationRequest, val publicKey: ByteArray, val root: X509Certificate)
  private fun fixture(): Fixture {
    val leaf = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    val intermediate = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    val root = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    val rootName = X500Name("CN=root"); val intermediateName = X500Name("CN=intermediate")
    val description = description(rawKey(leaf))
    val rootCert = cert(root, root, rootName, rootName, 3)
    val chain = listOf(
      cert(leaf, intermediate, X500Name("CN=leaf"), intermediateName, 1, description.asExtension()),
      cert(intermediate, root, intermediateName, rootName, 2), rootCert)
    val trust = TrustSnapshot.fromValidatorConfiguration(setOf(TrustAnchor(rootCert, null)), emptySet(),
      "https://validator.invalid/frozen-official-snapshot", now.minusSeconds(60), now.plusSeconds(3600))
    val issued = GenerationIssuance(ByteArray(32) { 1 }, ByteArray(32) { 2 }, ByteArray(32) { 3 },
      "replica:test", ByteArray(32) { 4 }, ByteArray(32) { 5 }, rawKey(leaf), ByteArray(32) { 7 }, 42)
    return Fixture(OfflineGenerationRequest(issued, GenerationCandidate(chain.map(X509Certificate::getEncoded)), trust, now), rawKey(leaf), rootCert)
  }

  private fun description(publicKey: ByteArray) = KeyDescription(
    400.toBigInteger(), SecurityLevel.TRUSTED_ENVIRONMENT, 400.toBigInteger(), SecurityLevel.TRUSTED_ENVIRONMENT,
    ByteString.copyFrom(ByteArray(32) { 2 }), ByteString.EMPTY,
    AuthorizationList(attestationApplicationId = AttestationApplicationId(
      setOf(AttestationPackageInfo("dev.treetop.lattice.treehouse", 42.toBigInteger())),
      setOf(ByteString.copyFrom(ByteArray(32) { 7 })))),
    AuthorizationList(purposes = setOf(2.toBigInteger()), algorithms = 3.toBigInteger(), keySize = 256.toBigInteger(),
      digests = setOf(BigInteger.ZERO), ecCurve = 4.toBigInteger(), userAuthType = 2.toBigInteger(), origin = Origin.GENERATED,
      rootOfTrust = RootOfTrust(ByteString.copyFromUtf8("boot-key"), true, VerifiedBootState.VERIFIED, ByteString.copyFromUtf8("boot-hash"))))

  private fun rawKey(pair: KeyPair) = SubjectPublicKeyInfo.getInstance(pair.public.encoded).publicKeyData.bytes
  private fun cert(subjectKey: KeyPair, signerKey: KeyPair, subject: X500Name, issuer: X500Name, serial: Long,
    extension: Extension? = null): X509Certificate {
    val builder = JcaX509v3CertificateBuilder(issuer, BigInteger.valueOf(serial), Date.from(now.minusSeconds(60)),
      Date.from(now.plusSeconds(3600)), subject, subjectKey.public)
    extension?.let(builder::addExtension)
    return JcaX509CertificateConverter().getCertificate(builder.build(JcaContentSignerBuilder("Ed25519").build(signerKey.private)))
  }
}
