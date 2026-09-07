package com.android.keyattestation.verifier

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.time.Instant

private const val STORE_MAGIC = "treehouse-validator-custody-v1"
private const val MAX_NONCES = 4_096
private const val MAX_ISSUANCES = 4_096

class ExpectedEnrollment(
  val replica: String,
  enrollmentId: ByteArray,
  recipient: ByteArray,
  creationAttemptId: ByteArray,
  signerCertificateSha256: ByteArray,
  val creationVersionCode: Long,
) {
  private val enrollment = enrollmentId.copyOf(); private val recipientKey = recipient.copyOf()
  private val attempt = creationAttemptId.copyOf(); private val signer = signerCertificateSha256.copyOf()
  val enrollmentId get() = enrollment.copyOf(); val recipient get() = recipientKey.copyOf()
  val creationAttemptId get() = attempt.copyOf(); val signerCertificateSha256 get() = signer.copyOf()
  init {
    require(replica.toByteArray(Charsets.UTF_8).let { it.isNotEmpty() && it.size <= 512 && it.toString(Charsets.UTF_8) == replica })
    require(listOf(enrollmentId, recipient, creationAttemptId, signerCertificateSha256).all { it.size == 32 })
    require(creationVersionCode > 0)
  }
  internal fun owned() = ExpectedEnrollment(replica, enrollment, recipientKey, attempt, signer, creationVersionCode)
}

class GenerationTicket internal constructor(issuanceId: ByteArray, generationChallenge: ByteArray) {
  private val id = issuanceId.copyOf(); private val challenge = generationChallenge.copyOf()
  val issuanceId get() = id.copyOf(); val generationChallenge get() = challenge.copyOf()
}
class PossessionTicket internal constructor(issuanceId: ByteArray, validatorNonce: ByteArray) {
  internal val id = issuanceId.copyOf(); internal val nonce = validatorNonce.copyOf()
  val issuanceId get() = id.copyOf(); val validatorNonce get() = nonce.copyOf()
}
class AssociatedCandidate internal constructor(publicKey: ByteArray, spki: ByteArray, chain: List<ByteArray>) {
  internal val keyBytes = publicKey.copyOf(); internal val spkiBytes = spki.copyOf(); internal val chainBytes = chain.map(ByteArray::copyOf)
  val publicKey get() = keyBytes.copyOf(); val spki get() = spkiBytes.copyOf(); val chain get() = chainBytes.map(ByteArray::copyOf)
}
internal class RetainedIssuance(expected: ExpectedEnrollment, challenge: ByteArray) {
  val expected = expected.owned()
  private val challengeBytes = challenge.copyOf()
  val generationChallenge get() = challengeBytes.copyOf()
}
internal class UnknownIssuanceException : RuntimeException("unknown_issuance")

internal enum class PersistStage { TEMP_FORCED, RENAMED, DIRECTORY_FORCED, REOPENED }
internal fun interface PersistCheckpoint { fun reached(stage: PersistStage) }

