package com.android.keyattestation.verifier

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.StringReader

private const val MAX_JSON_DEPTH = 32

internal fun strictPublicJson(bytes: ByteArray): JsonElement {
  require(bytes.size <= 131_072)
  val text = bytes.toString(Charsets.UTF_8)
  require(text.toByteArray(Charsets.UTF_8).contentEquals(bytes))
  val reader = JsonReader(StringReader(text)).apply { strictness = Strictness.STRICT }
  fun read(depth: Int): JsonElement {
    require(depth <= MAX_JSON_DEPTH)
    return when (reader.peek()) {
      JsonToken.BEGIN_OBJECT -> JsonObject().also { value ->
        reader.beginObject()
        while (reader.hasNext()) { val name = reader.nextName(); require(!value.has(name)); value.add(name, read(depth + 1)) }
        reader.endObject()
      }
      JsonToken.BEGIN_ARRAY -> JsonArray().also { value ->
        reader.beginArray(); while (reader.hasNext()) value.add(read(depth + 1)); reader.endArray()
      }
      JsonToken.STRING -> JsonPrimitive(reader.nextString())
      JsonToken.NUMBER -> JsonPrimitive(RawJsonNumber(reader.nextString()))
      JsonToken.BOOLEAN -> JsonPrimitive(reader.nextBoolean())
      JsonToken.NULL -> { reader.nextNull(); JsonNull.INSTANCE }
      else -> throw IllegalArgumentException("invalid_json")
    }
  }
  val value = read(0)
  require(reader.peek() == JsonToken.END_DOCUMENT)
  return value
}

internal fun isCanonicalPositiveI64(raw: String): Boolean =
  raw.matches(Regex("[1-9][0-9]{0,18}")) && raw.toLongOrNull()?.let { it > 0 } == true

private class RawJsonNumber(private val raw: String) : Number() {
  override fun toByte() = raw.toByte(); override fun toDouble() = raw.toDouble()
  override fun toFloat() = raw.toFloat(); override fun toInt() = raw.toInt()
  override fun toLong() = raw.toLong(); override fun toShort() = raw.toShort()
  override fun toString() = raw
}
