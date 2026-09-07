package dev.treetop.lattice.treehouse.witness

import org.json.JSONObject
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class WitnessPreparedHandleRegistryTest {
    private class Backend: WitnessPreparedHandleBackend {
        var calls = 0
        var cancellations = 0
        var selected: WitnessBindingHandle? = null
        var callback: ((WitnessResult<SignedWitnessBinding>) -> Unit)? = null
        override fun sign(handle: WitnessBindingHandle, callback: (WitnessResult<SignedWitnessBinding>) -> Unit) {
            calls++; selected = handle; this.callback = callback
        }
        override fun cancel(operationId: ByteArray, sessionDigest: ByteArray): Boolean { cancellations++; return false }
    }

    @Test fun privateTokenRetainsActualOpaqueHandleAndSignsOnlyOnce() {
        val backend = Backend()
        val registry = WitnessPreparedHandleRegistry(backend, { bytes(30) }, { 100 })
        val prepared = PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 1000)
        val bytes = stored(registry.register(w(1), w(9), prepared))
        val json = JSONObject(String(bytes))
        assertArrayEquals(bytes(30), Base64.getDecoder().decode(json.getString("handle")))
        val request = WitnessPrivateRequest.SignPrepared(w(1), w(9), w(30))
        val results = mutableListOf<WitnessResult<ByteArray>>()
        registry.signPrepared(request, results::add)
        assertSame(prepared.handle, backend.selected)
        assertEquals(1, backend.calls)
        registry.signPrepared(request, results::add)
        assertEquals(WitnessResult.Missing, results.single())
        backend.callback!!(WitnessResult.Stored(SignedWitnessBinding(prepared.claim, ByteArray(64) { 7 })))
        assertEquals("signed", JSONObject(String(stored(results.last()))).getString("status"))
        backend.callback!!(WitnessResult.Stored(SignedWitnessBinding(prepared.claim, ByteArray(64) { 8 })))
        assertEquals(2, results.size)
        registry.signPrepared(request, results::add)
        assertEquals(WitnessResult.Missing, results.last())
        assertEquals(1, backend.calls)
    }

    @Test fun wrongOperationSessionHandleAndRestartCannotSelectSigningHandle() {
        val backend = Backend()
        val registry = WitnessPreparedHandleRegistry(backend, { bytes(30) }, { 100 })
        registry.register(w(1), w(9), PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 1000))
        for (request in listOf(WitnessPrivateRequest.SignPrepared(w(2), w(9), w(30)),
            WitnessPrivateRequest.SignPrepared(w(1), w(8), w(30)), WitnessPrivateRequest.SignPrepared(w(1), w(9), w(31)))) {
            registry.signPrepared(request) { assertEquals(WitnessResult.Missing, it) }
        }
        assertFalse(registry.cancel(w(1), w(8)))
        assertEquals(0, backend.calls)
        val restarted = WitnessPreparedHandleRegistry(backend, { bytes(31) }, { 100 })
        restarted.signPrepared(WitnessPrivateRequest.SignPrepared(w(1), w(9), w(30))) { assertEquals(WitnessResult.Missing, it) }
        registry.signPrepared(WitnessPrivateRequest.SignPrepared(w(1), w(9), w(30))) { }
        assertEquals(1, backend.calls)
    }

    @Test fun cancellationDuringSigningSuppressesLateResultsEvenIfBackendCannotCancel() {
        val backend = Backend()
        val registry = WitnessPreparedHandleRegistry(backend, { bytes(30) }, { 100 })
        val prepared = PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 1000)
        registry.register(w(1), w(9), prepared)
        val results = mutableListOf<WitnessResult<ByteArray>>()
        registry.signPrepared(WitnessPrivateRequest.SignPrepared(w(1), w(9), w(30)), results::add)
        assertTrue(registry.cancel(w(1), w(9)))
        assertFalse(registry.cancel(w(1), w(9)))
        backend.callback!!(WitnessResult.Stored(SignedWitnessBinding(claim(), ByteArray(64))))
        assertEquals(WitnessResult.Refused("cancelled"), results.single())
        assertEquals(1, backend.cancellations)
    }

    @Test fun preparedCancellationExpiryAndClaimSubstitutionNeverReturnSignature() {
        val backend = Backend()
        var now = 100L
        var token = 30
        val registry = WitnessPreparedHandleRegistry(backend, { bytes(token++) }, { now })
        registry.register(w(1), w(9), PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 1))
        now = 101
        registry.signPrepared(WitnessPrivateRequest.SignPrepared(w(1), w(9), w(30))) { assertEquals(WitnessResult.Missing, it) }
        assertEquals(0, backend.calls)
        registry.register(w(2), w(9), PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 100))
        assertTrue(registry.cancel(w(2), w(9)))
        registry.signPrepared(WitnessPrivateRequest.SignPrepared(w(2), w(9), w(31))) { assertEquals(WitnessResult.Missing, it) }
        assertEquals(0, backend.calls)
        registry.register(w(3), w(9), PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 100))
        registry.signPrepared(WitnessPrivateRequest.SignPrepared(w(3), w(9), w(32))) { assertEquals(WitnessResult.Refused("binding_claim_mismatch"), it) }
        backend.callback!!(WitnessResult.Stored(SignedWitnessBinding(claim("other"), ByteArray(64))))
        registry.register(w(4), w(9), PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 1))
        registry.signPrepared(WitnessPrivateRequest.SignPrepared(w(4), w(9), w(33))) { assertEquals(WitnessResult.Refused("cancelled"), it) }
        now++
        backend.callback!!(WitnessResult.Stored(SignedWitnessBinding(claim(), ByteArray(64))))
    }

    @Test fun collidingRandomTokenCannotReviveConsumedHandle() {
        val backend = Backend()
        val registry = WitnessPreparedHandleRegistry(backend, { bytes(30) }, { 100 })
        registry.register(w(1), w(9), PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 100))
        assertTrue(registry.cancel(w(1), w(9)))
        assertEquals(WitnessResult.Refused("binding_handle_collision"), registry.register(w(2), w(9), PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 100)))
        val invalid = WitnessPreparedHandleRegistry(backend, { ByteArray(31) }, { 100 })
        assertEquals(WitnessResult.Refused("binding_failed"), invalid.register(w(1), w(9), PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 100)))
    }

    @Test fun concurrentSigningCallersHaveExactlyOneBackendOwner() {
        val backend = Backend()
        val registry = WitnessPreparedHandleRegistry(backend, { bytes(30) }, { 100 })
        registry.register(w(1), w(9), PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 1000))
        val start = CountDownLatch(1)
        val done = CountDownLatch(8)
        repeat(8) { Thread { start.await(); registry.signPrepared(WitnessPrivateRequest.SignPrepared(w(1), w(9), w(30))) { }; done.countDown() }.start() }
        start.countDown()
        assertTrue(done.await(10, TimeUnit.SECONDS))
        assertEquals(1, backend.calls)
    }

    @Test fun retainedOpaqueHandlesHaveAnExplicitMemoryBound() {
        val backend = Backend()
        var token = 1
        val registry = WitnessPreparedHandleRegistry(backend, { bytes(token++) }, { 100 })
        repeat(64) { index -> assertTrue(registry.register(w(index), w(9), PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 1000)) is WitnessResult.Stored) }
        assertEquals(WitnessResult.Refused("binding_capacity"), registry.register(w(65), w(9), PreparedWitnessBinding(object: WitnessBindingHandle {}, claim(), 1000)))
        assertEquals(0, backend.calls)
    }

    private fun stored(result: WitnessResult<ByteArray>) = (result as WitnessResult.Stored).value
    private fun w(v: Int) = WitnessBytes(bytes(v))
    private fun bytes(v: Int) = ByteArray(32) { v.toByte() }
    private fun claim(replica: String = "replica:test") = PublicBindingClaim(replica, bytes(1), bytes(2), bytes(3), bytes(4), bytes(5), bytes(6), bytes(7), bytes(9))
}
