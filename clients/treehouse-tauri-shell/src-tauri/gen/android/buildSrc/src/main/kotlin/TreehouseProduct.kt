import groovy.json.JsonSlurper
import java.io.File

/** Build-only fixed product binding. No key operations or witness eligibility. */
class TreehouseProduct private constructor(
    val appId: String,
    val keyService: String,
    val signingAlias: String,
) {
    companion object {
        fun load(manifest: File, tauriConfig: File): TreehouseProduct {
            val table = JsonSlurper().parse(manifest) as Map<*, *>
            val products = table["products"] as List<*>
            val row = products.filterIsInstance<Map<*, *>>()
                .single { it["product"] == "treehouse" }
            val appId = row["appId"] as String
            val service = row["keyService"] as String
            val alias = row["androidSigningAlias"] as String
            val tauri = JsonSlurper().parse(tauriConfig) as Map<*, *>
            require(appId == "dev.treetop.lattice.treehouse" && tauri["identifier"] == appId)
            require(service == "$appId.carrier" && alias == "treehouse-pilot-v1")
            return TreehouseProduct(appId, service, alias)
        }
    }

    fun releaseRefusal(env: Map<String, String>, isFile: (String) -> Boolean): String? = when {
        env["TREEHOUSE_ANDROID_SIGNING"] != "pilot" -> "Treehouse release requires explicit pilot signing"
        env.keys.any { it.startsWith("TOWNSHIP_PILOT_") || it == "TOWNSHIP_ANDROID_SIGNING" } ->
            "cross-product signing configuration refused"
        env["TREEHOUSE_PILOT_KEY_ALIAS"] != signingAlias -> "cross-product or unknown signing alias refused"
        env["TREEHOUSE_PILOT_KEYSTORE_PATH"].isNullOrBlank() -> "Treehouse pilot keystore path required"
        !isFile(env.getValue("TREEHOUSE_PILOT_KEYSTORE_PATH")) -> "Treehouse pilot keystore file missing"
        env["TREEHOUSE_PILOT_KEYSTORE_PASSWORD"].isNullOrEmpty() -> "Treehouse pilot store password required"
        env["TREEHOUSE_PILOT_KEY_PASSWORD"].isNullOrEmpty() -> "Treehouse pilot key password required"
        versionCode(env) == null -> "Treehouse pilot positive version code required"
        else -> null
    }

    fun versionCode(env: Map<String, String>): Int? = env["TREEHOUSE_ANDROID_VERSION_CODE"]
        ?.toIntOrNull()?.takeIf { it in 1..2_100_000_000 }
}
