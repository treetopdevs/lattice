package dev.treetop.lattice.treehouse.witness

/** Local public metadata parsing only; no certificate trust, signature verification or eligibility. */
internal object WitnessAttestationMetadata {
    class Application(val creationVersionCode: String, val signerSha256: WitnessBytes)
    class Leaf(val publicKey: WitnessBytes, val spki: WitnessBytes, val challenge: WitnessBytes, val application: Application)

    fun readLeaf(certificate: ByteArray): Leaf? = parsed {
        require(certificate.size in 1..16384)
        val reader = Der(certificate.copyOf())
        val outer = reader.root().sequence(3)
        val tbs = outer[0].sequence()
        outer[1].algorithm()
        require(outer[2].isTag(3))
        // Extensions require v3. Fields are positional; a matching OID elsewhere is never selected.
        require(tbs.size in 8..10 && tbs[0].isTag(0xa0))
        val version = tbs[0].children.single()
        require(version.isTag(2) && version.value().contentEquals(byteArrayOf(2)))
        require(tbs[1].isTag(2))
        tbs[2].algorithm()
        require(tbs[2].encoded().contentEquals(outer[1].encoded()))
        tbs[3].name(); tbs[5].name()
        val validity = tbs[4].sequence(2)
        validity.forEach { it.time() }
        val spki = tbs[6].encoded()
        val publicKey = requireNotNull(readEd25519Spki(spki))
        var cursor = 7
        for (optional in listOf(0x81, 0x82)) {
            if (cursor < tbs.size && tbs[cursor].isTag(optional)) {
                bitString(tbs[cursor].value()); cursor++
            }
        }
        require(cursor == tbs.lastIndex && tbs[cursor].isTag(0xa3))
        val extensions = tbs[cursor].children.single().sequence()
        require(extensions.isNotEmpty())
        val seen = mutableSetOf<WitnessBytes>()
        var description: Node? = null
        for (extension in extensions) {
            val fields = extension.sequence()
            require(fields.size in 2..3 && fields[0].isTag(6))
            require(seen.add(WitnessBytes(fields[0].value())))
            if (fields.size == 3) require(fields[1].isTag(1) && fields[1].value().contentEquals(byteArrayOf(-1)))
            val value = fields.last()
            require(value.isTag(4))
            if (fields[0].value().contentEquals(ATTESTATION_OID)) {
                description = reader.embedded(value)
            }
        }
        val fields = requireNotNull(description).sequence(8)
        require(fields[0].isTag(2) && fields[1].isTag(10) && fields[2].isTag(2) && fields[3].isTag(10))
        require(fields.take(4).all { it.value().first().toInt() and 0x80 == 0 })
        require(fields[4].isTag(4) && fields[4].value().size == 32 && fields[5].isTag(4))
        var application: Application? = null
        for ((index, authorization) in fields.drop(6).withIndex()) {
            val tags = mutableSetOf<WitnessBytes>()
            for (entry in authorization.sequence()) {
                require(entry.tagClass == 0x80 && entry.constructed && entry.children.size == 1)
                require(tags.add(WitnessBytes(entry.identifier())))
                if (entry.identifier().contentEquals(APPLICATION_TAG)) {
                    require(index == 0 && application == null)
                    val value = entry.children.single()
                    require(value.isTag(4))
                    val app = reader.embedded(value).sequence(2)
                    require(app.all { it.isTag(0x31) && it.children.size == 1 })
                    val pkg = app[0].children.single().sequence(2)
                    require(pkg[0].isTag(4) && pkg[0].value().contentEquals(APP_ID))
                    val creationVersion = pkg[1].positiveLong()
                    val signer = app[1].children.single()
                    require(signer.isTag(4) && signer.value().size == 32)
                    application = Application(creationVersion.toString(), witness32(signer.value()))
                }
            }
        }
        Leaf(publicKey, WitnessBytes(spki), witness32(fields[4].value()), requireNotNull(application))
    }

