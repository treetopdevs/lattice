package dev.treetop.lattice.treehouse.witness

import org.junit.Assert.*
import org.junit.Test

class WitnessAttestationMetadataTest {
    @Test fun readsOriginalApplicationVersionAndSignerFromTheLeafNotCurrentPackageMetadata() {
        val f = WitnessDerFixture
        for (version in listOf(1L, Long.MAX_VALUE)) {
            val description = f.description(software = f.seq(f.application(version = version)))
            val leaf = requireNotNull(WitnessAttestationMetadata.readLeaf(f.certificate(f.seq(f.extension(description)))))
            val app = requireNotNull(leaf.application)
            assertEquals(version.toString(), app.creationVersionCode)
            assertArrayEquals(f.signerDigest, app.signerSha256.copyBytes())
        }
    }

    @Test fun application709IsClosedUniqueSoftwareOnlyAndCannotBorrowAnotherExtension() {
        val f = WitnessDerFixture
        val malformed = listOf(f.description(software = f.seq()),
            f.description(software = f.seq(f.application(), f.application())),
            f.description(software = f.seq(), tee = f.seq(f.application())),
            f.description(tee = f.seq(f.application())),
            f.description(software = f.seq(f.context(709, f.seq()))),
            f.description(software = f.seq(f.context(709, f.tlv(4, f.applicationBody() + byteArrayOf(0))))))
        for (d in malformed) assertNull(WitnessAttestationMetadata.readLeaf(f.certificate(f.seq(f.extension(d)))))
        val bodies = listOf(f.applicationBody(packages = f.tlv(0x31)),
            f.applicationBody(packages = f.tlv(0x31, f.packageInfo() + f.packageInfo())),
            f.applicationBody(packages = f.tlv(0x31, f.packageInfo(name = "dev.other".toByteArray()))),
            f.applicationBody(packages = f.tlv(0x31, f.packageInfo(name = byteArrayOf(0xc0.toByte(), 0x80.toByte())))),
            f.applicationBody(packages = f.tlv(0x31, f.packageInfo(version = f.integer(0)))),
            f.applicationBody(packages = f.tlv(0x31, f.packageInfo(version = f.integer(-1)))),
            f.applicationBody(packages = f.tlv(0x31, f.packageInfo(version = f.tlv(2, byteArrayOf(0) + ByteArray(8) { 0x80.toByte() })))),
            f.applicationBody(packages = f.tlv(0x31, f.packageInfo(version = f.tlv(2, byteArrayOf(0, 1))))),
            f.applicationBody(signers = f.tlv(0x31)),
            f.applicationBody(signers = f.tlv(0x31, f.tlv(4, f.signerDigest) + f.tlv(4, f.signerDigest))),
            f.applicationBody(signers = f.tlv(0x31, f.tlv(4, ByteArray(31)))),
            f.seq(f.tlv(0x31, f.packageInfo()), f.tlv(0x31, f.tlv(4, f.signerDigest)), f.integer(1)))
        for ((index, body) in bodies.withIndex()) {
            val cert = f.certificate(f.seq(f.extension(f.description(software = f.seq(f.context(709, f.tlv(4, body)))))))
            assertNull("application body $index", WitnessAttestationMetadata.readLeaf(cert))
        }
    }

    @Test fun extractsOnlyExactOriginalPublicBytesAndOwnsThem() {
        val certificate = WitnessDerFixture.certificate()
        val leaf = requireNotNull(WitnessAttestationMetadata.readLeaf(certificate))
        assertArrayEquals(WitnessDerFixture.publicKey, leaf.publicKey.copyBytes())
        assertArrayEquals(WitnessDerFixture.spki, leaf.spki.copyBytes())
        assertArrayEquals(WitnessDerFixture.challenge, leaf.challenge.copyBytes())
        certificate.fill(0)
        leaf.challenge.copyBytes().fill(0)
        assertArrayEquals(WitnessDerFixture.challenge, leaf.challenge.copyBytes())
    }

    @Test fun spkiRequiresEd25519AbsentParametersAndExactly32BitsPayloadBytes() {
        assertArrayEquals(WitnessDerFixture.publicKey, requireNotNull(WitnessAttestationMetadata.readEd25519Spki(WitnessDerFixture.spki)).copyBytes())
        val f = WitnessDerFixture
        for (bad in listOf(f.spki + byteArrayOf(0), f.seq(f.seq(f.edOid, f.tlv(5)), f.bits(f.publicKey)),
            f.seq(f.seq(f.tlv(6, byteArrayOf(0x2b, 0x65, 0x6e))), f.bits(f.publicKey)),
            f.seq(f.seq(f.edOid), f.bits(f.publicKey.copyOf(31))),
            f.seq(f.seq(f.edOid), f.tlv(3, byteArrayOf(1) + f.publicKey)))) {
            assertNull(WitnessAttestationMetadata.readEd25519Spki(bad))
        }
    }

