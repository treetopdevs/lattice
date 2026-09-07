package dev.treetop.lattice.treehouse.witness

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import android.util.Base64

internal sealed interface WitnessPrivateRequest {
    val operationId: WitnessBytes
    val sessionDigest: WitnessBytes
    data class Identity(override val operationId: WitnessBytes, override val sessionDigest: WitnessBytes): WitnessPrivateRequest
    data class Prepare(override val operationId: WitnessBytes, override val sessionDigest: WitnessBytes, val replica: String,
        val enrollmentId: WitnessBytes, val recipient: WitnessBytes, val creationAttemptId: WitnessBytes): WitnessPrivateRequest
    data class Generate(override val operationId: WitnessBytes, override val sessionDigest: WitnessBytes, val expectedRevision: Long,
        val creationAttemptId: WitnessBytes, val generationChallenge: WitnessBytes): WitnessPrivateRequest
    data class Proof(override val operationId: WitnessBytes, override val sessionDigest: WitnessBytes, val expectedRevision: Long,
        val replica: String, val enrollmentId: WitnessBytes, val recipient: WitnessBytes, val freshValidatorNonce: WitnessBytes, val nativeNonce: WitnessBytes): WitnessPrivateRequest
    data class SignPrepared(override val operationId: WitnessBytes, override val sessionDigest: WitnessBytes,
        val handle: WitnessBytes): WitnessPrivateRequest
    data class Cancel(override val operationId: WitnessBytes, override val sessionDigest: WitnessBytes,
        val targetOperationId: WitnessBytes): WitnessPrivateRequest
}

internal enum class WitnessPrivateKind { IDENTITY, PREPARE, GENERATE, PROOF, CANCEL }
internal enum class WitnessTerminalStatus { MISSING, REFUSED, CANCELLED }
internal data class WitnessTerminalResponse(val kind: WitnessPrivateKind, val operationId: WitnessBytes,
    val status: WitnessTerminalStatus, val reason: String? = null)

/** Pure closed protocol codec; it neither registers IPC nor performs a custody operation. */
internal object WitnessPrivateProtocol {
    const val PROTOCOL = "treehouse-witness-private-v1"
    const val MAX_MESSAGE = 128 * 1024
    private const val APP_ID = "dev.treetop.lattice.treehouse"
    private const val OWNER = "main"

    fun decodeRequest(bytes: ByteArray): WitnessPrivateRequest? {
      return try {
        val objectValue = strictObject(bytes)
        require(objectValue.getValue("protocol") == PROTOCOL)
        val operation = field32(objectValue, "operationId")
        val session = field32(objectValue, "sessionDigest")
        when (objectValue.getValue("kind")) {
            "identity" -> { exact(objectValue, "kind","protocol","operationId","sessionDigest"); WitnessPrivateRequest.Identity(operation, session) }
            "prepare" -> { exact(objectValue,"kind","protocol","operationId","sessionDigest","replica","enrollmentId","recipient","creationAttemptId")
                WitnessPrivateRequest.Prepare(operation, session, replica(objectValue), field32(objectValue,"enrollmentId"), field32(objectValue,"recipient"), field32(objectValue,"creationAttemptId")) }
            "generate" -> { exact(objectValue,"kind","protocol","operationId","sessionDigest","expectedRevision","creationAttemptId","generationChallenge")
                WitnessPrivateRequest.Generate(operation, session, revision(objectValue), field32(objectValue,"creationAttemptId"), field32(objectValue,"generationChallenge")) }
            "proof" -> { exact(objectValue,"kind","protocol","operationId","sessionDigest","expectedRevision","replica","enrollmentId","recipient","freshValidatorNonce","nativeNonce")
                WitnessPrivateRequest.Proof(operation, session, revision(objectValue), replica(objectValue), field32(objectValue,"enrollmentId"), field32(objectValue,"recipient"), field32(objectValue,"freshValidatorNonce"), field32(objectValue,"nativeNonce")) }
            "sign_prepared" -> { exact(objectValue,"kind","protocol","operationId","sessionDigest","handle")
                WitnessPrivateRequest.SignPrepared(operation, session, field32(objectValue,"handle")) }
            "cancel" -> { exact(objectValue,"kind","protocol","operationId","sessionDigest","targetOperationId")
                WitnessPrivateRequest.Cancel(operation, session, field32(objectValue,"targetOperationId")) }
            else -> null
        }
      } catch (_: Exception) { null }
    }

    fun encodeTerminal(response: WitnessTerminalResponse): ByteArray? {
      return try {
        require(response.operationId.size == 32)
        if ((response.status == WitnessTerminalStatus.REFUSED) != (response.reason != null) ||
            response.reason?.let { !validReason(it) } == true) return null
        val reason = response.reason?.let { ",\"reason\":\"$it\"" } ?: ""
        ("{\"protocol\":\"$PROTOCOL\",\"kind\":\"${response.kind.name.lowercase()}\"," +
            "\"operationId\":\"${canonical(response.operationId)}\",\"status\":\"${response.status.name.lowercase()}\"$reason}")
            .toByteArray(StandardCharsets.UTF_8).takeIf { it.size <= MAX_MESSAGE }
      } catch (_: Exception) { null }
    }

