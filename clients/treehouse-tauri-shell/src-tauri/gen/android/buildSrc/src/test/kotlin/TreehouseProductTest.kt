import java.io.File
import org.junit.Assert.*
import org.junit.Test

class TreehouseProductTest {
    private fun product(): TreehouseProduct = TreehouseProduct.load(
        File("../../../../../lattice-mobile-core/products.json"), File("../../../tauri.conf.json"))

    @Test fun fixedProductAndClosedRelease() {
        val product = product()
        assertEquals("dev.treetop.lattice.treehouse", product.appId)
        assertEquals("${product.appId}.carrier", product.keyService)
        val valid = mapOf("TREEHOUSE_ANDROID_SIGNING" to "pilot",
            "TREEHOUSE_PILOT_KEY_ALIAS" to product.signingAlias,
            "TREEHOUSE_PILOT_KEYSTORE_PATH" to "synthetic-test-path",
            "TREEHOUSE_PILOT_KEYSTORE_PASSWORD" to "synthetic-test-only",
            "TREEHOUSE_PILOT_KEY_PASSWORD" to "synthetic-test-only",
            "TREEHOUSE_ANDROID_VERSION_CODE" to "1")
        assertNull(product.releaseRefusal(valid) { true })
        assertNotNull(product.releaseRefusal(emptyMap()) { true })
        assertNotNull(product.releaseRefusal(valid) { false })
        for (name in valid.keys) assertNotNull(product.releaseRefusal(valid - name) { true })
        for (alias in listOf("township-pilot-v1", "androiddebugkey", ""))
            assertNotNull(product.releaseRefusal(valid + ("TREEHOUSE_PILOT_KEY_ALIAS" to alias)) { true })
        for (mode in listOf("dev-smoke", "debug", ""))
            assertNotNull(product.releaseRefusal(valid + ("TREEHOUSE_ANDROID_SIGNING" to mode)) { true })
        for (version in listOf("0", "-1", "2100000001", "not-a-version"))
            assertNotNull(product.releaseRefusal(valid + ("TREEHOUSE_ANDROID_VERSION_CODE" to version)) { true })
        assertNotNull(product.releaseRefusal(valid + ("TOWNSHIP_ANDROID_SIGNING" to "pilot")) { true })
    }

    @Test fun crossProductConfigurationCannotBecomeTreehouse() {
        val manifest = File("../../../../../lattice-mobile-core/products.json")
        val tauri = File("../../../tauri.conf.json")
        val alternate = kotlin.io.path.createTempDirectory("treehouse-product-test").toFile()
        try {
            val changed = File(alternate, "products.json")
            changed.writeText(manifest.readText().replace("dev.treetop.lattice.treehouse", "dev.treetop.lattice.township"))
            assertThrows(IllegalArgumentException::class.java) { TreehouseProduct.load(changed, tauri) }
            val otherConfig = File(alternate, "tauri.json")
            otherConfig.writeText(tauri.readText().replace("dev.treetop.lattice.treehouse", "dev.treetop.lattice.township"))
            assertThrows(IllegalArgumentException::class.java) { TreehouseProduct.load(manifest, otherConfig) }
        } finally { alternate.deleteRecursively() }
    }
}
