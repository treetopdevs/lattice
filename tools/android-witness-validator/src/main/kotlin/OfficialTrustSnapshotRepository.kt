package com.android.keyattestation.verifier

import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.InputStream
import java.io.StringReader
import java.net.HttpURLConnection
import java.net.URI
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.security.cert.TrustAnchor
import java.time.Instant

private const val TRUST_MAGIC = "treehouse-official-trust-v1"
private const val STATUS_URL = "https://android.googleapis.com/attestation/status"
private const val MAX_STATUS_BYTES = 512 * 1024
private const val CONNECT_TIMEOUT_MILLIS = 5_000
private const val READ_TIMEOUT_MILLIS = 10_000
/** Availability choice only: refresh at least daily even if the server permits longer reuse. */
private const val MAX_CACHE_AGE_SECONDS = 86_400L

internal data class OfficialStatusResponse(
  val status: Int,
  val url: String,
  val body: ByteArray,
  val cacheControl: List<String>,
  val age: List<String>,
)
internal fun interface OfficialStatusFetcher { fun fetch(): OfficialStatusResponse }
internal enum class TrustPersistStage { TEMP_FORCED, RENAMED, DIRECTORY_FORCED, REOPENED }
internal fun interface TrustPersistCheckpoint { fun reached(stage: TrustPersistStage) }

