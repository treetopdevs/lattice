package dev.treetop.lattice.treehouse.witness

import android.annotation.TargetApi
import android.os.Build
import android.content.Context
import android.content.pm.PackageManager
import dev.treetop.lattice.treehouse.BuildConfig
import android.security.keystore.KeyProperties
import java.security.KeyFactory
import java.security.spec.ECGenParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import java.security.KeyStore
import java.security.PrivateKey
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.X509Certificate

internal sealed interface WitnessKeyObservation {
    object Absent : WitnessKeyObservation
    class Present(val metadata: CapturedWitnessIdentity) : WitnessKeyObservation
    data class Refused(val reason: String) : WitnessKeyObservation
}

/** Trusted native platform boundary. Test implementations live only in src/test. */
internal interface WitnessKeyPlatform {
    fun loadStore(): KeyStore
    fun keyInfo(key: PrivateKey): KeyInfo
}

/**
 * Fixed native observation/configuration only. The native caller supplies a validated original
 * journal record and retains its process lease through any later completion. These results grant
 * no permission to generate/sign; this component performs no journal mutation or command registration.
 */
@TargetApi(33)
internal class AndroidWitnessProvider(private val context: Context, private val platform: WitnessKeyPlatform = AndroidKeyPlatform) {
    fun observeFixedIdentity(original: WitnessIdentityRecord?): WitnessKeyObservation {
        if (!supportedContext()) return WitnessKeyObservation.Refused("unsupported_profile")
        if (original != null && !validRecord(original)) return WitnessKeyObservation.Refused("identity_incomplete")
        return try {
            val store = platform.loadStore()
            val key = store.getKey(FIXED_ALIAS, null)
            if (key != null && key !is PrivateKey) return WitnessKeyObservation.Refused("unexpected_key_type")
            val certificate = store.getCertificate(FIXED_ALIAS)
            val chain = store.getCertificateChain(FIXED_ALIAS)
            val keyEntry = store.isKeyEntry(FIXED_ALIAS)
            val certificateEntry = store.isCertificateEntry(FIXED_ALIAS)
            if (key == null) {
                if (certificate != null || chain != null || keyEntry || certificateEntry) WitnessKeyObservation.Refused("inconsistent_key_entry")
                else if (original == null || original.phase == WitnessPhase.PREPARED) WitnessKeyObservation.Absent
                else WitnessKeyObservation.Refused("identity_incomplete")
            } else {
                if (original == null || original.phase == WitnessPhase.PREPARED) return WitnessKeyObservation.Refused("identity_incomplete")
                if (!keyEntry || certificateEntry || certificate == null || chain == null) return WitnessKeyObservation.Refused("inconsistent_key_entry")
                if (key.algorithm !in listOf("EdDSA", "Ed25519") || !matchesProfile(platform.keyInfo(key as PrivateKey)))
                    return WitnessKeyObservation.Refused("unsupported_profile")
                if (certificate !is X509Certificate || chain.size !in 1..8 || chain.any { it !is X509Certificate })
                    return WitnessKeyObservation.Refused("invalid_certificate_chain")
                val encoded = mutableListOf<ByteArray>()
                var total = 0
                for (entry in chain) {
                    val bytes = entry.encoded
                    if (bytes.size !in 1..16384 || total + bytes.size > 65536) return WitnessKeyObservation.Refused("invalid_certificate_chain")
                    total += bytes.size
                    encoded.add(bytes.copyOf())
                }
                if (!certificate.encoded.contentEquals(encoded.first()) || encoded.any { !WitnessAttestationMetadata.isBoundedCertificate(it) })
                    return WitnessKeyObservation.Refused("invalid_certificate_chain")
                val leaf = WitnessAttestationMetadata.readLeaf(encoded.first()) ?: return WitnessKeyObservation.Refused("invalid_attestation_metadata")
                if (leaf.spki != WitnessBytes(certificate.publicKey.encoded) || leaf.challenge != original.generationChallenge)
                    return WitnessKeyObservation.Refused("original_identity_mismatch")
                if (leaf.application.signerSha256 != currentSigner()) return WitnessKeyObservation.Refused("app_identity_mismatch")
                val metadata = CapturedWitnessIdentity(leaf.publicKey.copyBytes(), leaf.spki.copyBytes(),
                    leaf.application.signerSha256.copyBytes(), leaf.application.creationVersionCode, encoded)
                if (original.metadata != null && original.metadata != metadata) return WitnessKeyObservation.Refused("original_identity_mismatch")
                WitnessKeyObservation.Present(metadata)
            }
        } catch (_: Exception) { WitnessKeyObservation.Refused("key_observation_failed") }
    }

    /** Returns observed public metadata only; completion still requires the journal's exact original CAS. */
    fun reconcileOriginal(original: WitnessIdentityRecord, attempt: ByteArray, challenge: ByteArray): WitnessKeyObservation {
        if (attempt.size != 32 || challenge.size != 32) return WitnessKeyObservation.Refused("original_identity_mismatch")
        val ownedAttempt = WitnessBytes(attempt); val ownedChallenge = WitnessBytes(challenge)
        if (!validRecord(original) || original.phase == WitnessPhase.PREPARED ||
            original.creationAttemptId != ownedAttempt || original.generationChallenge != ownedChallenge)
            return WitnessKeyObservation.Refused("original_identity_mismatch")
        return observeFixedIdentity(original)
    }

