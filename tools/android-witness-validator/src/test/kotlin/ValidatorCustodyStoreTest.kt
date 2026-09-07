package com.android.keyattestation.verifier

import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ValidatorCustodyStoreTest {
  @Test fun issuanceAssociationAndNonceSpendSurviveReopen() {
    val directory = Files.createTempDirectory("validator-custody")
    val next = AtomicInteger(1)
    fun store() = ValidatorCustodyStore(directory, { bytes(next.getAndIncrement()) }, PersistCheckpoint {})
    val expected = expected()
    val issued = store().issueGeneration(expected)
    assertContentEquals(bytes(1), issued.issuanceId)
    assertContentEquals(bytes(2), issued.generationChallenge)
    val fixture = TreehouseOfflineGenerationVerifierTest().fixture()
    assertTrue(store().verifyAndAssociateGeneration(issued.issuanceId, fixture.request.candidate.chain, fixture.request.trust, fixture.request.validationTime))
    assertTrue(store().verifyAndAssociateGeneration(issued.issuanceId, fixture.request.candidate.chain, fixture.request.trust, fixture.request.validationTime))

    val possession = store().issuePossession(issued.issuanceId, expected)
    assertContentEquals(bytes(3), possession.validatorNonce)
    var calls = 0
    assertFalse(store().consumePossession(possession) { retained, associated, challenge ->
      calls++
      assertEquals("replica:test", retained.replica)
      assertContentEquals(fixture.publicKey, associated.publicKey)
      assertContentEquals(bytes(2), challenge)
      false
    })
    assertEquals(1, calls)
    assertFalse(store().consumePossession(possession) { _, _, _ -> calls++; true })
    assertEquals(1, calls, "a refused verification still spends the nonce before parsing/signing")
  }

  @Test fun eachSuccessfulMutationForcesFileRenameDirectoryAndStrictReopen() {
    val stages = mutableListOf<PersistStage>()
    val store = ValidatorCustodyStore(Files.createTempDirectory("validator-force"), { bytes(stages.size + 1) }, PersistCheckpoint(stages::add))
    store.issueGeneration(expected())
    assertEquals(listOf(PersistStage.TEMP_FORCED, PersistStage.RENAMED, PersistStage.DIRECTORY_FORCED, PersistStage.REOPENED), stages)
  }

  @Test fun ambiguityAndEveryInjectedPersistenceFailureRefuseWithoutSilentRepair() {
    for (failure in PersistStage.entries) {
      val directory = Files.createTempDirectory("validator-failure")
      val store = ValidatorCustodyStore(directory, { bytes(1) }, PersistCheckpoint { if (it == failure) error("injected") })
      assertFails { store.issueGeneration(expected()) }
      assertFails { ValidatorCustodyStore(directory).issueGeneration(expected()) }
    }
    val ambiguous = Files.createTempDirectory("validator-pending")
    Files.write(ambiguous.resolve("custody.bin.pending"), byteArrayOf(1))
    assertFails { ValidatorCustodyStore(ambiguous).issueGeneration(expected()) }
  }

  @Test fun returnedAndInputArraysCannotMutateDurableAuthority() {
    val directory = Files.createTempDirectory("validator-owned")
    val enrollment = bytes(4); val expected = expected(enrollment)
    var n = 10
    val store = ValidatorCustodyStore(directory, { bytes(n++) }, PersistCheckpoint {})
    val issued = store.issueGeneration(expected)
    enrollment.fill(99); issued.issuanceId.fill(99); issued.generationChallenge.fill(99)
    val originalId = bytes(10); val fixture = TreehouseOfflineGenerationVerifierTest().fixture()
    // This issuance intentionally differs from the fixture and must not accept a caller-labelled candidate.
    assertFalse(store.verifyAndAssociateGeneration(originalId, fixture.request.candidate.chain, fixture.request.trust, fixture.request.validationTime))
  }

  @Test fun separateHostProcessOwnsTheAuthoritativeMutationLock() {
    val directory = Files.createTempDirectory("validator-process-lock")
    val java = Path.of(System.getProperty("java.home"), "bin", "java").toString()
    val process = ProcessBuilder(java, "-cp", System.getProperty("java.class.path"),
      "com.android.keyattestation.verifier.ValidatorLockProcess", directory.toString()).redirectErrorStream(true).start()
    val held = directory.resolve("held"); val release = directory.resolve("release")
    repeat(200) { if (Files.exists(held)) return@repeat; Thread.sleep(5) }
    if (!Files.exists(held)) {
      process.destroyForcibly()
      error("lock helper failed before acquiring the lock")
    }
    val executor = Executors.newSingleThreadExecutor()
    val mutation = executor.submit<GenerationTicket> { ValidatorCustodyStore(directory).issueGeneration(expected()) }
    assertFails { mutation.get(100, TimeUnit.MILLISECONDS) }
    Files.write(release, byteArrayOf(1))
    assertEquals(0, process.waitFor())
    assertEquals(32, mutation.get(5, TimeUnit.SECONDS).issuanceId.size)
    executor.shutdownNow()
  }

  private fun expected(enrollment: ByteArray = bytes(4)) = ExpectedEnrollment(
    "replica:test", enrollment, bytes(5), bytes(3), bytes(7), 42,
  )
  private fun bytes(value: Int) = ByteArray(32) { value.toByte() }
}

object ValidatorLockProcess {
  @JvmStatic fun main(args: Array<String>) {
    val directory = Path.of(args.single()); Files.createDirectories(directory)
    FileChannel.open(directory.resolve("custody.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { channel ->
      channel.lock().use {
        Files.write(directory.resolve("held"), byteArrayOf(1))
        while (!Files.exists(directory.resolve("release"))) Thread.sleep(5)
      }
    }
  }
}