    fun decodeTerminal(bytes: ByteArray): WitnessTerminalResponse? {
      return try {
        val value = strictObject(bytes)
        require(value.getValue("protocol") == PROTOCOL)
        val status = when(value.getValue("status")) { "missing" -> WitnessTerminalStatus.MISSING; "refused" -> WitnessTerminalStatus.REFUSED; "cancelled" -> WitnessTerminalStatus.CANCELLED; else -> return null }
        val reason = value["reason"]
        exact(value, *if (reason == null) arrayOf("protocol","kind","operationId","status") else arrayOf("protocol","kind","operationId","status","reason"))
        if ((status == WitnessTerminalStatus.REFUSED) != (reason != null) || reason?.let { !validReason(it) } == true) return null
        val kind = when(value.getValue("kind")) { "identity" -> WitnessPrivateKind.IDENTITY; "prepare" -> WitnessPrivateKind.PREPARE; "generate" -> WitnessPrivateKind.GENERATE; "proof" -> WitnessPrivateKind.PROOF; "cancel" -> WitnessPrivateKind.CANCEL; else -> return null }
        WitnessTerminalResponse(kind, field32(value,"operationId"), status, reason)
      } catch (_: Exception) { null }
    }

    fun sessionDigest(launchNonce: ByteArray, navigationNonce: ByteArray): WitnessBytes {
        val values = arrayOf("treehouse-native-caller-session-v1".toByteArray(), APP_ID.toByteArray(), OWNER.toByteArray(), witness32(launchNonce).copyBytes(), witness32(navigationNonce).copyBytes())
        val out = ByteArrayOutputStream().apply { write(0x85); values.forEach { binary(this, it) } }
        return WitnessBytes(MessageDigest.getInstance("SHA-256").digest(out.toByteArray()))
    }

    private fun strictObject(bytes: ByteArray): Map<String,String> {
        require(bytes.isNotEmpty() && bytes.size <= MAX_MESSAGE)
        val text = StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        return FlatJson(text).objectValue()
    }

    private fun exact(value: Map<String,String>, vararg names: String) { require(value.keys == names.toSet()) }
    private fun field32(value: Map<String,String>, name: String): WitnessBytes { val encoded=value.getValue(name); require(encoded.length==44); val raw=Base64.decode(encoded, Base64.NO_WRAP); require(raw.size==32 && Base64.encodeToString(raw, Base64.NO_WRAP)==encoded); return WitnessBytes(raw) }
    private fun canonical(value: WitnessBytes) = Base64.encodeToString(value.copyBytes(), Base64.NO_WRAP)
    private fun replica(value: Map<String,String>): String = value.getValue("replica").also { require(it.isNotEmpty() && it.toByteArray(StandardCharsets.UTF_8).size <= 512) }
    private fun revision(value: Map<String,String>): Long { val text=value.getValue("expectedRevision"); require(text.length in 1..19 && text.all { it in '0'..'9' } && (text.length==1 || text[0]!='0')); return text.toLong().also { require(it>0) } }
    private fun validReason(reason: String) = reason.isNotEmpty() && reason.length<=64 && reason.all { it in 'a'..'z' || it=='_' }
    private fun binary(out: ByteArrayOutputStream, bytes: ByteArray) { when(bytes.size) { in 0..23 -> out.write(0x40 or bytes.size); in 24..255 -> { out.write(0x58); out.write(bytes.size) }; else -> { out.write(0x59); out.write(bytes.size ushr 8); out.write(bytes.size) } }; out.write(bytes) }

    private class FlatJson(private val text:String) {
        private var at=0
        fun objectValue(): Map<String,String> { ws(); take('{'); ws(); val out=linkedMapOf<String,String>(); if(peek('}')) { at++; ws(); require(at==text.length); return out }
            while(true) { val key=string(); require(!out.containsKey(key)); ws(); take(':'); ws(); out[key]=string(); ws(); if(peek('}')) { at++; ws(); require(at==text.length); return out }; take(','); ws() } }
        private fun string():String { take('"'); val out=StringBuilder(); while(at<text.length) { val c=text[at++]; when { c=='"' -> return out.toString(); c=='\\' -> escape(out); c<' ' -> error("control"); c.isHighSurrogate() -> { require(at<text.length && text[at].isLowSurrogate()); out.append(c).append(text[at++]) }; c.isLowSurrogate() -> error("raw low surrogate"); else -> out.append(c) } }; error("unterminated") }
        private fun escape(out:StringBuilder) { require(at<text.length); when(val c=text[at++]) { '"','\\','/' -> out.append(c); 'b'->out.append('\b'); 'f'->out.append('\u000c'); 'n'->out.append('\n'); 'r'->out.append('\r'); 't'->out.append('\t'); 'u' -> { val first=hex(); when { first in 0xd800..0xdbff -> { require(at+2<=text.length && text.substring(at,at+2)=="\\u"); at+=2; val second=hex(); require(second in 0xdc00..0xdfff); out.appendCodePoint(Character.toCodePoint(first.toChar(),second.toChar())) }; first in 0xdc00..0xdfff -> error("low surrogate"); else -> out.append(first.toChar()) } }; else -> error("escape") } }
        private fun hex(): Int {
            require(at + 4 <= text.length)
            val digits = text.substring(at, at + 4)
            require(digits.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' })
            at += 4
            return digits.toInt(16)
        }
        private fun ws() { while(at<text.length && text[at] in charArrayOf(' ','\t','\n','\r')) at++ }
        private fun take(c:Char) { require(at<text.length && text[at++]==c) }
        private fun peek(c:Char)=at<text.length && text[at]==c
    }
}