/** Validator-owned authority for issuance and one-spend nonce state. Phone JSON never constructs it. */
class ValidatorCustodyStore internal constructor(
  private val directory: Path,
  private val random32: () -> ByteArray,
  private val checkpoint: PersistCheckpoint,
) {
  constructor(directory: Path): this(directory, { ByteArray(32).also(SecureRandom()::nextBytes) }, PersistCheckpoint {})
  private val stateFile = directory.resolve("custody.bin")
  private val tempFile = directory.resolve("custody.bin.pending")
  private val refusalFile = directory.resolve("custody.refused")
  private val lockFile = directory.resolve("custody.lock")

  fun issueGeneration(expected: ExpectedEnrollment): GenerationTicket = locked { state ->
    require(state.issuances.size < MAX_ISSUANCES) { "issuance_capacity" }
    val id = fresh(state)
    val challenge = random32().also { require(it.size == 32) }
    state.issuances[id.key()] = Issuance(id, challenge.copyOf(), expected.owned())
    persist(state)
    GenerationTicket(id.copyOf(), challenge.copyOf())
  }

  fun verifyAndAssociateGeneration(issuanceId: ByteArray, candidateChain: List<ByteArray>,
    trust: TrustSnapshotAvailability, validationTime: Instant): Boolean = locked { state ->
    require(issuanceId.size == 32)
    val issuance = state.issuances[issuanceId.key()] ?: return@locked false
    val ownedChain = candidateChain.map(ByteArray::copyOf)
    require(ownedChain.size in 1..8 && ownedChain.all { it.size in 1..16_384 } && ownedChain.sumOf(ByteArray::size) <= 65_536)
    val leaf = parseCertificate(ownedChain.first())
    val spki = leaf.publicKey.encoded
    require(spki.size == 44 && spki.copyOfRange(0, 12).contentEquals(ED25519_SPKI_PREFIX))
    val publicKey = spki.copyOfRange(12, 44)
    val request = OfflineGenerationRequest(
      GenerationIssuance(issuance.id, issuance.challenge, issuance.expected.creationAttemptId,
        issuance.expected.replica, issuance.expected.enrollmentId, issuance.expected.recipient,
        publicKey, issuance.expected.signerCertificateSha256, issuance.expected.creationVersionCode),
      GenerationCandidate(ownedChain), trust, validationTime)
    val verified = TreehouseOfflineGenerationVerifier.verifyCandidateForAssociation(request) ?: return@locked false
    require(verified.issuanceId.contentEquals(issuance.id) && verified.publicKey.contentEquals(publicKey) && verified.chain.sameBytes(ownedChain))
    val owned = Candidate(publicKey, spki, ownedChain)
    require(owned.publicKey.size == 32 && owned.spki.size == 44 && owned.chain.size in 1..8)
    require(owned.chain.all { it.size in 1..16_384 } && owned.chain.sumOf(ByteArray::size) <= 65_536)
    val prior = issuance.candidate
    if (prior != null) return@locked prior == owned
    issuance.candidate = owned
    persist(state)
    true
  }

  fun issuePossession(issuanceId: ByteArray, expected: ExpectedEnrollment): PossessionTicket = locked { state ->
    require(issuanceId.size == 32)
    val issuance = state.issuances[issuanceId.key()] ?: throw UnknownIssuanceException()
    require(issuance.candidate != null && issuance.expected.same(expected))
    require(state.nonces.size < MAX_NONCES) { "nonce_capacity" }
    val nonce = freshNonce(state)
    state.nonces[nonce.key()] = Nonce(issuanceId.copyOf(), nonce.copyOf(), false)
    persist(state)
    PossessionTicket(issuanceId.copyOf(), nonce.copyOf())
  }

  internal fun retainedIssuance(issuanceId: ByteArray): RetainedIssuance? = locked { state ->
    require(issuanceId.size == 32)
    state.issuances[issuanceId.key()]?.let { RetainedIssuance(it.expected, it.challenge) }
  }

  internal fun abandonPossession(ticket: PossessionTicket): Boolean = locked { state ->
    require(ticket.id.size == 32 && ticket.nonce.size == 32)
    val nonce = state.nonces[ticket.nonce.key()] ?: return@locked false
    if (nonce.spent || !nonce.issuanceId.contentEquals(ticket.id)) return@locked false
    nonce.spent = true
    persist(state)
    true
  }

  /** Spend is durable before any caller-supplied packet parser or signature verifier runs. */
  fun consumePossession(ticket: PossessionTicket, verifier: (ExpectedEnrollment, AssociatedCandidate, ByteArray) -> Boolean): Boolean = locked { state ->
    require(ticket.id.size == 32 && ticket.nonce.size == 32)
    val nonce = state.nonces[ticket.nonce.key()] ?: return@locked false
    if (nonce.spent || !nonce.issuanceId.contentEquals(ticket.id)) return@locked false
    nonce.spent = true
    persist(state)
    val issuance = state.issuances[ticket.id.key()] ?: return@locked false
    val candidate = issuance.candidate ?: return@locked false
    verifier(issuance.expected.owned(), AssociatedCandidate(candidate.publicKey.copyOf(), candidate.spki.copyOf(), candidate.chain.map(ByteArray::copyOf)), issuance.challenge.copyOf())
  }

  private fun <T> locked(block: (State) -> T): T {
    Files.createDirectories(directory)
    FileChannel.open(lockFile, StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { channel ->
      channel.lock().use {
        check(!Files.exists(tempFile) && !Files.exists(refusalFile)) { "ambiguous_or_refused_store" }
        val state = try { read() } catch (error: Exception) {
          throw IllegalStateException("custody_store_unavailable", error)
        }
        return block(state)
      }
    }
  }

  private fun persist(state: State) {
    val bytes = encode(state)
    check(!Files.exists(tempFile)) { "ambiguous_pending_store" }
    try {
      Files.write(refusalFile, STORE_MAGIC.toByteArray(Charsets.US_ASCII), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
      FileChannel.open(refusalFile, StandardOpenOption.WRITE).use { it.force(true) }
      forceDirectory()
      FileChannel.open(tempFile, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).use { file ->
        file.write(java.nio.ByteBuffer.wrap(bytes)); file.force(true); checkpoint.reached(PersistStage.TEMP_FORCED)
      }
      Files.move(tempFile, stateFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
      checkpoint.reached(PersistStage.RENAMED)
      forceDirectory()
      checkpoint.reached(PersistStage.DIRECTORY_FORCED)
      check(encode(read()).contentEquals(bytes)) { "store_reopen_mismatch" }
      checkpoint.reached(PersistStage.REOPENED)
      Files.delete(refusalFile); forceDirectory()
    } catch (error: Exception) {
      throw IllegalStateException("custody_persistence_refused", error)
    }
  }

  private fun forceDirectory() = FileChannel.open(directory, StandardOpenOption.READ).use { it.force(true) }

  private fun read(): State = if (!Files.exists(stateFile)) State() else decode(Files.readAllBytes(stateFile))
  private fun fresh(state: State): ByteArray = random32().also { require(it.size == 32 && !state.issuances.containsKey(it.key())) }
  private fun freshNonce(state: State): ByteArray = random32().also { require(it.size == 32 && !state.nonces.containsKey(it.key())) }
}

private val ED25519_SPKI_PREFIX = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
private fun parseCertificate(bytes: ByteArray): X509Certificate {
  val input = ByteArrayInputStream(bytes)
  val value = CertificateFactory.getInstance("X.509").generateCertificate(input) as X509Certificate
  require(input.available() == 0)
  return value
}
private fun List<ByteArray>.sameBytes(other: List<ByteArray>) = size == other.size && indices.all { this[it].contentEquals(other[it]) }

private class State(val issuances: LinkedHashMap<String, Issuance> = linkedMapOf(), val nonces: LinkedHashMap<String, Nonce> = linkedMapOf())
private class Issuance(val id: ByteArray, val challenge: ByteArray, val expected: ExpectedEnrollment, var candidate: Candidate? = null)
private data class Candidate(val publicKey: ByteArray, val spki: ByteArray, val chain: List<ByteArray>) {
  override fun equals(other: Any?) = other is Candidate && publicKey.contentEquals(other.publicKey) && spki.contentEquals(other.spki) && chain.size == other.chain.size && chain.indices.all { chain[it].contentEquals(other.chain[it]) }
  override fun hashCode() = publicKey.contentHashCode()
}
private class Nonce(val issuanceId: ByteArray, val nonce: ByteArray, var spent: Boolean)
private fun ExpectedEnrollment.same(other: ExpectedEnrollment) = replica == other.replica && enrollmentId.contentEquals(other.enrollmentId) && recipient.contentEquals(other.recipient) && creationAttemptId.contentEquals(other.creationAttemptId) && signerCertificateSha256.contentEquals(other.signerCertificateSha256) && creationVersionCode == other.creationVersionCode
private fun ByteArray.key() = joinToString("") { "%02x".format(it.toInt() and 255) }

private fun encode(state: State): ByteArray {
  val body = ByteArrayOutputStream()
  DataOutputStream(body).use { out ->
    out.writeUTF(STORE_MAGIC); out.writeInt(state.issuances.size)
    state.issuances.values.forEach { value ->
      out.write(value.id); out.write(value.challenge); out.writeUTF(value.expected.replica)
      out.write(value.expected.enrollmentId); out.write(value.expected.recipient); out.write(value.expected.creationAttemptId)
      out.write(value.expected.signerCertificateSha256); out.writeLong(value.expected.creationVersionCode)
      out.writeBoolean(value.candidate != null); value.candidate?.let { candidate ->
        out.write(candidate.publicKey); out.writeInt(candidate.spki.size); out.write(candidate.spki)
        out.writeInt(candidate.chain.size); candidate.chain.forEach { out.writeInt(it.size); out.write(it) }
      }
    }
    out.writeInt(state.nonces.size); state.nonces.values.forEach { out.write(it.issuanceId); out.write(it.nonce); out.writeBoolean(it.spent) }
  }
  val payload = body.toByteArray(); val digest = MessageDigest.getInstance("SHA-256").digest(payload)
  return payload + digest
}

private fun decode(bytes: ByteArray): State {
  require(bytes.size >= 32)
  val payload = bytes.copyOf(bytes.size - 32); require(MessageDigest.getInstance("SHA-256").digest(payload).contentEquals(bytes.copyOfRange(bytes.size - 32, bytes.size)))
  val state = State(); DataInputStream(ByteArrayInputStream(payload)).use { input ->
    require(input.readUTF() == STORE_MAGIC)
    repeat(input.readInt().also { require(it in 0..MAX_ISSUANCES) }) {
      val id = input.readNBytes(32); val challenge = input.readNBytes(32); val replica = input.readUTF()
      require(id.size == 32 && challenge.size == 32)
      val expected = ExpectedEnrollment(replica, input.readNBytes(32), input.readNBytes(32), input.readNBytes(32), input.readNBytes(32), input.readLong())
      val issuance = Issuance(id, challenge, expected)
      if (input.readBoolean()) {
        val key = input.readNBytes(32); val spki = input.readNBytes(input.readInt().also { require(it == 44) })
        val chain = List(input.readInt().also { require(it in 1..8) }) { input.readNBytes(input.readInt().also { require(it in 1..16_384) }) }
        require(chain.sumOf(ByteArray::size) <= 65_536); issuance.candidate = Candidate(key, spki, chain)
      }
      require(state.issuances.put(id.key(), issuance) == null)
    }
    repeat(input.readInt().also { require(it in 0..MAX_NONCES) }) {
      val issuance = input.readNBytes(32); val nonce = input.readNBytes(32); require(state.nonces.put(nonce.key(), Nonce(issuance, nonce, input.readBoolean())) == null)
    }
    require(input.available() == 0)
  }; return state
}
