package dev.treetop.lattice.treehouse.witness

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageInfo
import android.content.pm.SigningInfo
import android.content.pm.Signature
import java.security.cert.CertificateFactory
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowSigningInfo
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import java.io.InputStream
import java.io.OutputStream
import java.security.Key
import java.security.KeyStore
import java.security.KeyStoreSpi
import java.security.PrivateKey
import java.security.Provider
import java.security.UnrecoverableKeyException
import java.security.cert.Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Collections
import java.util.Date
import java.io.File
import org.junit.Rule
import org.junit.After
import org.junit.rules.TemporaryFolder
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [WitnessDirectoryOsShadow::class])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class AndroidWitnessProviderTest {
    @get:Rule val temporary = TemporaryFolder()
    @After fun resetDirectoryAdapter() { WitnessDirectoryOsShadow.reset() }

    @Test fun actualStartedJournalRemainsUnchangedUntilExactOriginalCompletion() {
        installSigningMetadata(2)
        val root = temporary.newFolder()
        WitnessDirectoryOsShadow.registerRoot(root)
        val local = object : ContextWrapper(context()) {
            override fun getDataDir() = root
            override fun getNoBackupFilesDir() = File(root, "no_backup").also { it.mkdirs() }
        }
        val attempt = ByteArray(32) { 1 }
        val challenge = WitnessDerFixture.challenge
        WitnessJournal(local, WitnessDerFixture.signerDigest).use { journal ->
            val enrollment = WitnessEnrollment(ByteArray(32) { 9 }, "replica:synthetic", ByteArray(32) { 8 }, attempt)
            assertTrue(journal.prepareAccepted(enrollment, attempt) is WitnessResult.Stored)
            val fence = (journal.commitGenerationStarted(1, attempt, challenge) as WitnessResult.Stored).value
            val snapshot = (journal.observeExisting() as WitnessResult.Stored).value
            val database = File(root, "no_backup/treehouse-governance-v1/identity.sqlite3")
            val before = database.readBytes()
            val provider = AndroidWitnessProvider(local, completePlatform())
            assertNotNull(provider.originalGenerationSpec(snapshot.identity, attempt, challenge))
            val metadata = (provider.reconcileOriginal(snapshot.identity, attempt, challenge) as WitnessKeyObservation.Present).metadata
            assertArrayEquals(before, database.readBytes())
            assertEquals(WitnessPhase.GENERATION_STARTED, (journal.observeExisting() as WitnessResult.Stored).value.identity.phase)
            val completed = (journal.finishOriginalGeneration(fence, metadata) as WitnessResult.Stored).value
            assertEquals(metadata, (provider.observeFixedIdentity(completed.identity) as WitnessKeyObservation.Present).metadata)
            assertNull(provider.originalGenerationSpec(completed.identity, attempt, challenge))
        }
    }
    @Test fun exactFixedOriginalSpecIsConfigurationOnlyAndOwnsChallenge() {
        val platform = TestPlatform()
        val provider = AndroidWitnessProvider(context(), platform)
        val attempt = ByteArray(32) { 1 }; val challenge = ByteArray(32) { 2 }
        val original = started(attempt, challenge)
        val spec = requireNotNull(provider.originalGenerationSpec(original, attempt, challenge))
        assertEquals(AndroidWitnessProvider.FIXED_ALIAS, spec.keystoreAlias)
        assertEquals(KeyProperties.PURPOSE_SIGN, spec.purposes)
        assertEquals("ed25519", (spec.algorithmParameterSpec as ECGenParameterSpec).name)
        assertArrayEquals(arrayOf(KeyProperties.DIGEST_NONE), spec.digests)
        assertTrue(spec.isUserAuthenticationRequired)
        assertEquals(0, spec.userAuthenticationValidityDurationSeconds)
        assertEquals(KeyProperties.AUTH_BIOMETRIC_STRONG, spec.userAuthenticationType)
        assertTrue(spec.isInvalidatedByBiometricEnrollment)
        assertFalse(spec.isStrongBoxBacked)
        assertFalse(spec.isUserAuthenticationValidWhileOnBody)
        assertFalse(spec.isUserConfirmationRequired)
        assertTrue(spec.encryptionPaddings.isEmpty()); assertTrue(spec.signaturePaddings.isEmpty())
        assertTrue(spec.blockModes.isEmpty())
        challenge.fill(9); attempt.fill(9)
        assertArrayEquals(ByteArray(32) { 2 }, spec.attestationChallenge)
        assertTrue(platform.calls.isEmpty())
    }

    @Test fun specRefusesDifferentOriginalWidthPhaseOrRevisionBeforeAnyPlatformCall() {
        val platform = TestPlatform(); val provider = AndroidWitnessProvider(context(), platform)
        val a = ByteArray(32) { 1 }; val c = ByteArray(32) { 2 }
        for (record in listOf(WitnessIdentityRecord(witness32(a), WitnessPhase.PREPARED, null, null, 1),
            WitnessIdentityRecord(witness32(a), WitnessPhase.GENERATION_STARTED, witness32(c), null, 0))) {
            assertNull(provider.originalGenerationSpec(record, a, c))
        }
        assertNull(provider.originalGenerationSpec(started(a, c), a.copyOf(31), c))
        assertNull(provider.originalGenerationSpec(started(a, c), a, c.copyOf(33)))
        assertNull(provider.originalGenerationSpec(started(a, c), ByteArray(32), c))
        assertNull(provider.originalGenerationSpec(started(a, c), a, ByteArray(32)))
        assertTrue(platform.calls.isEmpty())
    }

    @Test fun absenceUsesKeyLookupAndAllFixedEntryChecksNeverContainsAlias() {
        val platform = TestPlatform()
        assertSame(WitnessKeyObservation.Absent, AndroidWitnessProvider(context(), platform).observeFixedIdentity(null))
        assertEquals(listOf("load", "key", "certificate", "chain", "keyEntry", "certificateEntry"), platform.calls)
        assertTrue(platform.aliases.all { it == AndroidWitnessProvider.FIXED_ALIAS })
    }

    @Test fun everyLookupErrorAndObservableCertificateOnlyEntryRefuses() {
        for (failure in listOf("load", "key", "certificate", "chain", "keyEntry", "certificateEntry")) {
            val platform = TestPlatform().also { it.fail = failure }
            assertTrue(failure, AndroidWitnessProvider(context(), platform).observeFixedIdentity(null) is WitnessKeyObservation.Refused)
        }
        for (kind in listOf("keyEntry", "certificateEntry", "certificate", "chain")) {
            val platform = TestPlatform().also { it.present = kind }
            assertTrue(kind, AndroidWitnessProvider(context(), platform).observeFixedIdentity(null) is WitnessKeyObservation.Refused)
        }
        val platform = TestPlatform().also { it.key = object : Key {
            override fun getAlgorithm() = "AES"
            override fun getFormat(): String? = throw AssertionError("no key export")
            override fun getEncoded(): ByteArray = throw AssertionError("no key export")
        } }
        assertTrue(AndroidWitnessProvider(context(), platform).observeFixedIdentity(null) is WitnessKeyObservation.Refused)
    }

    @Test fun unsupportedContextRefusesBeforeProviderLookup() {
        val platform = TestPlatform()
        val wrong = object : ContextWrapper(context()) { override fun getPackageName() = "dev.other" }
        assertTrue(AndroidWitnessProvider(wrong, platform).observeFixedIdentity(null) is WitnessKeyObservation.Refused)
        val directBoot = object : ContextWrapper(context()) { override fun isDeviceProtectedStorage() = true }
        assertTrue(AndroidWitnessProvider(directBoot, platform).observeFixedIdentity(null) is WitnessKeyObservation.Refused)
        assertTrue(platform.calls.isEmpty())
    }

    @Test fun capturesOriginalLeafVersionAcrossUpdateAndReconcilesOnlyExactOriginal() {
        installSigningMetadata(2)
        val platform = completePlatform()
        val provider = AndroidWitnessProvider(context(), platform)
        val original = started(c = WitnessDerFixture.challenge)
        val observed = provider.observeFixedIdentity(original)
        assertTrue(observed.toString(), observed is WitnessKeyObservation.Present)
        val metadata = (observed as WitnessKeyObservation.Present).metadata
        assertEquals("1", metadata.creationVersionCode)
        assertArrayEquals(WitnessDerFixture.signerDigest, metadata.appSignerSha256.copyBytes())
        assertArrayEquals(WitnessDerFixture.publicKey, metadata.publicKey.copyBytes())
        assertArrayEquals(platform.chain!![0].encoded, metadata.certificateChain.single().copyBytes())
        val retry = provider.reconcileOriginal(original, ByteArray(32) { 1 }, WitnessDerFixture.challenge)
        assertEquals(metadata, (retry as WitnessKeyObservation.Present).metadata)
        assertTrue(provider.reconcileOriginal(original, ByteArray(32), WitnessDerFixture.challenge) is WitnessKeyObservation.Refused)
        assertTrue(provider.reconcileOriginal(original, ByteArray(32) { 1 }, ByteArray(32)) is WitnessKeyObservation.Refused)
        val completed = WitnessIdentityRecord(original.creationAttemptId, WitnessPhase.GENERATED_UNVALIDATED, original.generationChallenge, metadata, 3)
        installSigningMetadata(3)
        assertEquals(metadata, (provider.observeFixedIdentity(completed) as WitnessKeyObservation.Present).metadata)
        platform.chain = arrayOf(platform.certificate!!, platform.certificate!!)
        assertTrue(provider.observeFixedIdentity(completed) is WitnessKeyObservation.Refused)
    }

    @Test fun incompleteOrChangedIdentityNeverAdoptsAKeyOrRefreshesSavedMetadata() {
        installSigningMetadata(2)
        val original = started(c = WitnessDerFixture.challenge)
        val platform = completePlatform(); val provider = AndroidWitnessProvider(context(), platform)
        assertTrue(provider.observeFixedIdentity(null) is WitnessKeyObservation.Refused)
        assertTrue(provider.observeFixedIdentity(WitnessIdentityRecord(original.creationAttemptId, WitnessPhase.PREPARED, null, null, 1)) is WitnessKeyObservation.Refused)
        assertTrue(provider.observeFixedIdentity(started()) is WitnessKeyObservation.Refused)
        val metadata = (provider.observeFixedIdentity(original) as WitnessKeyObservation.Present).metadata
        val completed = WitnessIdentityRecord(original.creationAttemptId, WitnessPhase.GENERATED_UNVALIDATED, original.generationChallenge, metadata, 3)
        val changed = WitnessDerFixture.certificate(spki = WitnessDerFixture.spki.copyOf().also { it[it.lastIndex] = 99 })
        platform.certificate = certificate(changed); platform.chain = arrayOf(platform.certificate!!)
        assertTrue(provider.observeFixedIdentity(completed) is WitnessKeyObservation.Refused)
        assertTrue(AndroidWitnessProvider(context(), TestPlatform()).observeFixedIdentity(original) is WitnessKeyObservation.Refused)
        assertTrue(AndroidWitnessProvider(context(), TestPlatform()).observeFixedIdentity(completed) is WitnessKeyObservation.Refused)
    }

    @Test fun actualCurrentSingleSignerMustMatchAttestedCreationSigner() {
        for (signers in listOf(emptyArray(), arrayOf(Signature(byteArrayOf(8))),
            arrayOf(Signature(WitnessDerFixture.signerCertificate), Signature(byteArrayOf(8))))) {
            installSigningMetadata(2, signers)
            val platform = completePlatform()
            assertTrue(AndroidWitnessProvider(context(), platform).observeFixedIdentity(started(c = WitnessDerFixture.challenge)) is WitnessKeyObservation.Refused)
        }
    }

    @Test fun exactActualKeyInfoProfileAllowsOnlyTheTwoPerUseDiagnostics() {
        installSigningMetadata(2)
        for (duration in listOf(0, -1)) {
            val p = completePlatform().also { it.profile = profile(mapOf(13 to duration)) }
            assertTrue(AndroidWitnessProvider(context(), p).observeFixedIdentity(started(c = WitnessDerFixture.challenge)) is WitnessKeyObservation.Present)
        }
        val changes: List<Pair<Int, Any>> = listOf(0 to "other-alias", 2 to KeyProperties.ORIGIN_IMPORTED, 3 to 384,
            7 to (KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY), 8 to arrayOf("PKCS1Padding"),
            9 to arrayOf("PSS"), 10 to arrayOf(KeyProperties.DIGEST_SHA256), 11 to arrayOf("GCM"),
            12 to false, 13 to 60, 13 to -2, 14 to KeyProperties.AUTH_DEVICE_CREDENTIAL, 15 to false,
            16 to true, 17 to true, 18 to false, 19 to true, 20 to KeyProperties.SECURITY_LEVEL_SOFTWARE,
            20 to KeyProperties.SECURITY_LEVEL_STRONGBOX)
        for ((index, value) in changes) {
            val p = completePlatform().also { it.profile = profile(mapOf(index to value)) }
            assertEquals("profile field $index", WitnessKeyObservation.Refused("unsupported_profile"),
                AndroidWitnessProvider(context(), p).observeFixedIdentity(started(c = WitnessDerFixture.challenge)))
        }
        val invalidated = completePlatform().also { it.fail = "keyInfo" }
        assertTrue(AndroidWitnessProvider(context(), invalidated).observeFixedIdentity(started(c = WitnessDerFixture.challenge)) is WitnessKeyObservation.Refused)
    }

    @Test fun missingMalformedSurplusOrMismatchedCertificateMaterialRefuses() {
        installSigningMetadata(2)
        val good = completePlatform()
        val variants = listOf<(TestPlatform) -> Unit>(
            { it.certificate = null }, { it.chain = null }, { it.chain = emptyArray() },
            { it.chain = Array(9) { good.certificate!! } },
            { it.chain = arrayOf(certificate(WitnessDerFixture.certificate(spki = WitnessDerFixture.spki.copyOf().also { b -> b[b.lastIndex] = 98 }))) },
            { it.certificate = certificate(WitnessDerFixture.certificate(WitnessDerFixture.seq(WitnessDerFixture.extension(WitnessDerFixture.description(ByteArray(32)))))); it.chain = arrayOf(it.certificate!!) })
        for (change in variants) {
            val p = completePlatform().also(change)
            assertTrue(AndroidWitnessProvider(context(), p).observeFixedIdentity(started(c = WitnessDerFixture.challenge)) is WitnessKeyObservation.Refused)
        }
    }

    @Test fun actualEncodedChainEnforcesInclusiveCountAndByteBounds() {
        installSigningMetadata(2)
        val original = started(c = WitnessDerFixture.challenge)
        fun sizedCertificate(size: Int): Certificate {
            val f = WitnessDerFixture
            fun padded(n: Int) = f.certificate(f.seq(f.extension(), f.seq(f.tlv(6, byteArrayOf(0x2a, 3)), f.tlv(4, ByteArray(n)))))
            val padding = (15000..16385).first { padded(it).size == size }
            return certificate(padded(padding))
        }
        val maximum = sizedCertificate(16384)
        val atLimit = completePlatform().also { it.certificate = maximum; it.chain = Array(4) { maximum } }
        val observation = AndroidWitnessProvider(context(), atLimit).observeFixedIdentity(original)
        assertTrue(observation is WitnessKeyObservation.Present)
        assertEquals(65536, (observation as WitnessKeyObservation.Present).metadata.certificateChain.sumOf { it.size })
        val eight = completePlatform().also { platform -> platform.chain = Array(8) { platform.certificate!! } }
        assertTrue(AndroidWitnessProvider(context(), eight).observeFixedIdentity(original) is WitnessKeyObservation.Present)
        atLimit.chain = Array(5) { maximum }
        assertEquals(WitnessKeyObservation.Refused("invalid_certificate_chain"), AndroidWitnessProvider(context(), atLimit).observeFixedIdentity(original))
        val oversized = sizedCertificate(16385)
        atLimit.certificate = oversized; atLimit.chain = arrayOf(oversized)
        assertEquals(WitnessKeyObservation.Refused("invalid_certificate_chain"), AndroidWitnessProvider(context(), atLimit).observeFixedIdentity(original))
    }

    @Test fun permanentInvalidationIsNeverAbsenceAndOrdinaryConstructorHasNoHostFallback() {
        val platform = TestPlatform().also { it.fail = "key"; it.failure = android.security.keystore.KeyPermanentlyInvalidatedException() }
        assertEquals(WitnessKeyObservation.Refused("key_observation_failed"), AndroidWitnessProvider(context(), platform).observeFixedIdentity(null))
        assertEquals(listOf("load", "key"), platform.calls)
        // Host JVM has no real AndroidKeyStore. The ordinary native constructor refuses; no fake provider is installed globally.
        assertTrue(AndroidWitnessProvider(context()).observeFixedIdentity(null) is WitnessKeyObservation.Refused)
    }

    private fun completePlatform() = TestPlatform().also {
        it.key = object : PrivateKey {
            override fun getAlgorithm() = "EdDSA"
            override fun getFormat(): String? = throw AssertionError("never export private-key format")
            override fun getEncoded(): ByteArray = throw AssertionError("never export private-key bytes")
        }
        it.certificate = certificate(WitnessDerFixture.certificate())
        it.chain = arrayOf(it.certificate!!)
        it.profile = profile()
    }
    private fun certificate(der: ByteArray): Certificate = CertificateFactory.getInstance("X.509").generateCertificate(der.inputStream())
    private fun installSigningMetadata(version: Int, signatures: Array<Signature> = arrayOf(Signature(WitnessDerFixture.signerCertificate))) {
        val info = PackageInfo().also {
            it.packageName = context().packageName; it.applicationInfo = context().applicationInfo; it.versionCode = version
            it.signingInfo = SigningInfo().also { signing -> Shadow.extract<ShadowSigningInfo>(signing).setSignatures(signatures) }
        }
        shadowOf(context().packageManager).installPackage(info)
    }
    /** Actual SDK KeyInfo value via its hidden constructor, confined to host fixtures; never an authorization token. */
    private fun profile(changes: Map<Int, Any> = emptyMap()): KeyInfo {
        val args = arrayOf<Any?>(AndroidWitnessProvider.FIXED_ALIAS, true, KeyProperties.ORIGIN_GENERATED, 256,
            null, null, null, KeyProperties.PURPOSE_SIGN, emptyArray<String>(), emptyArray<String>(), arrayOf(KeyProperties.DIGEST_NONE),
            emptyArray<String>(), true, 0, KeyProperties.AUTH_BIOMETRIC_STRONG, true, false, false, true, false,
            KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT, -1)
        changes.forEach { (index, value) -> args[index] = value }
        val constructor = KeyInfo::class.java.declaredConstructors.single { it.parameterTypes.size == args.size }
        constructor.isAccessible = true
        return constructor.newInstance(*args) as KeyInfo
    }

    private fun context(): Context = RuntimeEnvironment.getApplication()
    private fun started(a: ByteArray = ByteArray(32) { 1 }, c: ByteArray = ByteArray(32) { 2 }) =
        WitnessIdentityRecord(witness32(a), WitnessPhase.GENERATION_STARTED, witness32(c), null, 2)

    internal class TestPlatform : WitnessKeyPlatform {
        val calls = mutableListOf<String>(); val aliases = mutableListOf<String>()
        var fail: String? = null; var present: String? = null; var key: Key? = null
        var failure: Exception = UnrecoverableKeyException("synthetic platform refusal")
        var certificate: Certificate? = null; var chain: Array<Certificate>? = null; var profile: KeyInfo? = null
        private val placeholder = object : Certificate("X.509") {
            override fun getEncoded() = byteArrayOf(0)
            override fun verify(key: java.security.PublicKey?) = throw AssertionError()
            override fun verify(key: java.security.PublicKey?, provider: String?) = throw AssertionError()
            override fun getPublicKey(): java.security.PublicKey = throw AssertionError()
            override fun toString() = "synthetic public certificate"
        }
        fun call(name: String, alias: String? = null) {
            calls.add(name); if (alias != null) aliases.add(alias)
            if (fail == name) throw failure
        }
        override fun loadStore(): KeyStore {
            call("load")
            val spi = object : KeyStoreSpi() {
                override fun engineGetKey(alias: String, password: CharArray?): Key? { call("key", alias); assertNull(password); return key }
                override fun engineGetCertificate(alias: String): Certificate? { call("certificate", alias); return if (present == "certificate") placeholder else certificate }
                override fun engineGetCertificateChain(alias: String): Array<Certificate>? { call("chain", alias); return if (present == "chain") arrayOf(placeholder) else chain }
                override fun engineIsKeyEntry(alias: String): Boolean { call("keyEntry", alias); return present == "keyEntry" || key != null }
                override fun engineIsCertificateEntry(alias: String): Boolean { call("certificateEntry", alias); return present == "certificateEntry" }
                override fun engineContainsAlias(alias: String): Boolean = throw AssertionError("containsAlias is not an absence oracle")
                override fun engineAliases(): java.util.Enumeration<String> = throw AssertionError("no alias enumeration")
                override fun engineGetCreationDate(alias: String): Date = throw AssertionError()
                override fun engineSize(): Int = throw AssertionError()
                override fun engineGetCertificateAlias(cert: Certificate): String = throw AssertionError()
                override fun engineSetKeyEntry(alias: String, key: Key, password: CharArray?, chain: Array<out Certificate>?) = throw AssertionError("no mutation")
                override fun engineSetKeyEntry(alias: String, key: ByteArray, chain: Array<out Certificate>?) = throw AssertionError("no mutation")
                override fun engineSetCertificateEntry(alias: String, cert: Certificate) = throw AssertionError("no mutation")
                override fun engineDeleteEntry(alias: String) = throw AssertionError("no deletion")
                override fun engineStore(stream: OutputStream?, password: CharArray?) = throw AssertionError("no store")
                override fun engineLoad(stream: InputStream?, password: CharArray?) { assertNull(stream); assertNull(password) }
            }
            return object : KeyStore(spi, object : Provider("TestOnlyWitness", 1.0, "test-only") {}, "TestOnlyWitness") {}.also { it.load(null) }
        }
        override fun keyInfo(key: PrivateKey): KeyInfo { call("keyInfo"); assertSame(this.key, key); return requireNotNull(profile) }
    }
}
