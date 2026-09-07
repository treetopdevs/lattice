plugins {
  id("com.adarshr.test-logger") version "4.0.0"
  id("org.jetbrains.kotlin.jvm") version "2.2.0"
}

dependencies {
  implementation("androidx.annotation:annotation:1.9.1")
  implementation("co.nstant.in:cbor:0.9")
  implementation("com.google.code.gson:gson:2.11.0")
  implementation("com.google.errorprone:error_prone_annotations:2.41.0")
  implementation("com.google.protobuf:protobuf-javalite:4.28.3")
  implementation("com.google.protobuf:protobuf-kotlin-lite:4.28.3")
  implementation("org.bouncycastle:bcpkix-jdk18on:1.78.1")
  implementation("org.jetbrains.kotlin:kotlin-stdlib:2.2.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-guava:1.10.2")
  implementation("com.google.guava:guava:33.5.0-jre")
  testImplementation(kotlin("test"))
  testImplementation("com.google.testparameterinjector:test-parameter-injector:1.18")
  testImplementation("com.google.truth:truth:1.4.4")
  testRuntimeOnly("org.junit.vintage:junit-vintage-engine")
}

java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }

val vendor = layout.projectDirectory.dir("vendor/android-keyattestation")
sourceSets {
  main { kotlin.srcDir(vendor.dir("src/main/kotlin")) }
  test { kotlin.srcDir(vendor.dir("src/test/kotlin")) }
}

val verifyPinnedUpstream by tasks.registering(Exec::class) {
  inputs.file("upstream.lock.json")
  inputs.dir(vendor)
  commandLine("python3", "scripts/verify_upstream.py", "upstream.lock.json", vendor.asFile)
}

val generatedSourcesDir = layout.buildDirectory.dir("generated")
val googleTrustAnchors by tasks.registering {
  dependsOn(verifyPinnedUpstream)
  val jsonFile = vendor.file("roots.json")
  val generatedFile = generatedSourcesDir.get().file("main/kotlin/GoogleTrustAnchors.kt")
  inputs.file(jsonFile); outputs.file(generatedFile)
  doLast {
    val json = jsonFile.asFile.readText()
    generatedFile.asFile.apply { parentFile.mkdirs(); writeText("""
      package com.android.keyattestation.verifier
      import com.google.gson.Gson
      import java.security.cert.TrustAnchor
      object GoogleTrustAnchors : () -> Set<TrustAnchor> {
        const val JSON = ""${'"'}
          $json
          ""${'"'}
        override fun invoke() = Gson().fromJson(JSON, Array<String>::class.java)
          .map { TrustAnchor(it.asX509Certificate(), null) }.toSet()
      }
    """.trimIndent()) }
  }
}
sourceSets.main { kotlin.srcDir(generatedSourcesDir) }
tasks.named("compileKotlin") { dependsOn(googleTrustAnchors) }
tasks.test {
  dependsOn(verifyPinnedUpstream)
  useJUnitPlatform()
  workingDir(vendor)
}
tasks.compileTestKotlin { compilerOptions { javaParameters = true } }
tasks.check { dependsOn(verifyPinnedUpstream, "verifyUpstreamTamperTest") }
tasks.register<Exec>("verifyUpstreamTamperTest") {
  commandLine("python3", "-m", "unittest", "src/test/python/test_verify_upstream.py")
}