    @Test fun refusesMalformedWrappersLengthsDuplicatesAndEveryTruncation() {
        val f = WitnessDerFixture
        val good = f.certificate()
        for (length in good.indices) assertNull("truncated $length", WitnessAttestationMetadata.readLeaf(good.copyOf(length)))
        val bad = listOf(good + byteArrayOf(0), byteArrayOf(0x30, 0x80.toByte(), 0, 0),
            byteArrayOf(0x30, 0x82.toByte(), 0, 1, 0), f.certificate(f.seq()),
            f.certificate(f.seq(f.extension(), f.extension())),
            f.certificate(f.seq(f.seq(f.attestationOid, f.tlv(1, byteArrayOf(0)), f.tlv(4, f.description())))),
            f.certificate(f.seq(f.extension(f.description() + byteArrayOf(0)))),
            f.certificate(f.seq(f.extension(f.description(ByteArray(31))))),
            f.certificate(f.seq(f.extension(f.description(software = f.seq(f.tlv(0xa1, f.integer(1)), f.tlv(0xa1, f.integer(1))))))),
            f.certificate(f.seq(f.extension(f.description(tee = f.seq(f.tlv(0xa2, f.integer(1) + f.integer(2))))))))
        bad.forEachIndexed { i, bytes -> assertNull("malformed $i", WitnessAttestationMetadata.readLeaf(bytes)) }
        val nonminimalInteger = f.description(version = f.tlv(2, byteArrayOf(0, 3)))
        assertNull(WitnessAttestationMetadata.readLeaf(f.certificate(f.seq(f.extension(nonminimalInteger)))))
    }

    @Test fun allKnownDescriptionFieldsAreTraversedButUnrelatedOpaqueOctetsAreNot() {
        val f = WitnessDerFixture
        val malformed = f.seq(f.tlv(0xa9, f.seq(byteArrayOf(2, 2, 0, 1))))
        assertNull(WitnessAttestationMetadata.readLeaf(f.certificate(f.seq(f.extension(f.description(tee = malformed))))))
        // The unknown extension is opaque even when its content is not DER.
        val opaque = f.seq(f.tlv(6, byteArrayOf(0x2a, 3)), f.tlv(4, byteArrayOf(0x30, 0x80.toByte(), 0)))
        assertNotNull(WitnessAttestationMetadata.readLeaf(f.certificate(f.seq(opaque, f.extension()))))
        val duplicateUnknown = f.certificate(f.seq(opaque, opaque, f.extension()))
        assertNull(WitnessAttestationMetadata.readLeaf(duplicateUnknown))
    }

    @Test fun namesAndValidityMustHaveTheirActualX509Structure() {
        val f = WitnessDerFixture
        assertNull(WitnessAttestationMetadata.readLeaf(f.certificate(name = f.seq(f.integer(1)))))
        assertNull(WitnessAttestationMetadata.readLeaf(f.certificate(name = f.seq(f.tlv(0x31)))))
        assertNull(WitnessAttestationMetadata.readLeaf(f.certificate(validity = f.seq(f.tlv(23), f.tlv(23)))))
        assertNull(WitnessAttestationMetadata.readLeaf(f.certificate(validity = f.seq(f.tlv(23, "260231000000Z".toByteArray()), f.tlv(23, "270101000000Z".toByteArray())))))
    }