    /** Work/DER bounds for other already-parsed platform X.509 chain entries; no chain validation. */
    fun isBoundedCertificate(certificate: ByteArray): Boolean = parsed {
        require(certificate.size in 1..16384)
        val outer = Der(certificate.copyOf()).root().sequence(3)
        outer[0].sequence(); outer[1].algorithm(); require(outer[2].isTag(3))
        true
    } == true

    fun readEd25519Spki(spki: ByteArray): WitnessBytes? = parsed {
        // Exact RFC8410 form: OID 1.3.101.112, absent parameters, zero unused bits.
        require(spki.size == 44 && spki.copyOfRange(0, 12).contentEquals(SPKI_PREFIX))
        witness32(spki.copyOfRange(12, 44))
    }

    private inline fun <T> parsed(block: () -> T): T? = try { block() } catch (_: IllegalArgumentException) { null }
        catch (_: NoSuchElementException) { null }

    private val SPKI_PREFIX = byteArrayOf(0x30, 0x2a, 0x30, 5, 6, 3, 0x2b, 0x65, 0x70, 3, 0x21, 0)
    private val ATTESTATION_OID = byteArrayOf(0x2b, 6, 1, 4, 1, 0xd6.toByte(), 0x79, 2, 1, 0x11)
    private val APPLICATION_TAG = byteArrayOf(0xbf.toByte(), 0x85.toByte(), 0x45)
    private val APP_ID = "dev.treetop.lattice.treehouse".toByteArray(Charsets.US_ASCII)

    private class Node(val bytes: ByteArray, val start: Int, val tagEnd: Int, val content: Int,
        val end: Int, val depth: Int, val children: List<Node>) {
        val tagClass: Int get() = bytes[start].toInt() and 0xc0
        val constructed: Boolean get() = bytes[start].toInt() and 0x20 != 0
        fun isTag(tag: Int) = tagEnd == start + 1 && bytes[start].toInt() and 0xff == tag
        fun identifier() = bytes.copyOfRange(start, tagEnd)
        fun value() = bytes.copyOfRange(content, end)
        fun encoded() = bytes.copyOfRange(start, end)
        fun sequence(size: Int? = null): List<Node> {
            require(isTag(0x30) && (size == null || children.size == size))
            return children
        }
        fun algorithm() { val fields = sequence(); require(fields.size in 1..2 && fields[0].isTag(6)) }
        fun positiveLong(): Long {
            val raw = value()
            require(isTag(2) && raw.size in 1..8 && raw[0].toInt() and 0x80 == 0)
            var value = 0L
            raw.forEach { value = (value shl 8) or (it.toLong() and 0xff) }
            require(value > 0)
            return value
        }
        fun name() {
            for (rdn in sequence()) {
                require(rdn.isTag(0x31) && rdn.children.isNotEmpty())
                rdn.children.forEach { require(it.sequence(2)[0].isTag(6)) }
            }
        }
        fun time() {
            require(isTag(23) || isTag(24))
            val raw = value()
            val digits = if (isTag(23)) 12 else 14
            require(raw.size == digits + 1 && raw.last() == 'Z'.code.toByte() && raw.take(digits).all { it in 48..57 })
            val text = raw.toString(Charsets.US_ASCII)
            val yearDigits = if (isTag(23)) 2 else 4
            var year = text.substring(0, yearDigits).toInt()
            if (yearDigits == 2) year += if (year >= 50) 1900 else 2000
            val month = text.substring(yearDigits, yearDigits + 2).toInt()
            val day = text.substring(yearDigits + 2, yearDigits + 4).toInt()
            require(year > 0 && month in 1..12)
            val leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
            val days = intArrayOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
            require(day in 1..days[month - 1] && text.substring(yearDigits + 4, yearDigits + 6).toInt() in 0..23 &&
                text.substring(yearDigits + 6, yearDigits + 8).toInt() in 0..59 && text.substring(yearDigits + 8, yearDigits + 10).toInt() in 0..59)
        }
    }

