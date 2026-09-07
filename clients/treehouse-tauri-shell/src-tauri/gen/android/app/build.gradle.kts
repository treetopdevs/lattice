import java.util.Properties
import groovy.json.JsonOutput

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

val product = TreehouseProduct.load(file("../../../../../lattice-mobile-core/products.json"), file("../../../tauri.conf.json"))
val signingEnvironment = System.getenv()
val releaseRefusal = product.releaseRefusal(signingEnvironment) { File(it).isFile }
val verifyTreehouseReleaseIdentity = tasks.register("verifyTreehouseReleaseIdentity") {
    doLast { releaseRefusal?.let { throw GradleException(it) } }
}

// Pinned host-only SDK: Robolectric must not download executable jars at test runtime.
val witnessTestSdk by configurations.creating
val prepareWitnessTestSdk = tasks.register<Sync>("prepareWitnessTestSdk") {
    from(witnessTestSdk)
    into(layout.buildDirectory.dir("witnessTestSdk"))
}

android {
    compileSdk = 36
    namespace = product.appId
    ndkVersion = "27.1.12297006"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = product.appId
        minSdk = 24
        targetSdk = 36
        versionCode = product.versionCode(signingEnvironment)
            ?: tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        buildConfigField("String", "LATTICE_PRODUCT", JsonOutput.toJson("treehouse"))
        buildConfigField("String", "LATTICE_APP_ID", JsonOutput.toJson(product.appId))
        buildConfigField("String", "LATTICE_KEY_SERVICE", JsonOutput.toJson(product.keyService))
        buildConfigField("String", "LATTICE_SIGNING_ALIAS", JsonOutput.toJson(product.signingAlias))
        buildConfigField("boolean", "WITNESS_ELIGIBILITY_IMPLEMENTED", "false")
        buildConfigField("boolean", "PILOT_SIGNED", "false")
    }
    signingConfigs {
        if (releaseRefusal == null) create("treehousePilot") {
            storeFile = File(signingEnvironment.getValue("TREEHOUSE_PILOT_KEYSTORE_PATH"))
            storePassword = signingEnvironment.getValue("TREEHOUSE_PILOT_KEYSTORE_PASSWORD")
            keyAlias = product.signingAlias
            keyPassword = signingEnvironment.getValue("TREEHOUSE_PILOT_KEY_PASSWORD")
        }
    }
    buildTypes {
        getByName("debug") {
            // The approved preview is offline; debug does not broaden its network policy.
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
            signingConfig = if (releaseRefusal == null) signingConfigs.getByName("treehousePilot") else null
            buildConfigField("boolean", "PILOT_SIGNED", if (releaseRefusal == null) "true" else "false")
            isMinifyEnabled = true
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
    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            it.dependsOn(prepareWitnessTestSdk)
            it.systemProperty("robolectric.offline", "true")
            it.systemProperty("robolectric.dependency.dir", layout.buildDirectory.dir("witnessTestSdk").get().asFile.absolutePath)
        }
    }
    buildFeatures {
        buildConfig = true
    }
}

tasks.configureEach {
    if ((name.startsWith("pre") && name.endsWith("ReleaseBuild")) || ((name.startsWith("package") || name.startsWith("bundle")) && name.contains("Release")))
        dependsOn(verifyTreehouseReleaseIdentity)
}

val bindingTestResources = layout.buildDirectory.dir("generated/bindingTestResources")
val generateBindingTestResources = tasks.register("generateBindingTestResources") {
    val fixture = file("../../../../test/fixtures/witness_binding_v1.json")
    inputs.file(fixture)
    outputs.dir(bindingTestResources)
    doLast {
        val vectors = (groovy.json.JsonSlurper().parse(fixture) as Map<*, *>)["vectors"] as List<*>
        val properties = Properties()
        properties["count"] = vectors.size.toString()
        vectors.forEachIndexed { index, item ->
            val vector = item as Map<*, *>
            val fields = vector["fields"] as Map<*, *>
            fields.forEach { (key, value) -> properties["$index.$key"] = value as String }
            properties["$index.canonicalBase64"] = vector["canonicalBase64"] as String
            properties["$index.signatureBase64"] = vector["signatureBase64"] as String
        }
        val target = bindingTestResources.get().file("binding_vectors.properties").asFile
        target.parentFile.mkdirs()
        target.outputStream().use { properties.store(it, "Generated from the BEAM public fixture") }
    }
}
android.sourceSets.getByName("test").resources.srcDir(bindingTestResources)
tasks.configureEach { if (name.startsWith("process") && name.endsWith("UnitTestJavaRes")) dependsOn(generateBindingTestResources) }

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16")
    witnessTestSdk("org.robolectric:android-all-instrumented:13-robolectric-9030017-i7")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
