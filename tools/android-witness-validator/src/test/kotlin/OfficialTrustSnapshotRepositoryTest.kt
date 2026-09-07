package com.android.keyattestation.verifier

import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class OfficialTrustSnapshotRepositoryTest {
  @Test fun fixedOfficialResponseFreezesReopensAndFallsBackOnlyWhileFresh() {
    val directory = Files.createTempDirectory("official-trust")
    var now = Instant.parse("2026-09-07T12:00:00Z"); val fetches = AtomicInteger()
    var available = true
    val fetcher = OfficialStatusFetcher {
      fetches.incrementAndGet(); if (!available) error("offline")
      response("public, max-age=86400", "3600", status("a1", "REVOKED"))
    }
    fun repository() = OfficialTrustSnapshotRepository(directory, fetcher, { now }, TrustPersistCheckpoint {})
    val first = assertIs<TrustSnapshotAvailability.Available>(repository().loadOrRefresh()).snapshot
    assertEquals(1, fetches.get()); assertEquals(setOf("a1"), first.revokedSerials)
    val digest = first.digest
    available = false; now = now.plusSeconds(60)
    val reopened = assertIs<TrustSnapshotAvailability.Available>(repository().loadOrRefresh()).snapshot
    assertContentEquals(digest, reopened.digest); assertEquals(1, fetches.get())
    now = Instant.parse("2026-09-08T11:00:01Z")
    assertEquals(TrustBlocker.EXPIRED, assertIs<TrustSnapshotAvailability.Unavailable>(repository().loadOrRefresh()).blocker)
  }

  @Test fun directivesStatusShapeRedirectAndBoundsRefuseWithoutReplacingFreshFacts() {
    val bad = listOf(
      response("public", null, status("a1", "REVOKED")),
      response("no-store, max-age=10", null, status("a1", "REVOKED")),
      response("no-cache, max-age=10", null, status("a1", "REVOKED")),
      response("max-age=10, max-age=11", null, status("a1", "REVOKED")),
      response("max-age=10", "10", status("a1", "REVOKED")),
      response("max-age=10", null, "{\"entries\":{\"a1\":{\"status\":\"UNKNOWN\"}}}".toByteArray()),
      response("max-age=10", null, "{\"entries\":{\"01\":{\"status\":\"REVOKED\"}}}".toByteArray()),
      response("max-age=10", null, "{\"entries\":{},\"entries\":{}}".toByteArray()),
      response("max-age=10", null, ByteArray(512 * 1024 + 1)),
      response("max-age=10", null, status("a1", "REVOKED"), url = "https://example.invalid/status"),
    )
    for (candidate in bad) {
      val directory = Files.createTempDirectory("official-trust-refusal")
      val result = OfficialTrustSnapshotRepository(directory, OfficialStatusFetcher { candidate },
        { Instant.parse("2026-09-07T12:00:00Z") }, TrustPersistCheckpoint {}).loadOrRefresh()
      assertEquals(TrustBlocker.UNAVAILABLE, assertIs<TrustSnapshotAvailability.Unavailable>(result).blocker)
      assertTrue(!Files.exists(directory.resolve("official-trust.bin")))
    }
  }

  @Test fun backwardClockAndExpiredOfflineCacheAreIncomplete() {
    val directory = Files.createTempDirectory("official-trust-clock")
    var now = Instant.parse("2026-09-07T12:00:00Z")
    val repository = OfficialTrustSnapshotRepository(directory, OfficialStatusFetcher { response("max-age=30", null, status("a1", "REVOKED")) }, { now }, TrustPersistCheckpoint {})
    assertIs<TrustSnapshotAvailability.Available>(repository.loadOrRefresh())
    now = now.plusSeconds(5); assertIs<TrustSnapshotAvailability.Available>(repository.loadOrRefresh())
    now = now.minusSeconds(10)
    assertEquals(TrustBlocker.NOT_YET_VALID, assertIs<TrustSnapshotAvailability.Unavailable>(repository.loadOrRefresh()).blocker)
  }

  @Test fun eachDurableBoundaryFailureLatchesRefusal() {
    for (failure in TrustPersistStage.entries) {
      val directory = Files.createTempDirectory("official-trust-crash")
      val repository = OfficialTrustSnapshotRepository(directory, OfficialStatusFetcher { response("max-age=30", null, status("a1", "REVOKED")) },
        { Instant.parse("2026-09-07T12:00:00Z") }, TrustPersistCheckpoint { if (it == failure) error("crash") })
      assertIs<TrustSnapshotAvailability.Unavailable>(repository.loadOrRefresh())
      assertIs<TrustSnapshotAvailability.Unavailable>(OfficialTrustSnapshotRepository(directory).loadOrRefresh())
    }
  }

  @Test fun separateProcessLockSerializesRepositoryMutation() {
    val directory = Files.createTempDirectory("official-trust-lock")
    val java = Path.of(System.getProperty("java.home"), "bin", "java").toString()
    val process = ProcessBuilder(java, "-cp", System.getProperty("java.class.path"),
      "com.android.keyattestation.verifier.OfficialTrustLockProcess", directory.toString()).redirectErrorStream(true).start()
    val held = directory.resolve("held"); val release = directory.resolve("release")
    repeat(200) { if (!Files.exists(held)) Thread.sleep(5) }
    if (!Files.exists(held)) { process.destroyForcibly(); error("lock helper failed") }
    val executor = Executors.newSingleThreadExecutor()
    val mutation = executor.submit<TrustSnapshotAvailability> {
      OfficialTrustSnapshotRepository(directory, OfficialStatusFetcher { response("max-age=30", null, status("a1", "REVOKED")) },
        { Instant.parse("2026-09-07T12:00:00Z") }, TrustPersistCheckpoint {}).loadOrRefresh()
    }
    try { mutation.get(100, TimeUnit.MILLISECONDS); error("mutation bypassed process lock") }
    catch (_: java.util.concurrent.TimeoutException) { /* expected */ }
    Files.write(release, byteArrayOf(1)); assertEquals(0, process.waitFor())
    assertIs<TrustSnapshotAvailability.Available>(mutation.get(5, TimeUnit.SECONDS))
    executor.shutdownNow()
  }

  @Test fun operationalCapShortensServerFreshnessAndProvenanceChangesWithExactBody() {
    val now = Instant.parse("2026-09-07T12:00:00Z")
    fun loaded(body: ByteArray) = assertIs<TrustSnapshotAvailability.Available>(
      OfficialTrustSnapshotRepository(Files.createTempDirectory("official-trust-cap"),
        OfficialStatusFetcher { response("public, max-age=999999", "1", body) }, { now }, TrustPersistCheckpoint {}).loadOrRefresh()).snapshot
    val first = loaded(status("a1", "REVOKED")); val second = loaded(status("a2", "REVOKED"))
    assertTrue(!first.digest.contentEquals(second.digest))
    assertEquals(now.plusSeconds(86_400), first.expiresAt)
  }

  private fun response(cache: String, age: String?, body: ByteArray, url: String = "https://android.googleapis.com/attestation/status") =
    OfficialStatusResponse(200, url, body, listOf(cache), age?.let(::listOf) ?: emptyList())
  private fun status(serial: String, value: String) = "{\"entries\":{\"$serial\":{\"status\":\"$value\",\"reason\":\"KEY_COMPROMISE\"}}}".toByteArray()
}

object OfficialTrustLockProcess {
  @JvmStatic fun main(args: Array<String>) {
    val directory = Path.of(args.single()); Files.createDirectories(directory)
    java.nio.channels.FileChannel.open(directory.resolve("official-trust.lock"),
      java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.WRITE).use { channel ->
      channel.lock().use {
        Files.write(directory.resolve("held"), byteArrayOf(1))
        while (!Files.exists(directory.resolve("release"))) Thread.sleep(5)
      }
    }
  }
}
