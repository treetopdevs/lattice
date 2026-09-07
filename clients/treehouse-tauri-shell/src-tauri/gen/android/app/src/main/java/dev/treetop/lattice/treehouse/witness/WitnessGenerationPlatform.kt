package dev.treetop.lattice.treehouse.witness

import android.content.Context
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator

/** Trusted native platform boundary; synthetic implementations belong only in tests. */
internal interface WitnessGenerationPlatform {
    fun observe(original: WitnessIdentityRecord): WitnessKeyObservation
    fun generate(original: WitnessIdentityRecord, fence: GenerationFence)
}

internal class FixedGenerationPlatform(context: Context): WitnessGenerationPlatform {
    private val provider = AndroidWitnessProvider(context)
    override fun observe(original: WitnessIdentityRecord): WitnessKeyObservation = provider.observeFixedIdentity(original)
    override fun generate(original: WitnessIdentityRecord, fence: GenerationFence) {
        require(original.revision == fence.revision && original.creationAttemptId == fence.creationAttemptId && original.generationChallenge == fence.generationChallenge)
        val spec = provider.originalGenerationSpec(original, fence.creationAttemptId.copyBytes(), fence.generationChallenge.copyBytes())
            ?: throw IllegalStateException("unsupported_profile")
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
    }
}
