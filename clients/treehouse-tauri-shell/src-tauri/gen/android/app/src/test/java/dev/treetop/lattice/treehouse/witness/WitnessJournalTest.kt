package dev.treetop.lattice.treehouse.witness

import android.content.Context
import android.content.ContextWrapper
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import android.system.Os
import android.system.OsConstants
import android.system.ErrnoException
import java.io.File
import org.junit.Assert.*
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [WitnessDirectoryOsShadow::class])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class WitnessJournalTest {
    @get:Rule val temporary = TemporaryFolder()
    @After fun resetDirectoryAdapter() { WitnessDirectoryOsShadow.reset() }

    @Test fun retainedAttemptReadPinsExistingJournalWithoutMutationUntilClose() {
        val context = journalContext()
        val signer = ByteArray(32) { 7 }
        WitnessJournal(context, signer).use { stored(it.prepareAccepted(enrollment(), ByteArray(32) { 3 })) }
        val before = database(context).readBytes()
        WitnessJournal(context, signer).use { owner ->
            assertEquals(1L, stored(owner.retainExistingForAttempt(1, ByteArray(32) { 3 })).identity.revision)
            WitnessJournal(context, signer).use { competitor ->
                assertEquals(WitnessResult.Refused("storage_busy"), competitor.observeExisting())
            }
            assertArrayEquals(before, database(context).readBytes())
        }
        WitnessJournal(context, signer).use { assertEquals(1L, stored(it.observeExisting()).identity.revision) }
        assertArrayEquals(before, database(context).readBytes())
    }

    @Test fun retainedAttemptReadRefusesStaleOrSubstitutedAttemptWithoutCreatingStorage() {
        val context = journalContext()
        val signer = ByteArray(32) { 7 }
        WitnessJournal(context, signer).use { journal ->
            assertSame(WitnessResult.Missing, journal.retainExistingForAttempt(1, ByteArray(32) { 3 }))
        }
        assertFalse(database(context).exists())
        WitnessJournal(context, signer).use { stored(it.prepareAccepted(enrollment(), ByteArray(32) { 3 })) }
        val before = database(context).readBytes()
        WitnessJournal(context, signer).use { journal ->
            assertEquals(WitnessResult.Refused("stale_revision"), journal.retainExistingForAttempt(2, ByteArray(32) { 3 }))
            assertEquals(WitnessResult.Refused("creation_attempt_mismatch"), journal.retainExistingForAttempt(1, ByteArray(32) { 4 }))
            WitnessJournal(context, signer).use { competitor ->
                assertEquals(1L, stored(competitor.observeExisting()).identity.revision)
            }
            journal.close()
            assertEquals(WitnessResult.Refused("journal_closed"), journal.retainExistingForAttempt(1, ByteArray(32) { 3 }))
        }
        assertArrayEquals(before, database(context).readBytes())
    }

    @Test fun observationCreatesNothingAndAcceptedPreparationReopensExactly() {
        val context = journalContext()
        val signer = ByteArray(32) { 7 }
        val enrollment = WitnessEnrollment(ByteArray(32) { 1 }, "replica:synthetic", ByteArray(32) { 2 }, ByteArray(32) { 3 })
        val before = context.dataDir.walkTopDown().map { it.relativeTo(context.dataDir).path }.toList()
        WitnessJournal(context, signer).use { journal ->
            assertSame(WitnessResult.Missing, journal.observeExisting())
            assertEquals(before, context.dataDir.walkTopDown().map { it.relativeTo(context.dataDir).path }.toList())
            assertEquals(0, context.creatingDirectoryReads)
            val prepared = stored(journal.prepareAccepted(enrollment, enrollment.creationAttemptId.copyBytes()))
            assertEquals(WitnessPhase.PREPARED, prepared.identity.phase)
            assertEquals(1L, prepared.identity.revision)
            assertEquals(listOf(enrollment), prepared.enrollments)
            assertNull(prepared.identity.generationChallenge)
            assertNull(prepared.identity.metadata)
            assertEquals(1L, stored(journal.prepareAccepted(enrollment, enrollment.creationAttemptId.copyBytes())).identity.revision)
        }
        WitnessJournal(context, signer).use { reopened ->
            val snapshot = stored(reopened.observeExisting())
            assertEquals(1L, snapshot.identity.revision)
            assertEquals(listOf(enrollment), snapshot.enrollments)
        }
    }

    @Test fun loneCoordinationLockAllowsExplicitPreparationWhileMissingAppParentRefuses() {
        val context = journalContext()
        val directory = File(context.dataDir, "no_backup/treehouse-governance-v1").also { assertTrue(it.mkdirs()) }
        val lock = File(directory, "identity.lock").also { assertTrue(it.createNewFile()) }
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            assertSame(WitnessResult.Missing, journal.observeExisting())
            assertEquals(listOf("identity.lock"), directory.list()!!.toList())
            assertEquals(0, context.creatingDirectoryReads)
            assertEquals(WitnessPhase.PREPARED, stored(journal.prepareAccepted(enrollment(), ByteArray(32) { 3 })).identity.phase)
        }
        assertTrue(lock.isFile)
        val missing = journalContext()
        assertTrue(missing.dataDir.delete())
        WitnessJournal(missing, ByteArray(32) { 7 }).use { journal ->
            assertEquals(WitnessResult.Refused("storage_parent_missing"), journal.observeExisting())
            assertEquals(WitnessResult.Refused("storage_parent_missing"), journal.prepareAccepted(enrollment(), ByteArray(32) { 3 }))
        }
        assertFalse(missing.dataDir.exists())
        assertEquals(0, missing.creatingDirectoryReads)
    }

    @Test fun interruptedInitialPrepareNeverReplacesPartialOrCommittedOriginal() {
        for (boundary in listOf("before_commit", "after_commit")) {
            val context = journalContext()
            WitnessJournal(context, ByteArray(32) { 7 }, { if (it == boundary) throw java.io.IOException("initial prepare interruption") }).use { journal ->
                assertEquals(WitnessResult.Refused("storage_io_error"), journal.prepareAccepted(enrollment(), ByteArray(32) { 3 }))
            }
            val before = database(context).readBytes()
            WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
                if (boundary == "before_commit") {
                    assertTrue(journal.observeExisting() is WitnessResult.Refused)
                    assertTrue(journal.prepareAccepted(enrollment(), ByteArray(32) { 3 }) is WitnessResult.Refused)
                    assertArrayEquals(before, database(context).readBytes())
                } else {
                    val original = stored(journal.observeExisting())
                    assertEquals(WitnessPhase.PREPARED, original.identity.phase)
                    assertEquals(1L, original.identity.revision)
                    assertEquals(1L, stored(journal.prepareAccepted(enrollment(), ByteArray(32) { 3 })).identity.revision)
                    val different = WitnessEnrollment(ByteArray(32) { 1 }, "replica", ByteArray(32) { 2 }, ByteArray(32) { 8 })
                    assertEquals(WitnessResult.Refused("creation_attempt_mismatch"), journal.prepareAccepted(different, ByteArray(32) { 8 }))
                }
            }
        }
    }

    @Test fun orphanRollbackJournalRefusesWithoutCreatingAnIdentityOrDiscardingEvidence() {
        val context = journalContext()
        val directory = File(context.dataDir, "no_backup/treehouse-governance-v1").also { assertTrue(it.mkdirs()) }
        val rollback = File(directory, "identity.sqlite3-journal").also { it.writeBytes(ByteArray(32) { 17 }) }
        File(directory, "identity.lock").createNewFile()
        val before = directory.listFiles()!!.associate { it.name to it.readBytes() }
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            val observation = journal.observeExisting()
            val preparation = journal.prepareAccepted(enrollment(), ByteArray(32) { 3 })
            assertEquals(listOf(WitnessResult.Refused("incomplete_store"), WitnessResult.Refused("incomplete_store")), listOf(observation, preparation))
        }
        assertFalse(database(context).exists())
        assertEquals(before.keys, directory.list()!!.toSet())
        before.forEach { (name, bytes) -> assertArrayEquals(name, bytes, File(directory, name).readBytes()) }
        assertEquals(32L, rollback.length())
        assertEquals(0, context.creatingDirectoryReads)
    }

    @Test fun zeroByteInterruptedIdentityIsRetainedAndRefused() {
        val context = journalContext()
        val database = File(context.dataDir, "no_backup/treehouse-governance-v1/identity.sqlite3")
        database.parentFile!!.mkdirs(); database.createNewFile()
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            assertTrue(journal.observeExisting() is WitnessResult.Refused)
            val enrollment = WitnessEnrollment(ByteArray(32) { 1 }, "replica", ByteArray(32) { 2 }, ByteArray(32) { 3 })
            assertTrue(journal.prepareAccepted(enrollment, enrollment.creationAttemptId.copyBytes()) is WitnessResult.Refused)
        }
        assertTrue(database.isFile); assertEquals(0L, database.length())
    }


    @Test fun unknownSchemaIsRetainedBeforeAnyWritableOpenOrDirectorySync() {
        val context = journalContext()
        val database = File(context.dataDir, "no_backup/treehouse-governance-v1/identity.sqlite3")
        database.parentFile!!.mkdirs()
        SQLiteDatabase.openOrCreateDatabase(database, null).use { it.execSQL("CREATE TABLE unknown (id INTEGER)") }
        File(database.parentFile, "identity.lock").createNewFile()
        val before = database.readBytes()
        val checkpoints = mutableListOf<String>()
        WitnessJournal(context, ByteArray(32) { 7 }, { checkpoints.add(it) }).use { journal ->
            assertEquals(WitnessResult.Refused("unknown_schema"), journal.observeExisting())
            val enrollment = WitnessEnrollment(ByteArray(32) { 1 }, "replica", ByteArray(32) { 2 }, ByteArray(32) { 3 })
            assertEquals(WitnessResult.Refused("unknown_schema"), journal.prepareAccepted(enrollment, enrollment.creationAttemptId.copyBytes()))
        }
        assertArrayEquals(before, database.readBytes())
        assertEquals(0, context.creatingDirectoryReads)
        assertTrue(checkpoints.isEmpty())
    }

    @Test fun everyProductPathSymlinkRefusesWithoutFollowingOrCreating() {
        for (part in listOf("no_backup", "no_backup/treehouse-governance-v1", "no_backup/treehouse-governance-v1/identity.sqlite3")) {
            val context = journalContext()
            val outside = temporary.newFolder("outside-${part.length}")
            val marker = File(outside, "retained").also { it.writeText("unchanged") }
            val link = File(context.dataDir, part)
            link.parentFile!!.mkdirs()
            java.nio.file.Files.createSymbolicLink(link.toPath(), outside.toPath())
            WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
                assertEquals(WitnessResult.Refused("storage_symlink"), journal.observeExisting())
                val enrollment = WitnessEnrollment(ByteArray(32) { 1 }, "replica", ByteArray(32) { 2 }, ByteArray(32) { 3 })
                assertEquals(WitnessResult.Refused("storage_symlink"), journal.prepareAccepted(enrollment, enrollment.creationAttemptId.copyBytes()))
            }
            assertEquals("unchanged", marker.readText())
            assertEquals(listOf("retained"), outside.listFiles()!!.map { it.name })
            assertEquals(0, context.creatingDirectoryReads)
        }
    }


    @Test fun hostDirectoryAdapterForcesRealDirectoryAndRefusesReplacementAndStaleHandles() {
        val context = journalContext()
        val directory = File(context.dataDir, "directory").also { assertTrue(it.mkdir()) }
        val flags = OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC
        val descriptor = Os.open(directory.path, flags, 0)
        assertTrue(OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode))
        Os.fsync(descriptor)
        Os.close(descriptor)
        assertEquals(listOf("open", "fstat", "fsync", "close"), WitnessDirectoryOsShadow.events.map { it.first })
        assertThrows(ErrnoException::class.java) { Os.fsync(descriptor) }
        assertThrows(ErrnoException::class.java) { Os.close(descriptor) }
        assertThrows(ErrnoException::class.java) { Os.open(directory.path, OsConstants.O_RDWR, 0) }
        val original = Os.open(directory.path, flags, 0)
        assertTrue(directory.renameTo(File(context.dataDir, "original-directory")))
        assertTrue(directory.mkdir())
        assertThrows(ErrnoException::class.java) { Os.fstat(original) }
        assertThrows(ErrnoException::class.java) { Os.fsync(original) }
        assertThrows(ErrnoException::class.java) { Os.close(original) }
        val regular = File(context.dataDir, "regular").also { it.writeText("retained") }
        val eventsBefore = WitnessDirectoryOsShadow.events.toList()
        val realFile = Os.open(regular.path, OsConstants.O_RDONLY, 0)
        assertEquals(eventsBefore, WitnessDirectoryOsShadow.events)
        Os.close(realFile)
        assertEquals("retained", regular.readText())
    }

    @Test fun directoryFailuresNeverReturnAPreparedReceiptAndKeepCoordinationFiles() {
        for (step in listOf("open", "fstat", "fsync", "close")) {
            val context = journalContext()
            val directory = File(context.dataDir, "no_backup/treehouse-governance-v1")
            WitnessDirectoryOsShadow.failNext(step, directory)
            WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
                val enrollment = WitnessEnrollment(ByteArray(32) { 1 }, "replica", ByteArray(32) { 2 }, ByteArray(32) { 3 })
                assertTrue(journal.prepareAccepted(enrollment, enrollment.creationAttemptId.copyBytes()) is WitnessResult.Refused)
            }
            assertTrue(directory.isDirectory)
            assertFalse(File(directory, "identity.sqlite3").exists())
        }
    }


    @Test fun preparedIdentityRetainsExactEnrollmentButRefusesDistinctEnrollmentWithoutMutation() {
        val context = journalContext()
        val original = enrollment()
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            stored(journal.prepareAccepted(original, ByteArray(32) { 3 }))
            val before = database(context).readBytes()
            assertEquals(1L, stored(journal.prepareAccepted(original, ByteArray(32) { 3 })).identity.revision)
            assertEquals(WitnessResult.Refused("enrollment_conflict"), journal.prepareAccepted(enrollment(replica = "different"), ByteArray(32) { 3 }))
            assertEquals(WitnessResult.Refused("identity_incomplete"), journal.prepareAccepted(enrollment(id = 2), ByteArray(32) { 3 }))
            val unchanged = stored(journal.observeExisting())
            assertEquals(WitnessPhase.PREPARED, unchanged.identity.phase)
            assertEquals(1L, unchanged.identity.revision)
            assertEquals(listOf(original), unchanged.enrollments)
            assertArrayEquals(before, database(context).readBytes())
        }
    }

    @Test fun startedIdentityRefusesDistinctEnrollmentWithoutInvalidatingOriginalGenerationFence() {
        val context = journalContext()
        val original = enrollment()
        val additional = enrollment(id = 2)
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            stored(journal.prepareAccepted(original, ByteArray(32) { 3 }))
            val fence = stored(journal.commitGenerationStarted(1, ByteArray(32) { 3 }, ByteArray(32) { 4 }))
            val before = database(context).readBytes()
            assertEquals(2L, stored(journal.prepareAccepted(original, ByteArray(32) { 3 })).identity.revision)
            assertEquals(WitnessResult.Refused("identity_incomplete"), journal.prepareAccepted(additional, ByteArray(32) { 3 }))
            val unchanged = stored(journal.observeExisting())
            assertEquals(WitnessPhase.GENERATION_STARTED, unchanged.identity.phase)
            assertEquals(2L, unchanged.identity.revision)
            assertEquals(listOf(original), unchanged.enrollments)
            assertArrayEquals(before, database(context).readBytes())
            val completed = stored(journal.finishOriginalGeneration(fence, metadata()))
            assertEquals(3L, completed.identity.revision)
            assertEquals(metadata(), completed.identity.metadata)
            val bound = stored(journal.prepareAccepted(additional, ByteArray(32) { 3 }))
            assertEquals(4L, bound.identity.revision)
            assertEquals(listOf(original, additional), bound.enrollments)
            assertEquals(completed.identity.metadata, bound.identity.metadata)
        }
        WitnessJournal(context, ByteArray(32) { 7 }).use { reopened ->
            val retained = stored(reopened.observeExisting())
            assertEquals(4L, retained.identity.revision)
            assertEquals(listOf(original, additional), retained.enrollments)
        }
    }

    @Test fun generationFenceIsDurablePrivateSingleUseAndCompletionRetainsOriginalMetadata() {
        val context = journalContext()
        val enrollment = enrollment()
        val challenge = ByteArray(32) { 4 }
        val metadata = metadata()
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            stored(journal.prepareAccepted(enrollment, enrollment.creationAttemptId.copyBytes()))
            val fence = stored(journal.commitGenerationStarted(1, enrollment.creationAttemptId.copyBytes(), challenge))
            challenge.fill(0)
            assertEquals(2L, fence.revision)
            assertEquals(WitnessPhase.GENERATION_STARTED, stored(journal.observeExisting()).identity.phase)
            assertEquals(4.toByte(), fence.generationChallenge.copyBytes()[0])
            assertTrue(journal.commitGenerationStarted(2, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 }) is WitnessResult.Refused)
            WitnessJournal(context, ByteArray(32) { 7 }).use { other ->
                assertTrue(other.finishOriginalGeneration(fence, metadata) is WitnessResult.Refused)
            }
            val forged = object : GenerationFence {
                override val revision = fence.revision
                override val creationAttemptId = fence.creationAttemptId
                override val generationChallenge = fence.generationChallenge
            }
            assertTrue(journal.finishOriginalGeneration(forged, metadata) is WitnessResult.Refused)
            val completed = stored(journal.finishOriginalGeneration(fence, metadata))
            assertEquals(3L, completed.identity.revision)
            assertEquals(WitnessPhase.GENERATED_UNVALIDATED, completed.identity.phase)
            assertEquals(metadata, completed.identity.metadata)
            assertTrue(journal.finishOriginalGeneration(fence, metadata) is WitnessResult.Refused)
        }
        WitnessJournal(context, ByteArray(32) { 7 }).use { reopened ->
            val current = stored(reopened.observeExisting())
            assertEquals(metadata, current.identity.metadata)
            assertEquals(4.toByte(), current.identity.generationChallenge!!.copyBytes()[0])
            assertEquals(3L, stored(reopened.reconcileOriginalGeneration(3, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 }, metadata)).identity.revision)
            assertTrue(reopened.reconcileOriginalGeneration(3, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 5 }, metadata) is WitnessResult.Refused)
            assertTrue(reopened.reconcileOriginalGeneration(3, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 }, metadata(version = "2")) is WitnessResult.Refused)
        }
        WitnessJournal(context, ByteArray(32) { 8 }).use { changed -> assertEquals(WitnessResult.Refused("app_signer_changed"), changed.observeExisting()) }
    }

    @Test fun startedRestartCanOnlyReconcileExactOriginalAndConsentBurnsProductWideNonce() {
        val context = journalContext()
        val enrollment = enrollment()
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            stored(journal.prepareAccepted(enrollment, enrollment.creationAttemptId.copyBytes()))
            stored(journal.commitGenerationStarted(1, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 }))
        }
        val nonce = ByteArray(32) { 11 }
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            assertEquals(WitnessPhase.GENERATION_STARTED, stored(journal.observeExisting()).identity.phase)
            assertTrue(journal.commitGenerationStarted(2, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 }) is WitnessResult.Refused)
            assertTrue(journal.reconcileOriginalGeneration(1, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 }, metadata()) is WitnessResult.Refused)
            assertTrue(journal.reconcileOriginalGeneration(2, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 5 }, metadata()) is WitnessResult.Refused)
            stored(journal.reconcileOriginalGeneration(2, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 }, metadata()))
            val receipt = stored(journal.commitBindingConsent(3, enrollment, nonce, ByteArray(32) { 12 }, ByteArray(32) { 13 }, ByteArray(32) { 14 }))
            assertEquals(4L, receipt.revision)
            assertEquals(enrollment, receipt.enrollment)
            nonce.fill(0)
            receipt.nonce.validatorNonce.copyBytes().fill(0)
            assertEquals(11.toByte(), receipt.nonce.validatorNonce.copyBytes()[0])
            assertTrue(journal.commitBindingConsent(4, enrollment, ByteArray(32) { 11 }, ByteArray(32) { 15 }, ByteArray(32) { 16 }, ByteArray(32) { 17 }) is WitnessResult.Refused)
            val other = enrollment(id = 2)
            stored(journal.prepareAccepted(other, other.creationAttemptId.copyBytes()))
            assertTrue(journal.commitBindingConsent(5, other, ByteArray(32) { 11 }, ByteArray(32) { 15 }, ByteArray(32) { 16 }, ByteArray(32) { 17 }) is WitnessResult.Refused)
        }
        WitnessJournal(context, ByteArray(32) { 7 }).use { reopened ->
            val state = stored(reopened.observeExisting())
            assertEquals(5L, state.identity.revision)
            assertEquals(1, state.spentNonces.size)
            assertEquals(11.toByte(), state.spentNonces.single().validatorNonce.copyBytes()[0])
        }
    }


    @Test fun actualEscapedMetadataPreflightRefusesOversizeBeforeCompletionAndRetainsStartedFence() {
        val context = journalContext()
        val ff = ByteArray(32) { -1 }
        val enrollment = WitnessEnrollment(ff, "\u0000".repeat(512), ff, ff)
        val prefix = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
        val oversized = CapturedWitnessIdentity(ff, prefix + ff, ff, "9223372036854775807", List(7) { ByteArray(8191) { -1 } } + listOf(ByteArray(8199) { -1 }))
        val fits = CapturedWitnessIdentity(ff, prefix + ff, ff, "9223372036854775807", List(4) { ByteArray(16384) })
        WitnessJournal(context, ff).use { journal ->
            stored(journal.prepareAccepted(enrollment, ff))
            val fence = stored(journal.commitGenerationStarted(1, ff, ff))
            assertEquals(WitnessResult.Refused("response_too_large"), journal.finishOriginalGeneration(fence, oversized))
            val unchanged = stored(journal.observeExisting())
            assertEquals(2L, unchanged.identity.revision)
            assertEquals(WitnessPhase.GENERATION_STARTED, unchanged.identity.phase)
            assertTrue(unchanged.certificateChain.isEmpty())
            assertNull(unchanged.identity.metadata)
            assertEquals(fits, stored(journal.reconcileOriginalGeneration(2, ff, ff, fits)).identity.metadata)
        }
    }

    @Test fun newEnrollmentCannotMakeAnOriginalPublicResponseOversized() {
        val context = journalContext()
        val enrollment = enrollment(replica = "r")
        val capture = metadata(chain = List(3) { ByteArray(16000) { -1 } })
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            stored(journal.prepareAccepted(enrollment, enrollment.creationAttemptId.copyBytes()))
            val fence = stored(journal.commitGenerationStarted(1, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 }))
            stored(journal.finishOriginalGeneration(fence, capture))
            val oversized = enrollment(id = 2, replica = "\u0000".repeat(512))
            assertEquals(WitnessResult.Refused("response_too_large"), journal.prepareAccepted(oversized, oversized.creationAttemptId.copyBytes()))
            val unchanged = stored(journal.observeExisting())
            assertEquals(3L, unchanged.identity.revision)
            assertEquals(listOf(enrollment), unchanged.enrollments)
        }
    }

    @Test fun exact128KiBResponseFitsAndOneAdditionalLegalUtf8ByteRefuses() {
        // Independent API33 JSONStringer sizing: these actual fixed fields and the three
        // 16,000-byte all-FF certificates contribute 129,506 bytes excluding replica text.
        // Escaped NUL adds six bytes, ASCII adds one: 129506 + 211*6 + 300 = 131072.
        val context = journalContext()
        val exact = enrollment(replica = "\u0000".repeat(211) + "a".repeat(300))
        val metadata = metadata(chain = List(3) { ByteArray(16000) { -1 } })
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            stored(journal.prepareAccepted(exact, ByteArray(32) { 3 }))
            val fence = stored(journal.commitGenerationStarted(1, ByteArray(32) { 3 }, ByteArray(32) { 4 }))
            assertEquals(metadata, stored(journal.finishOriginalGeneration(fence, metadata)).identity.metadata)
            val oneMore = enrollment(id = 2, replica = exact.replica + "a")
            assertEquals(512, oneMore.replica.toByteArray(Charsets.UTF_8).size)
            assertEquals(WitnessResult.Refused("response_too_large"), journal.prepareAccepted(oneMore, ByteArray(32) { 3 }))
            assertEquals(listOf(exact), stored(journal.observeExisting()).enrollments)
        }
    }

    @Test fun completedMetadataAndForeignNonceCorruptionStayRetainedRefusals() {
        val cases = listOf<(SQLiteDatabase) -> Unit>(
            { it.execSQL("UPDATE identity SET spki=?", arrayOf(ByteArray(44))) },
            { it.execSQL("UPDATE identity SET creation_version_code='01'") },
            { it.execSQL("UPDATE identity SET public_key=NULL") },
            { it.execSQL("UPDATE identity_chain SET ordinal=1") },
            { it.execSQL("UPDATE identity_chain SET der=zeroblob(16385)") },
            { db -> for (ordinal in 1..4) db.execSQL("INSERT INTO identity_chain (ordinal,der) VALUES (?,zeroblob(16384))", arrayOf(ordinal)) },
            { it.execSQL("INSERT INTO spent_nonces VALUES (?,?,?,?,?)", arrayOf(ByteArray(32) { 11 }, ByteArray(32) { 99 }, ByteArray(32) { 12 }, ByteArray(32) { 13 }, ByteArray(32) { 14 })) }
        )
        for ((index, alter) in cases.withIndex()) {
            val context = journalContext()
            preparePhase(context, 3)
            mutateFixture(context) { db -> db.execSQL("PRAGMA ignore_check_constraints=ON"); alter(db) }
            val before = database(context).readBytes()
            WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
                assertTrue("complete case $index", journal.observeExisting() is WitnessResult.Refused)
                assertTrue("complete case $index", journal.commitBindingConsent(3, enrollment(), ByteArray(32) { 11 }, ByteArray(32) { 12 }, ByteArray(32) { 13 }, ByteArray(32) { 14 }) is WitnessResult.Refused)
            }
            assertArrayEquals("complete case $index", before, database(context).readBytes())
        }
    }

    @Test fun everyWriteBoundaryRefusesWithoutReturningGenerationOrConsentReceipts() {
        val boundaries = listOf("before_open", "after_open", "before_begin", "after_begin", "before_commit", "after_commit", "after_close", "before_response")
        for (kind in listOf("start", "complete", "consent")) for (boundary in boundaries) {
            val context = journalContext()
            val enrollment = enrollment()
            preparePhase(context, if (kind == "start") 1 else if (kind == "complete") 2 else 3)
            var fired = false
            WitnessJournal(context, ByteArray(32) { 7 }, { step ->
                if (step == boundary) { fired = true; throw java.io.IOException("injected storage boundary") }
            }).use { journal ->
                val result = when (kind) {
                    "start" -> journal.commitGenerationStarted(1, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 })
                    "complete" -> journal.reconcileOriginalGeneration(2, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 }, metadata())
                    else -> journal.commitBindingConsent(3, enrollment, ByteArray(32) { 11 }, ByteArray(32) { 12 }, ByteArray(32) { 13 }, ByteArray(32) { 14 })
                }
                assertTrue("$kind/$boundary must fire", fired)
                assertEquals("$kind/$boundary", WitnessResult.Refused("storage_io_error"), result)
            }
            WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
                val state = stored(journal.observeExisting())
                val committed = boundary in listOf("after_commit", "after_close", "before_response")
                val originalRevision = if (kind == "start") 1L else if (kind == "complete") 2L else 3L
                assertEquals("$kind/$boundary", originalRevision + if (committed) 1 else 0, state.identity.revision)
                if (kind == "start" && committed) {
                    assertEquals(WitnessPhase.GENERATION_STARTED, state.identity.phase)
                    assertTrue(journal.commitGenerationStarted(2, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 }) is WitnessResult.Refused)
                }
                if (kind == "complete") assertEquals(if (committed) metadata() else null, state.identity.metadata)
                if (kind == "consent") {
                    assertEquals(if (committed) 1 else 0, state.spentNonces.size)
                    if (committed) assertEquals(WitnessResult.Refused("validator_nonce_spent"), journal.commitBindingConsent(4, enrollment, ByteArray(32) { 11 }, ByteArray(32) { 12 }, ByteArray(32) { 13 }, ByteArray(32) { 14 }))
                }
            }
        }
    }

    @Test fun directorySyncFailureAfterCommitNeverReturnsAReceiptOrRollsBackEvidence() {
        for (kind in listOf("start", "complete", "consent")) {
            val context = journalContext()
            val enrollment = enrollment()
            val originalRevision = if (kind == "start") 1 else if (kind == "complete") 2 else 3
            preparePhase(context, originalRevision)
            WitnessDirectoryOsShadow.failNext("fsync", File(context.dataDir, "no_backup/treehouse-governance-v1"))
            WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
                val result = when (kind) {
                    "start" -> journal.commitGenerationStarted(1, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 })
                    "complete" -> journal.reconcileOriginalGeneration(2, enrollment.creationAttemptId.copyBytes(), ByteArray(32) { 4 }, metadata())
                    else -> journal.commitBindingConsent(3, enrollment, ByteArray(32) { 11 }, ByteArray(32) { 12 }, ByteArray(32) { 13 }, ByteArray(32) { 14 })
                }
                assertTrue(result is WitnessResult.Refused)
            }
            WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
                val state = stored(journal.observeExisting())
                assertEquals(originalRevision + 1L, state.identity.revision)
                if (kind == "consent") assertEquals(1, state.spentNonces.size)
                if (kind == "start") assertEquals(WitnessPhase.GENERATION_STARTED, state.identity.phase)
            }
        }
    }

    @Test fun interruptedCallerAndConcurrentCloseDrainTheTransactionBeforeReleasingProcessLease() {
        val context = journalContext()
        preparePhase(context, 1)
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val closeStarted = java.util.concurrent.CountDownLatch(1)
        val closed = java.util.concurrent.CountDownLatch(1)
        val result = java.util.concurrent.atomic.AtomicReference<WitnessResult<GenerationFence>>()
        val interrupted = java.util.concurrent.atomic.AtomicBoolean()
        val journal = WitnessJournal(context, ByteArray(32) { 7 }, { step ->
            if (step == "after_begin") { entered.countDown(); check(release.await(10, java.util.concurrent.TimeUnit.SECONDS)) }
        })
        val caller = Thread {
            result.set(journal.commitGenerationStarted(1, ByteArray(32) { 3 }, ByteArray(32) { 4 }))
            interrupted.set(Thread.currentThread().isInterrupted)
        }
        val closer = Thread { closeStarted.countDown(); journal.close(); closed.countDown() }
        try {
            caller.start()
            assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS))
            caller.interrupt()
            closer.start()
            assertTrue(closeStarted.await(10, java.util.concurrent.TimeUnit.SECONDS))
            assertFalse(closed.await(100, java.util.concurrent.TimeUnit.MILLISECONDS))
            WitnessJournal(context, ByteArray(32) { 7 }).use { competing ->
                assertEquals(WitnessResult.Refused("storage_busy"), competing.observeExisting())
            }
            release.countDown()
            caller.join(10000); closer.join(10000)
            assertFalse(caller.isAlive); assertFalse(closer.isAlive)
            assertTrue(interrupted.get())
            assertEquals(WitnessResult.Refused("storage_interrupted"), result.get())
            WitnessJournal(context, ByteArray(32) { 7 }).use { reopened ->
                assertEquals(WitnessPhase.GENERATION_STARTED, stored(reopened.observeExisting()).identity.phase)
            }
        } finally { release.countDown(); caller.join(10000); if (closer.state != Thread.State.NEW) closer.join(10000); journal.close() }
    }

    @Test fun enrollmentAndNonceLimitsAreInclusiveAndNeverEvictRetainedRows() {
        val context = journalContext()
        preparePhase(context, 3)
        mutateFixture(context) { db ->
            for (number in 1..4094) db.execSQL("INSERT INTO enrollments (enrollment_id,replica,recipient,creation_attempt_id) VALUES (?,?,?,?)",
                arrayOf(numbered(number), "replica:$number", ByteArray(32) { 2 }, ByteArray(32) { 3 }))
        }
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            val last = WitnessEnrollment(numbered(4095), "replica:last", ByteArray(32) { 2 }, ByteArray(32) { 3 })
            assertEquals(4096, stored(journal.prepareAccepted(last, ByteArray(32) { 3 })).enrollments.size)
            val overflow = WitnessEnrollment(numbered(4096), "replica:overflow", ByteArray(32) { 2 }, ByteArray(32) { 3 })
            assertEquals(WitnessResult.Refused("enrollment_limit"), journal.prepareAccepted(overflow, ByteArray(32) { 3 }))
            assertEquals(4L, stored(journal.prepareAccepted(last, ByteArray(32) { 3 })).identity.revision)
            val conflict = WitnessEnrollment(numbered(4095), "replica:different", ByteArray(32) { 2 }, ByteArray(32) { 3 })
            assertEquals(WitnessResult.Refused("enrollment_conflict"), journal.prepareAccepted(conflict, ByteArray(32) { 3 }))
        }
        val nonceContext = journalContext()
        preparePhase(nonceContext, 3)
        mutateFixture(nonceContext) { db ->
            for (number in 1..4095) db.execSQL("INSERT INTO spent_nonces (validator_nonce,enrollment_id,attempt_id,native_nonce,session_digest) VALUES (?,?,?,?,?)",
                arrayOf(numbered(number), enrollment().enrollmentId.copyBytes(), ByteArray(32) { 12 }, ByteArray(32) { 13 }, ByteArray(32) { 14 }))
        }
        WitnessJournal(nonceContext, ByteArray(32) { 7 }).use { journal ->
            assertEquals(4L, stored(journal.commitBindingConsent(3, enrollment(), numbered(4096), ByteArray(32) { 12 }, ByteArray(32) { 13 }, ByteArray(32) { 14 })).revision)
            assertEquals(WitnessResult.Refused("nonce_limit"), journal.commitBindingConsent(4, enrollment(), numbered(4097), ByteArray(32) { 12 }, ByteArray(32) { 13 }, ByteArray(32) { 14 }))
            assertEquals(4096, stored(journal.observeExisting()).spentNonces.size)
        }
        WitnessJournal(nonceContext, ByteArray(32) { 7 }).use { assertEquals(4096, stored(it.observeExisting()).spentNonces.size) }
    }

    @Test fun exhaustedRevisionRefusesMutationAndRetainsExactDatabase() {
        val context = journalContext()
        preparePhase(context, 1)
        mutateFixture(context) { it.execSQL("UPDATE identity SET revision=?", arrayOf(Long.MAX_VALUE)) }
        val before = database(context).readBytes()
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            assertEquals(Long.MAX_VALUE, stored(journal.observeExisting()).identity.revision)
            assertEquals(WitnessResult.Refused("revision_exhausted"), journal.commitGenerationStarted(Long.MAX_VALUE, ByteArray(32) { 3 }, ByteArray(32) { 4 }))
        }
        assertArrayEquals(before, database(context).readBytes())
    }

    @Test fun malformedRetainedRowsRefuseWithoutRepairIncludingOriginalSqlTypes() {
        val cases = listOf<(SQLiteDatabase) -> Unit>(
            { it.execSQL("UPDATE enrollments SET replica=CAST('replica:synthetic' AS BLOB)") },
            { it.execSQL("UPDATE enrollments SET replica=CAST(X'ff' AS TEXT)") },
            { it.execSQL("UPDATE enrollments SET recipient=X'01'") },
            { it.execSQL("UPDATE enrollments SET creation_attempt_id=?", arrayOf(ByteArray(32) { 8 })) },
            { it.execSQL("UPDATE identity SET phase='generation_started'") },
            { it.execSQL("UPDATE identity SET revision=-1") },
            { it.execSQL("INSERT INTO identity_chain (ordinal,der) VALUES (0,X'01')") },
            { it.execSQL("INSERT INTO spent_nonces VALUES (?,?,?,?,?)", arrayOf(ByteArray(32) { 11 }, ByteArray(32) { 1 }, ByteArray(32) { 12 }, ByteArray(32) { 13 }, ByteArray(32) { 14 })) }
        )
        for ((index, alter) in cases.withIndex()) {
            val context = journalContext()
            preparePhase(context, 1)
            mutateFixture(context) { db -> db.execSQL("PRAGMA ignore_check_constraints=ON"); alter(db) }
            val before = database(context).readBytes()
            val entries = database(context).parentFile!!.list()!!.toList().sorted()
            WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
                assertTrue("case $index", journal.observeExisting() is WitnessResult.Refused)
                assertTrue("case $index", journal.prepareAccepted(enrollment(), ByteArray(32) { 3 }) is WitnessResult.Refused)
            }
            assertArrayEquals("case $index", before, database(context).readBytes())
            assertEquals(entries, database(context).parentFile!!.list()!!.toList().sorted())
        }
    }

    @Test fun corruptSqliteHeaderIsRetainedByTheNonDeletingErrorHandler() {
        val context = journalContext()
        preparePhase(context, 1)
        java.io.RandomAccessFile(database(context), "rw").use { it.seek(0); it.write(ByteArray(100) { 0x7f }) }
        val before = database(context).readBytes()
        val entries = database(context).parentFile!!.list()!!.toList().sorted()
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            assertTrue(journal.observeExisting() is WitnessResult.Refused)
            assertTrue(journal.prepareAccepted(enrollment(), ByteArray(32) { 3 }) is WitnessResult.Refused)
        }
        assertArrayEquals(before, database(context).readBytes())
        assertEquals(entries, database(context).parentFile!!.list()!!.toList().sorted())
    }

    @Test fun separateJvmDeathRetainsStartedCommitAndHotJournalReadNeverRepairs() {
        for (mode in listOf("started", "hot")) {
            val context = journalContext()
            preparePhase(context, 1)
            val output = File(context.dataDir, "child-output.log")
            val process = ProcessBuilder(
                File(System.getProperty("java.home"), "bin/java").path,
                "-Drobolectric.offline=true",
                "-Drobolectric.dependency.dir=${System.getProperty("robolectric.dependency.dir")}",
                "-cp", System.getProperty("java.class.path"),
                WitnessJournalCrashSubprocess::class.java.name, context.dataDir.path, mode
            ).redirectErrorStream(true).redirectOutput(output).start()
            try {
                assertTrue("$mode child timeout: ${output.readText()}", process.waitFor(45, java.util.concurrent.TimeUnit.SECONDS))
                assertEquals(output.readText(), 17, process.exitValue())
            } finally {
                if (process.isAlive) { process.destroyForcibly(); assertTrue(process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)) }
            }
            val directory = database(context).parentFile!!
            val before = directory.listFiles()!!.associate { it.name to it.readBytes() }
            WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
                if (mode == "started") {
                    val state = stored(journal.observeExisting())
                    assertEquals(2L, state.identity.revision)
                    assertEquals(WitnessPhase.GENERATION_STARTED, state.identity.phase)
                    assertTrue(journal.commitGenerationStarted(2, ByteArray(32) { 3 }, ByteArray(32) { 4 }) is WitnessResult.Refused)
                } else {
                    val rollback = File(directory, "identity.sqlite3-journal")
                    assertTrue(rollback.length() > 512)
                    assertTrue(rollback.readBytes().take(8).any { it != 0.toByte() })
                    assertTrue(journal.observeExisting() is WitnessResult.Refused)
                    assertEquals(before.keys, directory.list()!!.toSet())
                    before.forEach { (name, bytes) -> assertArrayEquals(name, bytes, File(directory, name).readBytes()) }
                }
            }
        }
    }

    private fun numbered(number: Int): ByteArray = ByteArray(32).also { java.nio.ByteBuffer.wrap(it).putInt(number) }
    private fun database(context: Context) = File(context.dataDir, "no_backup/treehouse-governance-v1/identity.sqlite3")
    private fun mutateFixture(context: Context, change: (SQLiteDatabase) -> Unit) {
        SQLiteDatabase.openDatabase(database(context), SQLiteDatabase.OpenParams.Builder().setOpenFlags(SQLiteDatabase.NO_LOCALIZED_COLLATORS).build()).use { db ->
            db.beginTransaction()
            try { change(db); db.setTransactionSuccessful() } finally { db.endTransaction() }
        }
    }
    private fun preparePhase(context: Context, revision: Int) {
        WitnessJournal(context, ByteArray(32) { 7 }).use { journal ->
            stored(journal.prepareAccepted(enrollment(), ByteArray(32) { 3 }))
            if (revision >= 2) {
                val fence = stored(journal.commitGenerationStarted(1, ByteArray(32) { 3 }, ByteArray(32) { 4 }))
                if (revision >= 3) stored(journal.finishOriginalGeneration(fence, metadata()))
            }
        }
    }

    private fun enrollment(id: Int = 1, replica: String = "replica:synthetic") = WitnessEnrollment(ByteArray(32) { id.toByte() }, replica, ByteArray(32) { 2 }, ByteArray(32) { 3 })
    private fun metadata(version: String = "1", chain: List<ByteArray> = listOf(byteArrayOf(1, 2, 3))) = CapturedWitnessIdentity(
        ByteArray(32) { 9 }, byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00) + ByteArray(32) { 9 },
        ByteArray(32) { 7 }, version, chain)

    private fun journalContext() = JournalContext(RuntimeEnvironment.getApplication(), temporary.newFolder()).also { WitnessDirectoryOsShadow.registerRoot(it.dataDir) }
    private class JournalContext(base: Context, private val root: File) : ContextWrapper(base) {
        var creatingDirectoryReads = 0
        override fun getDataDir(): File = root
        override fun getNoBackupFilesDir(): File {
            creatingDirectoryReads++
            return File(root, "no_backup").also { it.mkdirs() }
        }
    }
    private fun <T> stored(result: WitnessResult<T>): T {
        assertTrue("expected stored, got $result", result is WitnessResult.Stored)
        return (result as WitnessResult.Stored).value
    }

    @Test fun nativeApi33FileBackedSqlitePrerequisite() {
        assertEquals(33, Build.VERSION.SDK_INT)
        val file = File(temporary.newFolder("native-sqlite"), "storage.sqlite3")
        val options = SQLiteDatabase.OpenParams.Builder()
            .addOpenFlags(SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.NO_LOCALIZED_COLLATORS)
            .setJournalMode("DELETE").setSynchronousMode("EXTRA").build()
        SQLiteDatabase.openDatabase(file, options).use { db ->
            db.rawQuery("PRAGMA journal_mode", null).use { cursor -> assertTrue(cursor.moveToFirst()); assertEquals("delete", cursor.getString(0)) }
            db.rawQuery("PRAGMA synchronous", null).use { cursor -> assertTrue(cursor.moveToFirst()); assertEquals(3, cursor.getInt(0)) }
            db.execSQL("CREATE TABLE proof (id INTEGER PRIMARY KEY, value BLOB NOT NULL)")
            db.beginTransaction()
            try { db.execSQL("INSERT INTO proof VALUES (?,?)", arrayOf(1, byteArrayOf(4, 8, 15, 16, 23, 42))); db.setTransactionSuccessful() }
            finally { db.endTransaction() }
        }
        assertTrue(file.isFile && file.length() > 0)
        SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY or SQLiteDatabase.NO_LOCALIZED_COLLATORS).use { db ->
            assertTrue(db.isReadOnly)
            db.rawQuery("SELECT value FROM proof WHERE id=1", null).use { cursor ->
                assertTrue(cursor.moveToFirst()); assertArrayEquals(byteArrayOf(4, 8, 15, 16, 23, 42), cursor.getBlob(0))
            }
        }
    }
}
