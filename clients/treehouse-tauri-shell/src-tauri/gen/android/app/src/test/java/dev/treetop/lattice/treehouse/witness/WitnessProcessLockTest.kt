package dev.treetop.lattice.treehouse.witness

import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.nio.file.Files
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class WitnessProcessLockTest {
    @Test
    fun missingReadLockDoesNotCreateAnything() {
        val directory = Files.createTempDirectory("witness-lock-missing").toFile()
        try {
            val lockFile = File(directory, "identity.lock")
            val before = directory.list()!!.toList()

            assertRefused("lock_missing", WitnessProcessLock(lockFile).tryAcquire())

            assertEquals(before, directory.list()!!.toList())
            assertFalse(lockFile.exists())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun createDoesNotCreateAMissingParent() {
        val directory = Files.createTempDirectory("witness-lock-parent").toFile()
        try {
            val missingParent = File(directory, "not-created")
            val lockFile = File(missingParent, "identity.lock")

            assertRefused("lock_parent_missing", WitnessProcessLock(lockFile).tryAcquire(create = true))

            assertFalse(missingParent.exists())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun sameProcessOverlapIsBusyAndCloseRetainsFileForReacquisition() {
        val directory = Files.createTempDirectory("witness-lock-local").toFile()
        try {
            val lockFile = File(directory, "identity.lock")
            val first = assertAcquired(WitnessProcessLock(lockFile).tryAcquire(create = true))
            val normalizedAlias = File(File(directory, "unused"), "../identity.lock")

            assertEquals(
                WitnessProcessLock.Acquisition.Busy,
                WitnessProcessLock(normalizedAlias).tryAcquire(),
            )
            assertTrue(lockFile.isFile)

            first.close()
            first.close()
            assertTrue(lockFile.isFile)
            assertAcquired(WitnessProcessLock(lockFile).tryAcquire()).close()
            assertTrue(lockFile.isFile)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun symlinkAndNonRegularExistingPathsRefuseWithoutReplacement() {
        val directory = Files.createTempDirectory("witness-lock-shape").toFile()
        try {
            val target = File(directory, "target").apply { writeText("retained") }
            val symlink = File(directory, "identity.lock")
            Files.createSymbolicLink(symlink.toPath(), target.toPath())

            assertRefused("lock_symlink", WitnessProcessLock(symlink).tryAcquire(create = true))
            assertTrue(Files.isSymbolicLink(symlink.toPath()))
            assertEquals("retained", target.readText())

            Files.delete(symlink.toPath())
            assertTrue(symlink.mkdir())
            assertRefused("lock_not_regular", WitnessProcessLock(symlink).tryAcquire(create = true))
            assertTrue(symlink.isDirectory)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun distinctJvmsObserveBusyThenReleaseAndReacquire() {
        val directory = Files.createTempDirectory("witness-lock-process").toFile()
        var holder: Child? = null
        try {
            val lockFile = File(directory, "identity.lock")
            holder = startChild("hold", lockFile)
            assertEquals("ACQUIRED", holder.readLine())

            val contender = startChild("probe", lockFile)
            assertEquals("BUSY", contender.readLine())
            assertExit(contender, 0)

            holder.writeLine("RELEASE")
            assertEquals("RELEASED", holder.readLine())
            assertExit(holder, 0)
            holder = null

            val successor = startChild("probe", lockFile)
            assertEquals("ACQUIRED", successor.readLine())
            assertExit(successor, 0)
            assertTrue(lockFile.isFile)
        } finally {
            holder?.destroy()
            directory.deleteRecursively()
        }
    }

    @Test
    fun operatingSystemReleasesLockWhenOwnerProcessTerminates() {
        val directory = Files.createTempDirectory("witness-lock-process-death").toFile()
        var holder: Child? = null
        try {
            val lockFile = File(directory, "identity.lock")
            holder = startChild("hold", lockFile)
            assertEquals("ACQUIRED", holder.readLine())

            holder.destroyForcibly()
            holder = null

            val successor = startChild("probe", lockFile)
            assertEquals("ACQUIRED", successor.readLine())
            assertExit(successor, 0)
            assertTrue(lockFile.isFile)
        } finally {
            holder?.destroy()
            directory.deleteRecursively()
        }
    }

    private fun assertAcquired(result: WitnessProcessLock.Acquisition): WitnessProcessLock.Lease =
        when (result) {
            is WitnessProcessLock.Acquisition.Acquired -> result.lease
            else -> throw AssertionError("expected acquired, got $result")
        }

    private fun assertRefused(reason: String, result: WitnessProcessLock.Acquisition) {
        when (result) {
            is WitnessProcessLock.Acquisition.Refused -> assertEquals(reason, result.reason)
            else -> fail("expected refusal $reason, got $result")
        }
    }

    private fun startChild(mode: String, lockFile: File): Child {
        val java = File(System.getProperty("java.home"), "bin/java")
        val process = ProcessBuilder(
            java.absolutePath,
            "-cp",
            System.getProperty("java.class.path"),
            WitnessProcessLockSubprocess::class.java.name,
            mode,
            lockFile.absolutePath,
        ).redirectErrorStream(true).start()
        return Child(process)
    }

    private class Child(private val process: Process) {
        private val output = BufferedReader(InputStreamReader(process.inputStream))

        fun readLine(): String {
            val executor = Executors.newSingleThreadExecutor { task ->
                Thread(task, "witness-lock-subprocess-output").apply { isDaemon = true }
            }
            return try {
                executor.submit<String?> { output.readLine() }.get(10, TimeUnit.SECONDS)
                    ?: throw AssertionError(
                        "child exited without protocol output; exit=${process.exitValue()}",
                    )
            } finally {
                executor.shutdownNow()
            }
        }

        fun writeLine(line: String) {
            process.outputStream.bufferedWriter().apply {
                write(line)
                newLine()
                flush()
            }
        }

        fun destroyForcibly() {
            process.destroyForcibly()
            assertTrue(process.waitFor(10, TimeUnit.SECONDS))
        }

        fun destroy() {
            if (process.isAlive) destroyForcibly()
        }

        fun awaitExit(): Int {
            assertTrue("child did not exit", process.waitFor(10, TimeUnit.SECONDS))
            return process.exitValue()
        }
    }

    private fun assertExit(child: Child, expected: Int) {
        assertEquals(expected, child.awaitExit())
    }
}
