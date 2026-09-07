package dev.treetop.lattice.treehouse.witness

import java.io.File

/** Plain-JVM child used to prove operating-system process lock contention. */
object WitnessProcessLockSubprocess {
    @JvmStatic
    fun main(args: Array<String>) {
        require(args.size == 2) { "usage: MODE LOCK_FILE" }

        val lock = WitnessProcessLock(File(args[1]))
        when (args[0]) {
            "hold" -> hold(lock)
            "probe" -> probe(lock)
            else -> error("unknown mode")
        }
    }

    private fun hold(lock: WitnessProcessLock) {
        when (val acquired = lock.tryAcquire(create = true)) {
            is WitnessProcessLock.Acquisition.Acquired -> {
                println("ACQUIRED")
                System.out.flush()
                if (readLine() == "RELEASE") {
                    acquired.lease.close()
                    println("RELEASED")
                    System.out.flush()
                }
            }

            WitnessProcessLock.Acquisition.Busy -> println("BUSY")
            is WitnessProcessLock.Acquisition.Refused -> println("REFUSED:${acquired.reason}")
        }
    }

    private fun probe(lock: WitnessProcessLock) {
        when (val acquired = lock.tryAcquire()) {
            is WitnessProcessLock.Acquisition.Acquired -> {
                acquired.lease.close()
                println("ACQUIRED")
            }

            WitnessProcessLock.Acquisition.Busy -> println("BUSY")
            is WitnessProcessLock.Acquisition.Refused -> println("REFUSED:${acquired.reason}")
        }
        System.out.flush()
    }
}
