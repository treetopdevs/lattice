package dev.treetop.lattice.township.intent

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TownshipIntentStoreTest {
  @After
  fun reset() {
    TownshipIntentStore.record(Intent(Intent.ACTION_MAIN), "test_reset")
  }

  @Test
  fun consumesPairingHandoffOnce() {
    record("township://pairing?handoff=$HANDOFF")

    assertEquals(HANDOFF, TownshipIntentStore.consumePairingHandoff())
    assertNull(TownshipIntentStore.consumePairingHandoff())
  }

  @Test
  fun acceptsHostlessPairingRoutes() {
    record("township:/pairing?handoff=$HANDOFF")

    assertEquals(HANDOFF, TownshipIntentStore.consumePairingHandoff())
  }

  @Test
  fun rejectsForeignHostsBeforeReturningHandoff() {
    for (value in hostileUris()) {
      record(value)

      assertNull(value, TownshipIntentStore.consumePairingHandoff())
    }
  }

  @Test
  fun rejectsNonBrowsableOrNonViewIntents() {
    record("township://pairing?handoff=$HANDOFF", browsable = false)
    assertNull(TownshipIntentStore.consumePairingHandoff())

    record("township://pairing?handoff=$HANDOFF", action = Intent.ACTION_SEND)
    assertNull(TownshipIntentStore.consumePairingHandoff())
  }

  @Test
  fun rejectsOversizedIntentUrls() {
    record("township://pairing?handoff=${"x".repeat(9000)}")

    assertNull(TownshipIntentStore.consumePairingHandoff())
  }

  private fun record(value: String, action: String = Intent.ACTION_VIEW, browsable: Boolean = true) {
    val intent = Intent(action, Uri.parse(value))
    if (browsable) intent.addCategory(Intent.CATEGORY_BROWSABLE)
    TownshipIntentStore.record(intent, "test")
  }

  private fun hostileUris(): List<String> =
      listOf(
          "township://evil.example/pairing?handoff=$HANDOFF",
          "township://evil.example/nohost:_pairing?handoff=$HANDOFF",
          "township://pairing@evil.example/nohost?handoff=$HANDOFF",
          "township://pairing:80/nohost?handoff=$HANDOFF",
          "township://PAIRING?handoff=$HANDOFF",
          "township:pairing/nohost?handoff=$HANDOFF")

  private companion object {
    const val HANDOFF = "township-pairing:v1:instrumented-public-handoff"
  }
}
