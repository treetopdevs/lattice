package com.android.keyattestation.verifier

import com.android.keyattestation.verifier.provider.KeyAttestationCertPath
import com.google.common.collect.ImmutableList
import com.google.protobuf.ByteString
import java.math.BigInteger
import org.bouncycastle.asn1.ASN1OctetString
import org.bouncycastle.asn1.ASN1Sequence
import org.bouncycastle.asn1.ASN1TaggedObject
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo

/** Trusted generation-time values retained independently of the Android response. */
class TreehouseWitnessExpected(
  val packageName: String,
  signerCertificateSha256: ByteArray,
  val creationVersionCode: Long,
  publicKey: ByteArray,
) {
  internal val signerCertificateSha256 = ByteString.copyFrom(signerCertificateSha256)
  internal val publicKey = ByteString.copyFrom(publicKey)

  init {
    require(packageName.isNotEmpty() && packageName.toByteArray().size <= 512)
    require(this.signerCertificateSha256.size() == 32)
    require(creationVersionCode > 0)
    require(this.publicKey.size() == 32)
  }
}

/** Exact Treehouse Ed25519 authorization and generation-identity policy. */
class TreehouseWitnessProfileConstraint(private val expected: TreehouseWitnessExpected) :
  Constraint {
  override val label = "Treehouse witness fixed profile"

  override fun check(
    description: KeyDescription,
    certPath: KeyAttestationCertPath,
  ): Constraint.Result =
    if (matches(description, certPath)) Constraint.Satisfied
    else Constraint.Violated("Treehouse witness fixed profile mismatch")

  private fun matches(description: KeyDescription, certPath: KeyAttestationCertPath): Boolean {
    val software = description.softwareEnforced
    val hardware = description.hardwareEnforced
    val app = software.attestationApplicationId
    val root = hardware.rootOfTrust
    val spki =
      runCatching { SubjectPublicKeyInfo.getInstance(certPath.leafCert().publicKey.encoded) }
        .getOrNull() ?: return false

    return description.attestationSecurityLevel == SecurityLevel.TRUSTED_ENVIRONMENT &&
      description.keyMintSecurityLevel == SecurityLevel.TRUSTED_ENVIRONMENT &&
      description.uniqueId.isEmpty &&
      hardware.purposes == setOf(SIGN) &&
      hardware.algorithms == EC &&
      hardware.keySize == KEY_SIZE &&
      hardware.ecCurve == CURVE_25519 &&
      hardware.digests == setOf(DIGEST_NONE) &&
      hardware.origin == Origin.GENERATED &&
      hardware.userAuthType == BIOMETRIC_STRONG &&
      hardware.noAuthRequired == null && hardware.authTimeout == null &&
      noSurplusCrypto(hardware) &&
      noProfileFields(software) &&
      app?.packages ==
        setOf(
          AttestationPackageInfo(
            expected.packageName,
            expected.creationVersionCode.toBigInteger(),
          )
        ) &&
      app.signatures == setOf(expected.signerCertificateSha256) &&
      hardware.attestationApplicationId == null &&
      root != null &&
      root.deviceLocked &&
      root.verifiedBootState == VerifiedBootState.VERIFIED &&
      !root.verifiedBootKey.isEmpty &&
      root.verifiedBootHash?.isEmpty != true &&
      exactRawAuthorizationShape(certPath) &&
      spki.algorithm.algorithm.id == ED25519_OID &&
      spki.algorithm.parameters == null &&
      ByteString.copyFrom(spki.publicKeyData.bytes) == expected.publicKey
  }

  private fun noProfileFields(list: AuthorizationList) =
    list.purposes == null && list.algorithms == null && list.keySize == null &&
      list.digests == null && list.ecCurve == null && list.origin == null &&
      list.userAuthType == null && list.noAuthRequired == null && list.authTimeout == null &&
      list.rootOfTrust == null && noSurplusCrypto(list)

  private fun noSurplusCrypto(list: AuthorizationList) =
    list.blockModes == null && list.paddings == null && list.mlDsaVariant == null &&
      list.rsaPublicExponent == null && list.rsaOaepMgfDigests == null &&
      list.activeDateTime == null && list.originationExpireDateTime == null &&
      list.usageExpireDateTime == null && list.usageCountLimit == null &&
      list.rollbackResistant == null &&
      list.trustedUserPresenceRequired == null && list.trustedConfirmationRequired == null &&
      list.unlockedDeviceRequired == null && list.attestationIdBrand == null &&
      list.attestationIdDevice == null && list.attestationIdProduct == null &&
      list.attestationIdSerial == null && list.attestationIdImei == null &&
      list.attestationIdMeid == null && list.attestationIdManufacturer == null &&
      list.attestationIdModel == null && list.attestationIdSecondImei == null &&
      list.moduleHash == null

  private fun exactRawAuthorizationShape(certPath: KeyAttestationCertPath): Boolean = runCatching {
    val wrapped = certPath.leafCert().getExtensionValue(KeyDescription.OID.id) ?: return false
    val description = ASN1Sequence.getInstance(ASN1OctetString.getInstance(wrapped).octets)
    val software = tags(ASN1Sequence.getInstance(description.getObjectAt(6)))
    val hardware = tags(ASN1Sequence.getInstance(description.getObjectAt(7)))
    software != null && hardware != null && software.all { it in softwareAllowed } &&
      software.contains(KeyMintTag.ATTESTATION_APPLICATION_ID.value) &&
      hardware.all { it in hardwareAllowed } &&
      hardware.containsAll(hardwareRequired)
  }.getOrDefault(false)

  private fun tags(sequence: ASN1Sequence): List<Int>? {
    val tags = sequence.map { (it as? ASN1TaggedObject)?.tagNo ?: return null }
    return tags.takeIf { it.distinct().size == it.size && it.zipWithNext().all { (a, b) -> a < b } }
  }

  companion object {
    private val SIGN = BigInteger.valueOf(2)
    private val EC = BigInteger.valueOf(3)
    private val KEY_SIZE = BigInteger.valueOf(256)
    private val DIGEST_NONE = BigInteger.ZERO
    private val CURVE_25519 = BigInteger.valueOf(4)
    private val BIOMETRIC_STRONG = BigInteger.valueOf(2)
    private const val ED25519_OID = "1.3.101.112"
    private val softwareAllowed =
      setOf(KeyMintTag.CREATION_DATE_TIME.value, KeyMintTag.ATTESTATION_APPLICATION_ID.value)
    private val hardwareRequired = setOf(1, 2, 3, 5, 10, 504, 702, 704)
    private val hardwareAllowed = hardwareRequired + setOf(705, 706, 718, 719)
  }
}

fun treehouseWitnessConstraintConfig(expected: TreehouseWitnessExpected) =
  ConstraintConfig(
    securityLevel = SecurityLevelConstraint.STRICT(SecurityLevel.TRUSTED_ENVIRONMENT),
    additionalConstraints = ImmutableList.of(TreehouseWitnessProfileConstraint(expected)),
  )
