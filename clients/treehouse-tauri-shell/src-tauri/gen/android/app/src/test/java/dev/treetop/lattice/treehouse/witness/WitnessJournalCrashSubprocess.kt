package dev.treetop.lattice.treehouse.witness

import android.content.Context
import android.content.ContextWrapper
import android.database.sqlite.SQLiteDatabase
import java.io.File
import org.junit.Assume.assumeNotNull
import org.junit.Test
import org.junit.runner.JUnitCore
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode

/** Test-only host process entry. Never referenced by the APK. */
object WitnessJournalCrashSubprocess {
    @JvmStatic fun main(args: Array<String>) {
        require(args.size == 2)
        System.setProperty("treehouse.journal.crash.root", args[0])
        System.setProperty("treehouse.journal.crash.mode", args[1])
        val result = JUnitCore.runClasses(CrashCase::class.java)
        result.failures.forEach { System.err.println(it.trace) }
        // A successful fixture must halt with the explicit crash code while the owner is live.
        kotlin.system.exitProcess(2)
    }

    @RunWith(RobolectricTestRunner::class)
    @Config(sdk = [33], shadows = [WitnessDirectoryOsShadow::class])
    @SQLiteMode(SQLiteMode.Mode.NATIVE)
    class CrashCase {
        @Test fun crashWithRealFileBackedSqliteAndProductionProcessOwner() {
            val path = System.getProperty("treehouse.journal.crash.root")
            assumeNotNull(path)
            val root = File(path!!)
            check(root.isDirectory)
            WitnessDirectoryOsShadow.registerRoot(root)
            val context = object : ContextWrapper(RuntimeEnvironment.getApplication() as Context) {
                override fun getDataDir() = root
                override fun getNoBackupFilesDir() = File(root, "no_backup")
            }
            if (System.getProperty("treehouse.journal.crash.mode") == "started") {
                WitnessJournal(context, ByteArray(32) { 7 }, { step ->
                    if (step == "after_commit") Runtime.getRuntime().halt(17)
                }).use { journal ->
                    check(journal.commitGenerationStarted(1, ByteArray(32) { 3 }, ByteArray(32) { 4 }) is WitnessResult.Stored)
                }
            } else {
                val directory = File(root, "no_backup/treehouse-governance-v1")
                val owner = WitnessProcessLock(File(directory, "identity.lock")).tryAcquire()
                check(owner is WitnessProcessLock.Acquisition.Acquired)
                val parameters = SQLiteDatabase.OpenParams.Builder().setOpenFlags(SQLiteDatabase.NO_LOCALIZED_COLLATORS)
                    .setJournalMode("DELETE").setSynchronousMode("EXTRA").build()
                SQLiteDatabase.openDatabase(File(directory, "identity.sqlite3"), parameters).use { db ->
                    db.execSQL("PRAGMA cache_size=1")
                    db.execSQL("PRAGMA cache_spill=1")
                    db.beginTransaction()
                    // Fixture-only cache spill leaves an actual hot rollback journal. No fake bytes.
                    for (number in 1..512) {
                        val id = ByteArray(32).also { java.nio.ByteBuffer.wrap(it).putInt(number) }
                        db.execSQL("INSERT INTO enrollments VALUES (?,?,?,?)", arrayOf(id, "x".repeat(512), ByteArray(32) { 2 }, ByteArray(32) { 3 }))
                    }
                    db.execSQL("UPDATE identity SET revision=99")
                    Runtime.getRuntime().halt(17)
                }
            }
        }
    }
}
