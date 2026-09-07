package com.android.keyattestation.verifier

import com.android.keyattestation.verifier.provider.KeyAttestationCertPath
import com.google.protobuf.ByteString
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.cert.X509Certificate
import java.time.Instant
import java.util.Date
import kotlin.test.Test
import kotlin.test.assertIs
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.ASN1Sequence
import org.bouncycastle.asn1.ASN1TaggedObject
import org.bouncycastle.asn1.DERNull
import org.bouncycastle.asn1.DERSequence
import org.bouncycastle.asn1.DERTaggedObject
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder

class TreehouseWitnessProfileTest {
  private val signer = ByteArray(32) { 7 }
  private val leafKeys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
  private val expected = TreehouseWitnessExpected("dev.treetop.lattice.treehouse", signer, 42, rawKey(leafKeys))
  private val constraint = treehouseWitnessConstraintConfig(expected).additionalConstraints.single()
  private val path = path(leafKeys, description())

  @Test fun `real parser output accepts only exact fixed profile`() {
    assertIs<Constraint.Satisfied>(constraint.check(KeyDescription.parseFrom(description().encodeToAsn1()), path))
  }

  @Test fun `security crypto authentication application and boot mutations refuse`() {
    val base = description(); val hardware = base.hardwareEnforced; val software = base.softwareEnforced
    val mutations = listOf(
      base.copy(attestationSecurityLevel = SecurityLevel.STRONG_BOX), base.copy(keyMintSecurityLevel = SecurityLevel.SOFTWARE),
      base.copy(hardwareEnforced = hardware.copy(origin = Origin.IMPORTED)),
      base.copy(hardwareEnforced = hardware.copy(purposes = setOf(2.toBigInteger(), 3.toBigInteger()))),
      base.copy(hardwareEnforced = hardware.copy(algorithms = BigInteger.ONE)),
      base.copy(hardwareEnforced = hardware.copy(ecCurve = BigInteger.ONE)),
      base.copy(hardwareEnforced = hardware.copy(digests = emptySet())),
      base.copy(hardwareEnforced = hardware.copy(userAuthType = BigInteger.ONE)),
      base.copy(hardwareEnforced = hardware.copy(userAuthType = null)),
      base.copy(hardwareEnforced = hardware.copy(noAuthRequired = true)),
      base.copy(hardwareEnforced = hardware.copy(authTimeout = BigInteger.ZERO)),
      base.copy(hardwareEnforced = hardware.copy(paddings = setOf(BigInteger.ONE))),
      base.copy(hardwareEnforced = hardware.copy(usageCountLimit = BigInteger.ONE)),
      base.copy(hardwareEnforced = hardware.copy(trustedUserPresenceRequired = true)),
      base.copy(softwareEnforced = software.copy(purposes = setOf(2.toBigInteger()))),
      base.copy(softwareEnforced = software.copy(attestationApplicationId = app("other", 42, signer))),
      base.copy(softwareEnforced = software.copy(attestationApplicationId = app(expected.packageName, 41, signer))),
      base.copy(softwareEnforced = software.copy(attestationApplicationId = app(expected.packageName, 42, ByteArray(32) { 8 }))),
      base.copy(hardwareEnforced = hardware.copy(attestationApplicationId = software.attestationApplicationId)),
      base.copy(hardwareEnforced = hardware.copy(rootOfTrust = hardware.rootOfTrust!!.copy(deviceLocked = false))),
      base.copy(hardwareEnforced = hardware.copy(rootOfTrust = hardware.rootOfTrust!!.copy(verifiedBootState = VerifiedBootState.UNVERIFIED))))
    for (mutation in mutations) assertIs<Constraint.Violated>(
      constraint.check(KeyDescription.parseFrom(mutation.encodeToAsn1()), path), mutation.toString())
  }

  @Test fun `surplus app identities and another Ed25519 public key refuse`() {
    val base = description(); val app = base.softwareEnforced.attestationApplicationId!!
    val surplus = base.copy(softwareEnforced = base.softwareEnforced.copy(attestationApplicationId = app.copy(
      packages = app.packages + AttestationPackageInfo("surplus", BigInteger.ONE),
      signatures = app.signatures.toMutableSet().apply { add(ByteString.copyFrom(ByteArray(32) { 9 })) })))
    assertIs<Constraint.Violated>(constraint.check(KeyDescription.parseFrom(surplus.encodeToAsn1()), path))
    val other = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    assertIs<Constraint.Violated>(constraint.check(KeyDescription.parseFrom(base.encodeToAsn1()), path(other, base)))

    val p256 = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
    assertIs<Constraint.Violated>(constraint.check(KeyDescription.parseFrom(base.encodeToAsn1()), path(p256, base)))
  }