    @Test fun inclusiveDepth32AndCertificate16384BoundsHaveRealNeighborControls() {
        val f = WitnessDerFixture
        fun deep(n: Int): ByteArray {
            var payload = f.integer(1)
            repeat(n) { payload = f.seq(payload) }
            return f.certificate(f.seq(f.extension(f.description(tee = f.seq(f.tlv(0xa9, payload))))))
        }
        assertNotNull("deepest traversed node32", WitnessAttestationMetadata.readLeaf(deep(22)))
        assertNull("deepest traversed node33", WitnessAttestationMetadata.readLeaf(deep(23)))
        fun padded(n: Int) = f.certificate(f.seq(f.extension(), f.seq(f.tlv(6, byteArrayOf(0x2a, 3)), f.tlv(4, ByteArray(n)))))
        val count = (15000..16384).first { padded(it).size == 16384 }
        assertNotNull(WitnessAttestationMetadata.readLeaf(padded(count)))
        assertEquals(16385, padded(count + 1).size)
        assertNull(WitnessAttestationMetadata.readLeaf(padded(count + 1)))
        // 7900 two-byte leaf nodes really traverse. 8192 nodes cannot fit a legal certificate:
        // 2 bytes each already consume16KiB, before required nonempty fields/long lengths.
        val many = ByteArray(7900 * 2) { if (it % 2 == 0) 5 else 0 }
        val wide = f.certificate(f.seq(f.extension(f.description(tee = f.seq(f.tlv(0xa9, f.tlv(0x30, many)))))))
        assertTrue(wide.size <= 16384)
        assertNotNull(WitnessAttestationMetadata.readLeaf(wide))
    }
}

/** Unsigned synthetic X.509 structure, deliberately no custody or chain-trust oracle. */
internal object WitnessDerFixture {
    val publicKey = ByteArray(32) { (it + 1).toByte() }
    val challenge = ByteArray(32) { (it + 33).toByte() }
    val edOid = tlv(6, byteArrayOf(0x2b, 0x65, 0x70))
    val attestationOid = tlv(6, byteArrayOf(0x2b, 6, 1, 4, 1, 0xd6.toByte(), 0x79, 2, 1, 0x11))
    val spki = seq(seq(edOid), bits(publicKey))
    val signerCertificate = byteArrayOf(11, 12, 13)
    val signerDigest = java.security.MessageDigest.getInstance("SHA-256").digest(signerCertificate)
    fun tlv(tag: Int, bytes: ByteArray = byteArrayOf()): ByteArray {
        val size = when { bytes.size < 128 -> byteArrayOf(bytes.size.toByte()); bytes.size < 256 -> byteArrayOf(0x81.toByte(), bytes.size.toByte())
            else -> byteArrayOf(0x82.toByte(), (bytes.size ushr 8).toByte(), bytes.size.toByte()) }
        return byteArrayOf(tag.toByte()) + size + bytes
    }
    fun seq(vararg fields: ByteArray) = tlv(0x30, fields.fold(byteArrayOf()) { a, b -> a + b })
    fun bits(bytes: ByteArray) = tlv(3, byteArrayOf(0) + bytes)
    fun integer(n: Int) = tlv(2, byteArrayOf(n.toByte()))
    fun context(tag: Int, child: ByteArray): ByteArray {
        require(tag == 709)
        return byteArrayOf(0xbf.toByte(), 0x85.toByte(), 0x45) + tlv(0, child).drop(1).toByteArray()
    }
    fun packageInfo(name: ByteArray = "dev.treetop.lattice.treehouse".toByteArray(), version: ByteArray = integer(1)) = seq(tlv(4, name), version)
    fun applicationBody(packages: ByteArray = tlv(0x31, packageInfo()), signers: ByteArray = tlv(0x31, tlv(4, signerDigest))) = seq(packages, signers)
    fun application(version: Long = 1) = context(709, tlv(4, applicationBody(packages = tlv(0x31, packageInfo(version = tlv(2, java.math.BigInteger.valueOf(version).toByteArray()))))))
    fun description(challenge: ByteArray = this.challenge, software: ByteArray = seq(application()), tee: ByteArray = seq(), version: ByteArray = integer(3)) =
        seq(version, tlv(10, byteArrayOf(1)), integer(4), tlv(10, byteArrayOf(1)), tlv(4, challenge), tlv(4), software, tee)
    fun extension(description: ByteArray = description()) = seq(attestationOid, tlv(4, description))
    fun certificate(extensions: ByteArray = seq(extension()), spki: ByteArray = this.spki,
        name: ByteArray = seq(tlv(0x31, seq(tlv(6, byteArrayOf(0x55, 4, 3)), tlv(12, "Synthetic".toByteArray())))),
        validity: ByteArray = seq(tlv(23, "260101000000Z".toByteArray()), tlv(23, "270101000000Z".toByteArray()))): ByteArray {
        val algorithm = seq(edOid)
        return seq(seq(tlv(0xa0, integer(2)), integer(1), algorithm, name, validity, name, spki, tlv(0xa3, extensions)), algorithm, bits(ByteArray(64)))
    }
}
