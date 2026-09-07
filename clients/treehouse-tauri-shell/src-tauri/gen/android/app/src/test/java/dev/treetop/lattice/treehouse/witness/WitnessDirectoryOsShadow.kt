package dev.treetop.lattice.treehouse.witness

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import java.io.File
import java.io.FileDescriptor
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.Collections
import java.util.IdentityHashMap
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.util.ReflectionHelpers.ClassParameter

/** Test-only host directory force. This does not execute Android Os/JNI or prove handset fsync. */
@Implements(Os::class)
class WitnessDirectoryOsShadow {
    companion object {
        private data class Owned(val channel: FileChannel, val path: Path, val fileKey: Any)
        private val owners = IdentityHashMap<FileDescriptor, Owned>()
        private val retired = Collections.newSetFromMap(IdentityHashMap<FileDescriptor, Boolean>())
        private val roots = mutableListOf<Path>()
        val events = mutableListOf<Pair<String, String>>()
        private var fault: Pair<String, Path>? = null

        @Synchronized fun registerRoot(root: File) { roots.add(root.toPath().toAbsolutePath().normalize()) }
        @Synchronized fun failNext(step: String, directory: File) { fault = step to directory.toPath().toAbsolutePath().normalize() }
        @Synchronized fun reset() {
            val leaks = owners.size
            owners.values.forEach { it.channel.close() }
            owners.clear(); retired.clear(); roots.clear(); events.clear(); fault = null
            check(leaks == 0) { "test leaked $leaks host directory handles" }
        }
        private fun checkFault(step: String, path: Path) { if (fault == (step to path)) { fault = null; throw IOException("injected directory $step failure") } }
        private fun guardedPath(path: Path): BasicFileAttributes {
            val root = roots.firstOrNull { path.startsWith(it) } ?: throw IOException("unregistered directory")
            var part = root
            if (Files.isSymbolicLink(part)) throw IOException("root symlink")
            for (component in root.relativize(path)) {
                part = part.resolve(component)
                if (Files.isSymbolicLink(part)) throw IOException("directory symlink")
            }
            return Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS).also {
                if (!it.isDirectory || it.fileKey() == null) throw IOException("not an identifiable host directory")
            }
        }
        private fun current(value: Owned): BasicFileAttributes = guardedPath(value.path).also {
            if (it.fileKey() != value.fileKey) throw IOException("directory replaced")
        }
        private fun error(name: String, cause: Exception): Nothing = throw ErrnoException(name, OsConstants.EIO, cause)
        private fun stale(fd: FileDescriptor) { if (retired.contains(fd)) throw ErrnoException("closed test directory", OsConstants.EBADF) }

        @JvmStatic @Implementation @Synchronized
        fun open(path: String, flags: Int, mode: Int): FileDescriptor {
            val target = File(path).toPath().toAbsolutePath().normalize()
            if (roots.none { target.startsWith(it) } || !Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
                return Shadow.directlyOn(Os::class.java, "open", ClassParameter.from(String::class.java, path),
                    ClassParameter.from(Int::class.javaPrimitiveType, flags), ClassParameter.from(Int::class.javaPrimitiveType, mode))
            }
            try {
                checkFault("open", target)
                if (flags != (OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC) || mode != 0) throw IOException("unexpected directory flags")
                val before = guardedPath(target)
                val channel = FileChannel.open(target, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)
                try {
                    val owned = Owned(channel, target, before.fileKey())
                    current(owned)
                    val handle = FileDescriptor()
                    owners[handle] = owned
                    events.add("open" to target.toString())
                    return handle
                } catch (error: Exception) { channel.close(); throw error }
            } catch (cause: Exception) { error("open", cause) }
        }

        @JvmStatic @Implementation @Synchronized
        fun fstat(fd: FileDescriptor): StructStat {
            stale(fd)
            val owned = owners[fd] ?: return Shadow.directlyOn(Os::class.java, "fstat", ClassParameter.from(FileDescriptor::class.java, fd))
            try {
                checkFault("fstat", owned.path)
                val attributes = current(owned)
                events.add("fstat" to owned.path.toString())
                return StructStat(0, 0, OsConstants.S_IFDIR, 0, 0, 0, 0, attributes.size(),
                    attributes.lastAccessTime().toMillis() / 1000, attributes.lastModifiedTime().toMillis() / 1000, 0, 0, 0)
            } catch (cause: Exception) { error("fstat", cause) }
        }

        @JvmStatic @Implementation @Synchronized
        fun fsync(fd: FileDescriptor) {
            stale(fd)
            val owned = owners[fd]
            if (owned == null) { Shadow.directlyOn<Any?, Os>(Os::class.java, "fsync", ClassParameter.from(FileDescriptor::class.java, fd)); return }
            try {
                checkFault("fsync", owned.path); current(owned); owned.channel.force(true)
                events.add("fsync" to owned.path.toString())
            } catch (cause: Exception) { error("fsync", cause) }
        }

        @JvmStatic @Implementation @Synchronized
        fun close(fd: FileDescriptor) {
            stale(fd)
            val owned = owners.remove(fd)
            if (owned == null) { Shadow.directlyOn<Any?, Os>(Os::class.java, "close", ClassParameter.from(FileDescriptor::class.java, fd)); return }
            retired.add(fd)
            try {
                try { checkFault("close", owned.path); current(owned) } finally { owned.channel.close() }
                events.add("close" to owned.path.toString())
            } catch (cause: Exception) { error("close", cause) }
        }
    }
}
