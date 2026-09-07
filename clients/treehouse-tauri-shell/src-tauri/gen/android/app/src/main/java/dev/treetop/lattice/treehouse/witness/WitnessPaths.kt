package dev.treetop.lattice.treehouse.witness

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.system.Os
import android.system.OsConstants
import dev.treetop.lattice.treehouse.BuildConfig
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption

internal class WitnessStorageFailure(val reason: String) : Exception(reason)
internal fun storageRequire(value: Boolean, reason: String) { if (!value) throw WitnessStorageFailure(reason) }

/** API33 native product-owned paths. Resolving/observing never invokes a creating Context directory helper. */
@SuppressLint("NewApi")
internal class WitnessPaths(private val context: Context) {
    val appDirectory: File = context.dataDir
    val noBackupDirectory = File(appDirectory, "no_backup")
    val directory = File(noBackupDirectory, "treehouse-governance-v1")
    val database = File(directory, "identity.sqlite3")
    val lock = File(directory, "identity.lock")

    fun validate() {
        storageRequire(Build.VERSION.SDK_INT >= 33, "unsupported_profile")
        storageRequire(!context.isDeviceProtectedStorage, "wrong_storage_context")
        storageRequire(context.packageName == BuildConfig.LATTICE_APP_ID && BuildConfig.LATTICE_PRODUCT == "treehouse", "wrong_product")
        storageRequire(appDirectory.isDirectory, "storage_parent_missing")
        ordinary(noBackupDirectory, true)
        ordinary(directory, true)
        if (directory.exists()) {
            val allowed = setOf("identity.sqlite3", "identity.sqlite3-journal", "identity.lock")
            val children = directory.listFiles() ?: throw WitnessStorageFailure("storage_io_error")
            children.forEach { storageRequire(it.name in allowed, "unknown_storage_file"); ordinary(it, false) }
            storageRequire(database.exists() || children.none { it.name == "identity.sqlite3-journal" }, "incomplete_store")
        }
    }

    fun prepareDirectory() {
        validate()
        val actual = context.noBackupFilesDir
        storageRequire(actual.absoluteFile.normalize() == noBackupDirectory.absoluteFile.normalize(), "unexpected_storage_mapping")
        ordinary(noBackupDirectory, true)
        if (!directory.exists()) storageRequire(directory.mkdir(), "storage_io_error")
        validate()
        synchronizeDirectories()
    }

    fun synchronizeDirectories() {
        // Explicit prepare/write only. Native directory-entry fsync failures propagate before a receipt.
        for (file in listOf(directory, noBackupDirectory, appDirectory)) {
            val descriptor = Os.open(file.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 0)
            try {
                storageRequire(OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode), "storage_not_ordinary")
                Os.fsync(descriptor)
            } finally { Os.close(descriptor) }
        }
    }

    private fun ordinary(file: File, directory: Boolean) {
        val path = file.toPath()
        storageRequire(!Files.isSymbolicLink(path), "storage_symlink")
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            val expected = if (directory) Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) else Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
            storageRequire(expected, "storage_not_ordinary")
        }
    }
}