/** Validator-owned, fail-closed source of pinned roots and frozen official revocation state. */
class OfficialTrustSnapshotRepository internal constructor(
  private val directory: Path,
  private val fetcher: OfficialStatusFetcher,
  private val now: () -> Instant,
  private val checkpoint: TrustPersistCheckpoint,
) {
  constructor(directory: Path): this(directory, OfficialStatusFetcher(::fetchOfficialStatus), { Instant.now() }, TrustPersistCheckpoint {})
  private val stateFile = directory.resolve("official-trust.bin")
  private val pendingFile = directory.resolve("official-trust.bin.pending")
  private val refusalFile = directory.resolve("official-trust.refused")
  private val lockFile = directory.resolve("official-trust.lock")

  fun loadOrRefresh(): TrustSnapshotAvailability {
    val observed = now()
    return try {
      locked {
        val cached = readCached()
        if (cached != null && observed < cached.lastObserved)
          return@locked TrustSnapshotAvailability.Unavailable(TrustBlocker.NOT_YET_VALID)
        if (cached != null && observed < cached.expiresAt) {
          val advanced = if (observed > cached.lastObserved) cached.copy(lastObserved = observed) else cached
          if (advanced !== cached) persist(advanced)
          return@locked available(advanced)
        }
        val response = try { fetcher.fetch() } catch (_: Exception) { null }
        if (response == null) return@locked unavailable(cached)
        val next = parseResponse(response, observed)
        persist(next)
        available(next)
      }
    } catch (_: Exception) {
      TrustSnapshotAvailability.Unavailable(TrustBlocker.UNAVAILABLE)
    }
  }

  private fun available(record: FrozenTrust): TrustSnapshotAvailability =
    TrustSnapshot.fromValidatorConfiguration(
      pinnedRoots(), parseRevoked(record.body), provenance(record), record.fetchedAt, record.expiresAt,
    )

  private fun unavailable(cached: FrozenTrust?) = TrustSnapshotAvailability.Unavailable(
    if (cached == null) TrustBlocker.UNAVAILABLE else TrustBlocker.EXPIRED,
  )

  private fun parseResponse(response: OfficialStatusResponse, fetchedAt: Instant): FrozenTrust {
    require(response.status == HttpURLConnection.HTTP_OK && response.url == STATUS_URL)
    require(response.body.isNotEmpty() && response.body.size <= MAX_STATUS_BYTES)
    require(response.cacheControl.size == 1 && response.age.size <= 1)
    val directives = response.cacheControl.single().split(',').map(String::trim)
    require(directives.none { it.equals("no-store", true) || it.equals("no-cache", true) })
    val ages = directives.filter { it.substringBefore('=').trim().equals("max-age", true) }
    require(ages.size == 1)
    val maxAge = canonicalNonnegative(ages.single().substringAfter('=', ""))
    val age = response.age.singleOrNull()?.let(::canonicalNonnegative) ?: 0L
    require(maxAge > age)
    parseRevoked(response.body)
    val lifetime = minOf(maxAge - age, MAX_CACHE_AGE_SECONDS)
    val expiresAt = fetchedAt.plusSeconds(lifetime)
    return FrozenTrust(
      fetchedAt, expiresAt, fetchedAt, response.cacheControl.single(), response.age.singleOrNull(),
      response.body.copyOf(), rootsDigest(), sha256(response.body),
    )
  }

  private fun locked(block: () -> TrustSnapshotAvailability): TrustSnapshotAvailability {
    Files.createDirectories(directory)
    return FileChannel.open(lockFile, StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { channel ->
      channel.lock().use {
        check(!Files.exists(pendingFile) && !Files.exists(refusalFile))
        block()
      }
    }
  }

  private fun persist(record: FrozenTrust) {
    val bytes = encode(record)
    Files.write(refusalFile, TRUST_MAGIC.toByteArray(), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
    FileChannel.open(refusalFile, StandardOpenOption.WRITE).use { it.force(true) }
    forceDirectory()
    try {
      FileChannel.open(pendingFile, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).use { channel ->
        val buffer = ByteBuffer.wrap(bytes)
        while (buffer.hasRemaining()) channel.write(buffer)
        channel.force(true)
      }
      checkpoint.reached(TrustPersistStage.TEMP_FORCED)
      Files.move(pendingFile, stateFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
      checkpoint.reached(TrustPersistStage.RENAMED)
      forceDirectory(); checkpoint.reached(TrustPersistStage.DIRECTORY_FORCED)
      check(readCached() == record); checkpoint.reached(TrustPersistStage.REOPENED)
      Files.delete(refusalFile); forceDirectory()
    } catch (error: Exception) {
      throw IllegalStateException("official_trust_persistence_refused", error)
    }
  }

  private fun forceDirectory() = FileChannel.open(directory, StandardOpenOption.READ).use { it.force(true) }
  private fun readCached(): FrozenTrust? = if (!Files.exists(stateFile)) null else decode(Files.readAllBytes(stateFile))
}

private data class FrozenTrust(
  val fetchedAt: Instant, val expiresAt: Instant, val lastObserved: Instant,
  val cacheControl: String, val age: String?, val body: ByteArray,
  val rootsDigest: ByteArray, val bodyDigest: ByteArray,
) {
  override fun equals(other: Any?) = other is FrozenTrust && fetchedAt.compareTo(other.fetchedAt) == 0 && expiresAt.compareTo(other.expiresAt) == 0 &&
    lastObserved.compareTo(other.lastObserved) == 0 && cacheControl == other.cacheControl && age == other.age && body.contentEquals(other.body) &&
    rootsDigest.contentEquals(other.rootsDigest) && bodyDigest.contentEquals(other.bodyDigest)
  override fun hashCode() = fetchedAt.hashCode()
}

private fun fetchOfficialStatus(): OfficialStatusResponse {
  val requested = URI.create(STATUS_URL).toURL()
  val connection = requested.openConnection() as HttpURLConnection
  connection.instanceFollowRedirects = false
  connection.connectTimeout = CONNECT_TIMEOUT_MILLIS
  connection.readTimeout = READ_TIMEOUT_MILLIS
  connection.requestMethod = "GET"
  return try {
    connection.connect()
    val body = if (connection.responseCode == HttpURLConnection.HTTP_OK)
      readBounded(connection.inputStream, MAX_STATUS_BYTES) else ByteArray(0)
    OfficialStatusResponse(
      connection.responseCode, connection.url.toString(), body,
      headerValues(connection, "Cache-Control"), headerValues(connection, "Age"),
    )
  } finally { connection.disconnect() }
}

private fun headerValues(connection: HttpURLConnection, name: String): List<String> =
  connection.headerFields.entries.filter { it.key?.equals(name, true) == true }.flatMap { it.value ?: emptyList() }

private fun readBounded(input: InputStream, maximum: Int): ByteArray = input.use {
  val output = ByteArrayOutputStream(); val buffer = ByteArray(8_192); var total = 0
  while (true) {
    val read = it.read(buffer); if (read < 0) break
    total += read; require(total <= maximum); output.write(buffer, 0, read)
  }
  output.toByteArray()
}

private fun canonicalNonnegative(raw: String): Long {
  require(raw.matches(Regex("(?:0|[1-9][0-9]{0,9})")))
  return raw.toLong()
}

private fun pinnedRoots(): Set<TrustAnchor> = GoogleTrustAnchors().map { anchor ->
  TrustAnchor(requireNotNull(anchor.trustedCert), anchor.nameConstraints?.copyOf())
}.toSet()

private fun rootsDigest(): ByteArray {
  val digest = MessageDigest.getInstance("SHA-256")
  digest.update("treehouse-pinned-google-attestation-roots-v1".toByteArray())
  pinnedRoots().map { requireNotNull(it.trustedCert).encoded }.sortedWith(::compareBytes).forEach {
    digest.update(ByteBuffer.allocate(8).putLong(it.size.toLong()).array()); digest.update(it)
  }
  return digest.digest()
}

private fun compareBytes(left: ByteArray, right: ByteArray): Int {
  for (index in 0 until minOf(left.size, right.size)) {
    val compared = (left[index].toInt() and 255).compareTo(right[index].toInt() and 255)
    if (compared != 0) return compared
  }
  return left.size.compareTo(right.size)
}

private fun parseRevoked(bytes: ByteArray): Set<String> {
  val text = bytes.toString(Charsets.UTF_8); require(text.toByteArray(Charsets.UTF_8).contentEquals(bytes))
  val reader = JsonReader(StringReader(text)).apply { strictness = Strictness.STRICT }
  lateinit var readValue: () -> com.google.gson.JsonElement
  fun readObject(): JsonObject {
    val objectValue = JsonObject(); reader.beginObject()
    while (reader.hasNext()) { val name = reader.nextName(); require(!objectValue.has(name)); objectValue.add(name, readValue()) }
    reader.endObject(); return objectValue
  }
  readValue = { when (reader.peek()) {
    JsonToken.BEGIN_OBJECT -> readObject()
    JsonToken.STRING -> JsonPrimitive(reader.nextString())
    else -> error("invalid status json")
  } }
  val root = readObject(); require(reader.peek() == JsonToken.END_DOCUMENT && root.keySet() == setOf("entries"))
  val entries = root.getAsJsonObject("entries"); val revoked = linkedSetOf<String>()
  for ((serial, raw) in entries.entrySet()) {
    require(serial.matches(Regex("(?:0|[1-9a-f][0-9a-f]*)")))
    val entry = raw.asJsonObject; require(entry.keySet() == setOf("status") || entry.keySet() == setOf("status", "reason"))
    val status = entry.get("status").asJsonPrimitive.also { require(it.isString) }.asString
    require(status == "REVOKED" || status == "OK")
    entry.get("reason")?.asJsonPrimitive?.also { require(it.isString && it.asString.length <= 256) }
    if (status == "REVOKED") revoked += serial
  }
  return revoked
}

private fun provenance(record: FrozenTrust): String = listOf(
  STATUS_URL, "rootsSha256=${record.rootsDigest.toHex()}", "bodySha256=${record.bodyDigest.toHex()}",
  "cacheControl=${record.cacheControl}", "age=${record.age ?: "0"}", "fetchedAt=${record.fetchedAt}", "expiresAt=${record.expiresAt}",
).joinToString(";")
private fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 255) }
private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)

