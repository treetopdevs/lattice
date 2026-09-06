package dev.treetop.lattice.treehouse.witness

import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.io.ByteArrayOutputStream
import dev.treetop.lattice.treehouse.BuildConfig

/** Proposed public facts only. It has no native consent, key or signing interface. */
class PublicBindingClaim(replica: String, fields: List<ByteArray>) {
    init {
        require(replica.length in 1..512) { "invalid_binding_replica" }
        require(fields.size == 8 && fields.all { it.size == 32 }) { "invalid_binding_fields" }
    }
    private val replicaBytes: ByteArray = StandardCharsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        .encode(CharBuffer.wrap(replica)).let { buffer -> ByteArray(buffer.remaining()).also { buffer.get(it) } }
    private val binaryFields = fields.map { it.copyOf() }
    init {
        require(replicaBytes.size in 1..512) { "invalid_binding_replica" }
    }
    internal fun fieldCopies(): List<ByteArray> = binaryFields.map { it.copyOf() }
    internal fun replicaCopy(): ByteArray = replicaBytes.copyOf()
}

object BindingCodec {
    fun encode(claim: PublicBindingClaim): ByteArray {
        val output = ByteArrayOutputStream()
        output.write(0x8d)
        binary(output, "lattice-witness-binding-challenge-v1".toByteArray(StandardCharsets.UTF_8))
        output.write(1)
        binary(output, BuildConfig.LATTICE_PRODUCT.toByteArray(StandardCharsets.UTF_8))
        binary(output, BuildConfig.LATTICE_APP_ID.toByteArray(StandardCharsets.UTF_8))
        binary(output, claim.replicaCopy())
        claim.fieldCopies().forEach { binary(output, it) }
        return output.toByteArray()
    }

    private fun binary(output: ByteArrayOutputStream, value: ByteArray) {
        when (value.size) {
            in 0..23 -> output.write(0x40 or value.size)
            in 24..255 -> { output.write(0x58); output.write(value.size) }
            else -> { output.write(0x59); output.write(value.size ushr 8); output.write(value.size and 255) }
        }
        output.write(value)
    }
}