  @Test fun `trusted expected byte arrays are owned copies`() {
    val signerInput = ByteArray(32) { 7 }; val keyInput = rawKey(leafKeys)
    val owned = TreehouseWitnessExpected(expected.packageName, signerInput, 42, keyInput)
    signerInput.fill(1); keyInput.fill(1)
    val ownedConstraint = treehouseWitnessConstraintConfig(owned).additionalConstraints.single()
    assertIs<Constraint.Satisfied>(ownedConstraint.check(KeyDescription.parseFrom(description().encodeToAsn1()), path))
  }

  @Test fun `raw surplus and duplicate authorization tags discarded by upstream model still refuse`() {
    val base = description()
    for (extension in listOf(extraHardwareTag(base, 506), extraHardwareTag(base, 1))) {
      val adversarial = path(leafKeys, extension)
      val parsed = KeyDescription.parseFrom(adversarial.leafCert())!!
      assertIs<Constraint.Violated>(constraint.check(parsed, adversarial))
    }
  }

  private fun description() = KeyDescription(
    400.toBigInteger(), SecurityLevel.TRUSTED_ENVIRONMENT, 400.toBigInteger(), SecurityLevel.TRUSTED_ENVIRONMENT,
    ByteString.copyFrom(ByteArray(32) { 3 }), ByteString.EMPTY,
    AuthorizationList(attestationApplicationId = app(expected.packageName, expected.creationVersionCode, signer)),
    AuthorizationList(purposes = setOf(2.toBigInteger()), algorithms = 3.toBigInteger(), keySize = 256.toBigInteger(),
      digests = setOf(BigInteger.ZERO), ecCurve = 4.toBigInteger(), userAuthType = 2.toBigInteger(), origin = Origin.GENERATED,
      rootOfTrust = RootOfTrust(ByteString.copyFromUtf8("boot-key"), true, VerifiedBootState.VERIFIED, ByteString.copyFromUtf8("boot-hash"))))

  private fun app(name: String, version: Long, digest: ByteArray) = AttestationApplicationId(
    setOf(AttestationPackageInfo(name, version.toBigInteger())), setOf(ByteString.copyFrom(digest)))
  private fun rawKey(pair: KeyPair) = SubjectPublicKeyInfo.getInstance(pair.public.encoded).publicKeyData.bytes
  private fun path(leaf: KeyPair, description: KeyDescription): KeyAttestationCertPath {
    return path(leaf, description.asExtension())
  }
  private fun path(leaf: KeyPair, extension: Extension): KeyAttestationCertPath {
    val intermediate = KeyPairGenerator.getInstance("Ed25519").generateKeyPair(); val root = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    val rootName = X500Name("CN=root"); val intermediateName = X500Name("CN=intermediate")
    return KeyAttestationCertPath(cert(leaf, intermediate, X500Name("CN=leaf"), intermediateName, 1, extension),
      cert(intermediate, root, intermediateName, rootName, 2), cert(root, root, rootName, rootName, 3))
  }
  private fun extraHardwareTag(description: KeyDescription, tag: Int): Extension {
    val sequence = ASN1Sequence.getInstance(description.encodeToAsn1())
    val hardware = ASN1Sequence.getInstance(sequence.getObjectAt(7)).toMutableList()
    hardware.add(DERTaggedObject(true, tag, DERNull.INSTANCE))
    hardware.sortBy { (it as ASN1TaggedObject).tagNo }
    val fields = sequence.toMutableList(); fields[7] = DERSequence(hardware.toTypedArray())
    return Extension(KeyDescription.OID, false, DERSequence(fields.toTypedArray()).encoded)
  }
  private fun cert(subjectKey: KeyPair, signerKey: KeyPair, subject: X500Name, issuer: X500Name, serial: Long,
    extension: Extension? = null): X509Certificate {
    val now = Instant.now(); val builder = JcaX509v3CertificateBuilder(issuer, BigInteger.valueOf(serial),
      Date.from(now.minusSeconds(60)), Date.from(now.plusSeconds(3600)), subject, subjectKey.public)
    extension?.let { builder.addExtension(it) }
    return JcaX509CertificateConverter().getCertificate(builder.build(JcaContentSignerBuilder("Ed25519").build(signerKey.private)))
  }
}