private fun encode(record: FrozenTrust): ByteArray {
  val body = ByteArrayOutputStream(); DataOutputStream(body).use { out ->
    out.writeUTF(TRUST_MAGIC); out.writeUTF(record.fetchedAt.toString()); out.writeUTF(record.expiresAt.toString()); out.writeUTF(record.lastObserved.toString())
    out.writeUTF(record.cacheControl); out.writeBoolean(record.age != null); record.age?.let(out::writeUTF)
    out.writeInt(record.body.size); out.write(record.body); out.write(record.rootsDigest); out.write(record.bodyDigest)
  }
  val payload = body.toByteArray(); return payload + sha256(payload)
}

private fun decode(bytes: ByteArray): FrozenTrust {
  require(bytes.size in 33..(MAX_STATUS_BYTES + 4_096))
  val payload = bytes.copyOf(bytes.size - 32); require(sha256(payload).contentEquals(bytes.copyOfRange(bytes.size - 32, bytes.size)))
  DataInputStream(ByteArrayInputStream(payload)).use { input ->
    require(input.readUTF() == TRUST_MAGIC)
    val fetched = Instant.parse(input.readUTF()); val expires = Instant.parse(input.readUTF()); val observed = Instant.parse(input.readUTF())
    val cache = input.readUTF(); val age = if (input.readBoolean()) input.readUTF() else null
    val bodyLength = input.readInt().also { require(it in 1..MAX_STATUS_BYTES) }
    val body = input.readNBytes(bodyLength); require(body.size == bodyLength)
    val roots = input.readNBytes(32); val bodyDigest = input.readNBytes(32)
    require(roots.size == 32 && bodyDigest.size == 32 && input.available() == 0 && expires > fetched && observed >= fetched && roots.contentEquals(rootsDigest()) && bodyDigest.contentEquals(sha256(body)))
    parseRevoked(body)
    return FrozenTrust(fetched, expires, observed, cache, age, body, roots, bodyDigest)
  }
}
