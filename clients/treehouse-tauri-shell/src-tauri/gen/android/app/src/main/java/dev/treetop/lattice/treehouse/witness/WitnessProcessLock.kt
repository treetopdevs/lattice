package dev.treetop.lattice.treehouse.witness

import java.io.File
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.InvalidPathException

/**
 * Exclusive fixed-file process lock. Android callers enter only through the API33 journal guard;
 * this class stays Android-independent so the same implementation runs in separate host JVMs.
 */
@Suppress("NewApi")
internal class WitnessProcessLock(private val lockFile: File) {
    sealed class Acquisition {
        data class Acquired(val lease: Lease) : Acquisition()
        data object Busy : Acquisition()
        data class Refused(val reason: String) : Acquisition()
    }

    class Lease private constructor(
        private val ownerKey: String,
        private var channel: FileChannel?,
        private var fileLock: FileLock?,
    ) : AutoCloseable {
        @Synchronized
        override fun close() {
            val ownedChannel = channel ?: return
            val ownedLock = fileLock
            channel = null
            fileLock = null

            var failure: Throwable? = null
            try {
                if (ownedLock != null && ownedLock.isValid) ownedLock.release()
            } catch (error: Throwable) {
                failure = error
            }

            try {
                ownedChannel.close()
            } catch (error: Throwable) {
                if (failure == null) failure = error else failure.addSuppressed(error)
            } finally {
                unregister(ownerKey)
            }

            if (failure != null) throw failure
        }

        internal companion object {
            fun owned(ownerKey: String, channel: FileChannel, fileLock: FileLock): Lease =
                Lease(ownerKey, channel, fileLock)
        }
    }

    fun tryAcquire(create: Boolean = false): Acquisition {
        val path = try {
            lockFile.toPath().toAbsolutePath().normalize()
        } catch (_error: InvalidPathException) {
            return Acquisition.Refused("lock_io_error")
        } catch (_error: SecurityException) {
            return Acquisition.Refused("lock_io_error")
        }
        val ownerKey = path.toString()
        if (!register(ownerKey)) return Acquisition.Busy

        var handedOff = false
        return try {
            when (val opened = open(path, create)) {
                is Opened.Refused -> Acquisition.Refused(opened.reason)
                is Opened.Channel -> {
                    when (val locked = lock(opened.value)) {
                        LockAttempt.Busy -> closeThen(opened.value, Acquisition.Busy)
                        is LockAttempt.Refused ->
                            closeThen(opened.value, Acquisition.Refused(locked.reason))

                        is LockAttempt.Acquired -> {
                            val lease = Lease.owned(ownerKey, opened.value, locked.value)
                            handedOff = true
                            Acquisition.Acquired(lease)
                        }
                    }
                }
            }
        } finally {
            if (!handedOff) unregister(ownerKey)
        }
    }

    private fun open(path: Path, create: Boolean): Opened {
        val attributes = try {
            Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        } catch (_error: NoSuchFileException) {
            null
        } catch (_error: IOException) {
            return Opened.Refused("lock_io_error")
        } catch (_error: SecurityException) {
            return Opened.Refused("lock_io_error")
        } catch (_error: UnsupportedOperationException) {
            return Opened.Refused("lock_io_error")
        }
        if (attributes == null) {
            if (!create) return Opened.Refused("lock_missing")
            return create(path)
        }
        if (attributes.isSymbolicLink) return Opened.Refused("lock_symlink")
        if (!attributes.isRegularFile) return Opened.Refused("lock_not_regular")

        return openExisting(path, create)
    }

    private fun create(path: Path): Opened {
        val parent = path.parent ?: return Opened.Refused("lock_parent_missing")
        if (!Files.isDirectory(parent)) return Opened.Refused("lock_parent_missing")

        return try {
            Opened.Channel(
                FileChannel.open(
                    path,
                    StandardOpenOption.WRITE,
                    StandardOpenOption.CREATE_NEW,
                    LinkOption.NOFOLLOW_LINKS,
                ),
            )
        } catch (_error: FileAlreadyExistsException) {
            open(path, create = false)
        } catch (_error: NoSuchFileException) {
            Opened.Refused("lock_parent_missing")
        } catch (_error: IOException) {
            Opened.Refused("lock_io_error")
        } catch (_error: SecurityException) {
            Opened.Refused("lock_io_error")
        } catch (_error: UnsupportedOperationException) {
            Opened.Refused("lock_io_error")
        }
    }

    private fun openExisting(path: Path, create: Boolean): Opened =
        try {
            Opened.Channel(
                FileChannel.open(
                    path,
                    StandardOpenOption.WRITE,
                    LinkOption.NOFOLLOW_LINKS,
                ),
            )
        } catch (_error: NoSuchFileException) {
            if (create) create(path) else Opened.Refused("lock_missing")
        } catch (_error: IOException) {
            Opened.Refused("lock_io_error")
        } catch (_error: SecurityException) {
            Opened.Refused("lock_io_error")
        } catch (_error: UnsupportedOperationException) {
            Opened.Refused("lock_io_error")
        }

    private fun lock(channel: FileChannel): LockAttempt =
        try {
            channel.tryLock()?.let { LockAttempt.Acquired(it) } ?: LockAttempt.Busy
        } catch (_error: OverlappingFileLockException) {
            LockAttempt.Busy
        } catch (_error: IOException) {
            LockAttempt.Refused("lock_io_error")
        } catch (_error: SecurityException) {
            LockAttempt.Refused("lock_io_error")
        }

    private fun closeThen(channel: FileChannel, result: Acquisition): Acquisition =
        try {
            channel.close()
            result
        } catch (_error: IOException) {
            Acquisition.Refused("lock_io_error")
        }

    private sealed class Opened {
        data class Channel(val value: FileChannel) : Opened()
        data class Refused(val reason: String) : Opened()
    }

    private sealed class LockAttempt {
        data class Acquired(val value: FileLock) : LockAttempt()
        data object Busy : LockAttempt()
        data class Refused(val reason: String) : LockAttempt()
    }

    private companion object {
        private val owners = mutableSetOf<String>()

        private fun register(ownerKey: String): Boolean = synchronized(owners) {
            owners.add(ownerKey)
        }

        private fun unregister(ownerKey: String) = synchronized(owners) {
            owners.remove(ownerKey)
            Unit
        }
    }
}