    /** Fresh fixed-key operation only after repeating the complete local profile observation. */
    fun prepareFixedSignature(original: WitnessIdentityRecord): WitnessResult<Signature> {
        if (original.phase != WitnessPhase.GENERATED_UNVALIDATED || original.metadata == null)
            return WitnessResult.Refused("identity_incomplete")
        val observed = observeFixedIdentity(original)
        if (observed is WitnessKeyObservation.Refused) return WitnessResult.Refused(observed.reason)
        if (observed !is WitnessKeyObservation.Present) return WitnessResult.Refused("identity_incomplete")
        return try {
            val store = platform.loadStore()
            val key = store.getKey(FIXED_ALIAS, null) as? PrivateKey
                ?: return WitnessResult.Refused("unexpected_key_type")
            if (!matchesProfile(platform.keyInfo(key))) return WitnessResult.Refused("unsupported_profile")
            val certificate = store.getCertificate(FIXED_ALIAS) as? X509Certificate
                ?: return WitnessResult.Refused("inconsistent_key_entry")
            if (WitnessBytes(certificate.publicKey.encoded) != observed.metadata.spki)
                return WitnessResult.Refused("original_identity_mismatch")
            WitnessResult.Stored(Signature.getInstance("Ed25519").also { it.initSign(key) })
        } catch (_: Exception) { WitnessResult.Refused("key_operation_failed") }
    }

    /** A spec is configuration only. It cannot consume/restore a journal fence or invoke a generator. */
    fun originalGenerationSpec(original: WitnessIdentityRecord, attempt: ByteArray, challenge: ByteArray): KeyGenParameterSpec? {
        if (attempt.size != 32 || challenge.size != 32) return null
        val ownedAttempt = WitnessBytes(attempt); val ownedChallenge = WitnessBytes(challenge)
        if (!supportedContext() || !validRecord(original) || original.phase != WitnessPhase.GENERATION_STARTED ||
            original.creationAttemptId != ownedAttempt || original.generationChallenge != ownedChallenge) return null
        return try {
            KeyGenParameterSpec.Builder(FIXED_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("ed25519"))
                .setDigests(KeyProperties.DIGEST_NONE)
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                .setInvalidatedByBiometricEnrollment(true)
                .setAttestationChallenge(ownedChallenge.copyBytes()).build()
        } catch (_: Exception) { null }
    }

    private fun supportedContext() = try { Build.VERSION.SDK_INT >= 33 && !context.isDeviceProtectedStorage &&
        context.packageName == APP_ID && BuildConfig.LATTICE_PRODUCT == "treehouse" && BuildConfig.LATTICE_APP_ID == APP_ID
    } catch (_: Exception) { false }

    private fun currentSigner(): WitnessBytes? {
        val info = context.packageManager.getPackageInfo(APP_ID, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
        if (info.packageName != APP_ID || info.longVersionCode <= 0) return null
        val signing = info.signingInfo ?: return null
        val signers = signing.apkContentsSigners ?: return null
        if (signing.hasMultipleSigners() || signers.size != 1) return null
        val bytes = signers.single().toByteArray()
        if (bytes.isEmpty()) return null
        // Current signer must match; current app version is never mislabeled as the key's creation version.
        return witness32(MessageDigest.getInstance("SHA-256").digest(bytes))
    }

    private fun validRecord(record: WitnessIdentityRecord): Boolean = record.creationAttemptId.size == 32 && record.revision > 0 && when (record.phase) {
        WitnessPhase.PREPARED -> record.generationChallenge == null && record.metadata == null
        WitnessPhase.GENERATION_STARTED -> record.generationChallenge?.size == 32 && record.metadata == null
        WitnessPhase.GENERATED_UNVALIDATED -> record.generationChallenge?.size == 32 && record.metadata != null
    }

    private fun matchesProfile(info: KeyInfo) = info.keystoreAlias == FIXED_ALIAS && info.keySize == 256 &&
        info.securityLevel == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT && info.origin == KeyProperties.ORIGIN_GENERATED &&
        info.keyValidityStart == null && info.keyValidityForOriginationEnd == null && info.keyValidityForConsumptionEnd == null &&
        info.remainingUsageCount == KeyProperties.UNRESTRICTED_USAGE_COUNT &&
        info.purposes == KeyProperties.PURPOSE_SIGN && info.digests.contentEquals(arrayOf(KeyProperties.DIGEST_NONE)) &&
        info.encryptionPaddings.isEmpty() && info.signaturePaddings.isEmpty() && info.blockModes.isEmpty() &&
        info.isUserAuthenticationRequired && info.userAuthenticationType == KeyProperties.AUTH_BIOMETRIC_STRONG &&
        info.isUserAuthenticationRequirementEnforcedBySecureHardware && info.isInvalidatedByBiometricEnrollment &&
        info.userAuthenticationValidityDurationSeconds in listOf(0, -1) && !info.isUserAuthenticationValidWhileOnBody &&
        !info.isTrustedUserPresenceRequired && !info.isUserConfirmationRequired

    private object AndroidKeyPlatform : WitnessKeyPlatform {
        override fun loadStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
        override fun keyInfo(key: PrivateKey): KeyInfo = KeyFactory.getInstance("EC", "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java)
    }
    companion object {
        private const val APP_ID = "dev.treetop.lattice.treehouse"
        const val FIXED_ALIAS = "dev.treetop.lattice.treehouse.governance-witness.v1"
    }
}
