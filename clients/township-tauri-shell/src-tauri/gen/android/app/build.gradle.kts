import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
val releaseCleartextDiagnostic = providers.environmentVariable("TOWNSHIP_ANDROID_RELEASE_CLEAR_TEXT_DIAGNOSTIC")
    .map { it == "1" }
    .orElse(false)

// Plan 158 "Signed Android Internal Distribution": release packaging is
// fail-closed. TOWNSHIP_ANDROID_SIGNING=pilot signs with the external
// township-pilot-v1 keystore supplied through CI secrets (file indirection
// only, never argv); TOWNSHIP_ANDROID_SIGNING=dev-smoke is the explicit,
// local-only debug-signed smoke lane; anything else refuses to produce a
// release artifact. Debug keys never enter the pilot lineage.
val townshipPilotAlias = "township-pilot-v1"
val townshipSigningMode = System.getenv("TOWNSHIP_ANDROID_SIGNING")?.trim().orEmpty()
val townshipPilotKeystorePath = System.getenv("TOWNSHIP_PILOT_KEYSTORE_PATH")?.trim().orEmpty()
val townshipPilotKeystorePassword = System.getenv("TOWNSHIP_PILOT_KEYSTORE_PASSWORD").orEmpty()
val townshipPilotKeyAlias = System.getenv("TOWNSHIP_PILOT_KEY_ALIAS")?.trim().orEmpty()
val townshipPilotKeyPassword = System.getenv("TOWNSHIP_PILOT_KEY_PASSWORD").orEmpty()
val townshipVersionCodeOverride = System.getenv("TOWNSHIP_ANDROID_VERSION_CODE")?.trim().orEmpty()

fun townshipReleaseSigningRefusal(cleartextDiagnostic: Boolean): String? = when (townshipSigningMode) {
    "pilot" -> when {
        cleartextDiagnostic ->
            "pilot signing refuses the cleartext diagnostic variant"
        System.getenv().keys.any { it.startsWith("VITE_TOWNSHIP_") } ->
            "pilot signing refuses a seeded VITE_TOWNSHIP_* build environment (probe/env-seed paths are dev-only)"
        townshipPilotKeystorePath.isEmpty() ->
            "TOWNSHIP_PILOT_KEYSTORE_PATH is not set"
        !File(townshipPilotKeystorePath).isFile ->
            "pilot keystore file is missing (path withheld from log)"
        townshipPilotKeystorePassword.isEmpty() ->
            "TOWNSHIP_PILOT_KEYSTORE_PASSWORD is not set"
        townshipPilotKeyAlias != townshipPilotAlias ->
            "cross-product or unknown signing alias refused; Township pilot artifacts sign only with $townshipPilotAlias"
        townshipPilotKeyPassword.isEmpty() ->
            "TOWNSHIP_PILOT_KEY_PASSWORD is not set"
        townshipVersionCodeOverride.isEmpty() ->
            "TOWNSHIP_ANDROID_VERSION_CODE is required for pilot artifacts (monotonic version codes)"
        else -> null
    }
    "dev-smoke" -> when {
        townshipPilotKeystorePath.isNotEmpty() ->
            "dev-smoke refuses to run while a pilot keystore is configured (ambiguous signing intent)"
        else -> null
    }
    "" ->
        "release signing is fail-closed: set TOWNSHIP_ANDROID_SIGNING=pilot with the pilot keystore secrets, " +
            "or TOWNSHIP_ANDROID_SIGNING=dev-smoke for an explicitly debug-signed local smoke artifact"
    else -> "unknown TOWNSHIP_ANDROID_SIGNING mode '$townshipSigningMode'"
}

val townshipResolvedVersionCode: Int? = when {
    townshipVersionCodeOverride.isEmpty() -> null
    else -> townshipVersionCodeOverride.toIntOrNull()?.takeIf { it in 1..2_100_000_000 }
        ?: throw GradleException("TOWNSHIP_ANDROID_VERSION_CODE must be a positive integer <= 2100000000")
}

android {
    compileSdk = 36
    namespace = "dev.treetop.lattice.township"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        manifestPlaceholders["networkSecurityConfig"] = "@xml/township_release_network_security_config"
        manifestPlaceholders["appLabel"] = "Township"
        manifestPlaceholders["mainActivityLabel"] = "Township"
        applicationId = "dev.treetop.lattice.township"
        minSdk = 24
        targetSdk = 36
        versionCode = townshipResolvedVersionCode
            ?: tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        // Created only when the pilot secrets are complete and valid; secrets
        // arrive through env/file indirection and are never echoed or logged.
        if (townshipSigningMode == "pilot" &&
            townshipReleaseSigningRefusal(releaseCleartextDiagnostic.get()) == null
        ) {
            create("townshipPilot") {
                storeFile = File(townshipPilotKeystorePath)
                storePassword = townshipPilotKeystorePassword
                keyAlias = townshipPilotKeyAlias
                keyPassword = townshipPilotKeyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            manifestPlaceholders["networkSecurityConfig"] = "@xml/township_debug_network_security_config"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // Fail-closed (plan 158): pilot mode signs with the external pilot
            // keystore; the explicit dev-smoke mode debug-signs a local smoke
            // artifact; every other invocation is refused before packaging by
            // the townshipReleaseSigningRefusal gate below.
            signingConfig = when {
                townshipSigningMode == "pilot" &&
                    townshipReleaseSigningRefusal(releaseCleartextDiagnostic.get()) == null ->
                    signingConfigs.getByName("townshipPilot")
                townshipSigningMode == "dev-smoke" &&
                    townshipReleaseSigningRefusal(releaseCleartextDiagnostic.get()) == null ->
                    signingConfigs.getByName("debug")
                else -> null
            }
            isMinifyEnabled = true
            if (releaseCleartextDiagnostic.get()) {
                applicationIdSuffix = ".cleartextdiag"
                versionNameSuffix = "-cleartextdiag"
                manifestPlaceholders["appLabel"] = "Township Diagnostic"
                manifestPlaceholders["mainActivityLabel"] = "Township Diagnostic"
                manifestPlaceholders["usesCleartextTraffic"] = "true"
                manifestPlaceholders["networkSecurityConfig"] = "@xml/township_debug_network_security_config"
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

// Fail-closed enforcement: refuse to package any release artifact unless an
// explicit, valid signing mode is configured. This runs before APK packaging
// so no unsigned or silently debug-signed "release" artifact can appear.
tasks.configureEach {
    if (name.startsWith("package") && name.contains("Release")) {
        doFirst {
            townshipReleaseSigningRefusal(releaseCleartextDiagnostic.get())?.let {
                throw GradleException("Township release artifact refused: $it")
            }
        }
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