    /** Counts every traversed TLV, including the known extension's embedded description. */
    private class Der(val bytes: ByteArray) {
        private var count = 0
        fun root(): Node = node(0, bytes.size, 1).also { require(it.end == bytes.size) }
        fun embedded(value: Node): Node = node(value.content, value.end, value.depth + 1).also { require(it.end == value.end) }
        private fun node(start: Int, limit: Int, depth: Int): Node {
            require(depth <= 32 && ++count <= 8192 && start < limit)
            var cursor = start
            val first = bytes[cursor++].toInt() and 0xff
            require(first != 0)
            if (first and 0x1f == 0x1f) {
                require(cursor < limit && bytes[cursor].toInt() and 0x7f != 0)
                val tagStart = cursor
                do { require(cursor < limit); val octet = bytes[cursor++].toInt() and 0xff } while (octet and 0x80 != 0)
                require(cursor > tagStart + 1 || bytes[tagStart].toInt() and 0x7f >= 31)
            }
            val tagEnd = cursor
            require(cursor < limit)
            val initialLength = bytes[cursor++].toInt() and 0xff
            var length = initialLength
            if (initialLength >= 128) {
                val octets = initialLength and 0x7f
                require(octets in 1..2 && cursor + octets <= limit && bytes[cursor].toInt() != 0)
                length = 0
                repeat(octets) { length = (length shl 8) or (bytes[cursor++].toInt() and 0xff) }
                require(length >= 128 && (octets == 1 || length >= 256))
            }
            require(length <= limit - cursor)
            val end = cursor + length
            val content = cursor
            val children = mutableListOf<Node>()
            if (first and 0x20 != 0) {
                while (cursor < end) {
                    val child = node(cursor, end, depth + 1)
                    children.add(child); cursor = child.end
                }
            }
            val result = Node(bytes, start, tagEnd, content, end, depth, children)
            if (first and 0xc0 == 0) {
                // X.509/KeyDescription use primitive scalars and SEQUENCE/SET containers.
                require((first and 0x20 != 0) == (result.isTag(0x30) || result.isTag(0x31)))
                when {
                    result.isTag(1) -> require(length == 1 && bytes[content] in listOf(0.toByte(), (-1).toByte()))
                    result.isTag(2) || result.isTag(10) -> {
                        require(length > 0)
                        if (length > 1) require(!(bytes[content] == 0.toByte() && bytes[content + 1].toInt() and 0x80 == 0) &&
                            !(bytes[content] == (-1).toByte() && bytes[content + 1].toInt() and 0x80 != 0))
                    }
                    result.isTag(3) -> bitString(result.value())
                    result.isTag(5) -> require(length == 0)
                    result.isTag(6) -> {
                        require(length > 0)
                        var at = content
                        while (at < end) {
                            require(bytes[at].toInt() and 0xff != 0x80)
                            do { require(at < end); val octet = bytes[at++].toInt() and 0xff } while (octet and 0x80 != 0)
                        }
                    }
                    result.isTag(0x31) -> for (i in 1 until children.size) require(compare(children[i - 1].encoded(), children[i].encoded()) <= 0)
                }
            }
            return result
        }
    }

    private fun bitString(value: ByteArray) {
        require(value.isNotEmpty())
        val unused = value[0].toInt()
        require(unused in 0..7 && (value.size > 1 || unused == 0))
        if (unused != 0) require(value.last().toInt() and ((1 shl unused) - 1) == 0)
    }
    private fun compare(a: ByteArray, b: ByteArray): Int {
        for (i in 0 until minOf(a.size, b.size)) {
            val delta = (a[i].toInt() and 0xff) - (b[i].toInt() and 0xff)
            if (delta != 0) return delta
        }
        return a.size - b.size
    }
}
