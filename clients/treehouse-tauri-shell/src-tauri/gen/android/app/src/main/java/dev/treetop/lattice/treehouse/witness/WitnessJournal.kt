package dev.treetop.lattice.treehouse.witness

import android.annotation.SuppressLint
import android.content.Context
import android.database.Cursor
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import dev.treetop.lattice.treehouse.BuildConfig
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import java.util.IdentityHashMap
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * Storage-only API33 journal. The later coordinator supplies the actual native package signer.
 * An explicit operation owns its process lease until close; close drains short in-flight storage
 * calls. No SQLite transaction or Java monitor is held while a caller reviews or authenticates.
 */
@SuppressLint("NewApi")
internal class WitnessJournal(context: Context, expectedAppSignerSha256: ByteArray,
    private val checkpoint: (String) -> Unit = {}) : AutoCloseable {
    private val expectedSigner = witness32(expectedAppSignerSha256)
    private val paths = WitnessPaths(context)
    private val lifecycle = Any()
    private var closed = false
    private val issuedFences = IdentityHashMap<GenerationFence, Boolean>()
    private var lease: WitnessProcessLock.Lease? = null
    private val corruptionHandler = DatabaseErrorHandler { throw WitnessStorageFailure("corrupt_store") }

    fun observeExisting(): WitnessResult<WitnessSnapshot> = operation {
        paths.validate()
        if (!paths.database.exists()) WitnessResult.Missing else {
            requireExistingDatabase()
            var temporary: WitnessProcessLock.Lease? = null
            try {
                if (lease == null) temporary = acquire(false)
                open(false, false).use { WitnessResult.Stored(read(it)) }
            } finally { temporary?.close() }
        }
    }

    fun prepareAccepted(enrollment: WitnessEnrollment, nativeCreationAttempt: ByteArray): WitnessResult<WitnessSnapshot> = operation {
        val attempt = witness32(nativeCreationAttempt)
        storageRequire(attempt == enrollment.creationAttemptId, "creation_attempt_mismatch")
        paths.validate()
        if (paths.database.exists()) {
            requireExistingDatabase()
            if (lease == null) lease = acquire(false)
            // Refuse unknown/corrupt retained stores before writable SQLite configuration.
            open(false, false).use { read(it) }
        }
        if (lease == null) {
            paths.prepareDirectory()
            lease = acquire(true)
            paths.synchronizeDirectories()
        }
        paths.validate()
        val create = !paths.database.exists()
        var result: WitnessSnapshot? = null
        checkpoint("before_open")
        open(true, create).use { db ->
            checkpoint("after_open")
            if (create) {
                transaction(db) {
                    schema.values.forEach { db.execSQL(it) }
                    db.execSQL("PRAGMA user_version=1")
                    db.execSQL("INSERT INTO identity (id,product,app_id,profile_version,creation_attempt_id,phase,revision) VALUES (1,?,?,1,?,'prepared',1)",
                        arrayOf(BuildConfig.LATTICE_PRODUCT, BuildConfig.LATTICE_APP_ID, attempt.copyBytes()))
                    insertEnrollment(db, enrollment)
                    result = read(db)
                }
            } else {
                val current = read(db)
                storageRequire(current.identity.creationAttemptId == attempt, "creation_attempt_mismatch")
                val existing = current.enrollments.find { it.enrollmentId == enrollment.enrollmentId }
                if (existing != null) {
                    storageRequire(existing == enrollment, "enrollment_conflict")
                    result = current
                } else {
                    storageRequire(current.enrollments.size < 4096, "enrollment_limit")
                    current.identity.metadata?.let { requireResponseFits(it, current.identity.creationAttemptId, current.identity.generationChallenge!!, listOf(enrollment)) }
                    val revision = nextRevision(current.identity.revision)
                    transaction(db) {
                        insertEnrollment(db, enrollment)
                        db.execSQL("UPDATE identity SET revision=? WHERE id=1", arrayOf(revision))
                        result = read(db)
                    }
                }
            }
        }
        checkpoint("after_close")
        paths.synchronizeDirectories()
        checkpoint("before_response")
        WitnessResult.Stored(checkNotNull(result))
    }

    fun commitGenerationStarted(expectedRevision: Long, originalAttempt: ByteArray, exactChallenge: ByteArray): WitnessResult<GenerationFence> = operation {
        val attempt = witness32(originalAttempt)
        val challenge = witness32(exactChallenge)
        val result = modify(expectedRevision) { current ->
            storageRequire(current.identity.creationAttemptId == attempt, "creation_attempt_mismatch")
            storageRequire(current.identity.phase == WitnessPhase.PREPARED, "generation_already_started")
            val write: (SQLiteDatabase, Long) -> Unit = { db, revision ->
                db.execSQL("UPDATE identity SET phase='generation_started',generation_challenge=?,revision=? WHERE id=1", arrayOf(challenge.copyBytes(), revision))
            }
            write
        }
        val fence = IssuedFence(result.identity.revision, attempt, challenge)
        issuedFences[fence] = true
        WitnessResult.Stored(fence)
    }

    fun finishOriginalGeneration(fence: GenerationFence, capturedActualMetadata: CapturedWitnessIdentity): WitnessResult<WitnessSnapshot> = operation {
        storageRequire(issuedFences.remove(fence) == true, "invalid_generation_fence")
        WitnessResult.Stored(completeOriginal(fence.revision, fence.creationAttemptId, fence.generationChallenge, capturedActualMetadata))
    }

    fun reconcileOriginalGeneration(expectedRevision: Long, originalAttempt: ByteArray, exactChallenge: ByteArray,
        capturedMetadata: CapturedWitnessIdentity): WitnessResult<WitnessSnapshot> = operation {
        WitnessResult.Stored(completeOriginal(expectedRevision, witness32(originalAttempt), witness32(exactChallenge), capturedMetadata))
    }

    fun commitBindingConsent(expectedRevision: Long, exactEnrollment: WitnessEnrollment, validatorNonce: ByteArray,
        nativeAttempt: ByteArray, nativeNonce: ByteArray, nativeSession: ByteArray): WitnessResult<ConsentRecord> = operation {
        val spent = SpentNonceRecord(witness32(validatorNonce), exactEnrollment.enrollmentId, witness32(nativeAttempt), witness32(nativeNonce), witness32(nativeSession))
        val result = modify(expectedRevision) { current ->
            storageRequire(current.identity.phase == WitnessPhase.GENERATED_UNVALIDATED, "identity_incomplete")
            storageRequire(current.enrollments.any { it == exactEnrollment }, "enrollment_mismatch")
            storageRequire(current.spentNonces.none { it.validatorNonce == spent.validatorNonce }, "validator_nonce_spent")
            storageRequire(current.spentNonces.size < 4096, "nonce_limit")
            val write: (SQLiteDatabase, Long) -> Unit = { db, revision ->
                db.execSQL("INSERT INTO spent_nonces (validator_nonce,enrollment_id,attempt_id,native_nonce,session_digest) VALUES (?,?,?,?,?)",
                    arrayOf(spent.validatorNonce.copyBytes(), spent.enrollmentId.copyBytes(), spent.attemptId.copyBytes(), spent.nativeNonce.copyBytes(), spent.sessionDigest.copyBytes()))
                db.execSQL("UPDATE identity SET revision=? WHERE id=1", arrayOf(revision))
            }
            write
        }
        WitnessResult.Stored(ConsentRecord(result.identity.revision, exactEnrollment, spent))
    }

    private class IssuedFence(override val revision: Long, override val creationAttemptId: WitnessBytes,
        override val generationChallenge: WitnessBytes) : GenerationFence

    private fun completeOriginal(expectedRevision: Long, attempt: WitnessBytes, challenge: WitnessBytes,
        metadata: CapturedWitnessIdentity): WitnessSnapshot = modify(expectedRevision) { current ->
        storageRequire(current.identity.creationAttemptId == attempt && current.identity.generationChallenge == challenge, "original_identity_mismatch")
        storageRequire(metadata.appSignerSha256 == expectedSigner, "app_signer_changed")
        requireResponseFits(metadata, attempt, challenge, current.enrollments)
        if (current.identity.phase == WitnessPhase.GENERATED_UNVALIDATED) {
            storageRequire(current.identity.metadata == metadata, "original_metadata_changed")
            null
        } else {
            storageRequire(current.identity.phase == WitnessPhase.GENERATION_STARTED, "identity_not_started")
            val write: (SQLiteDatabase, Long) -> Unit = { db, revision ->
                db.execSQL("UPDATE identity SET phase='generated_unvalidated',public_key=?,spki=?,creation_app_signer_sha256=?,creation_version_code=?,revision=? WHERE id=1",
                    arrayOf(metadata.publicKey.copyBytes(), metadata.spki.copyBytes(), metadata.appSignerSha256.copyBytes(), metadata.creationVersionCode, revision))
                metadata.certificateChain.forEachIndexed { ordinal, der ->
                    db.execSQL("INSERT INTO identity_chain (ordinal,der) VALUES (?,?)", arrayOf(ordinal, der.copyBytes()))
                }
            }
            write
        }
    }

    private fun modify(expectedRevision: Long, decision: (WitnessSnapshot) -> ((SQLiteDatabase, Long) -> Unit)?): WitnessSnapshot {
        paths.validate()
        requireExistingDatabase()
        if (lease == null) lease = acquire(false)
        val before = open(false, false).use { read(it) }
        storageRequire(before.identity.revision == expectedRevision, "stale_revision")
        if (decision(before) == null) return before
        val revision = nextRevision(expectedRevision)
        var result: WitnessSnapshot? = null
        checkpoint("before_open")
        open(true, false).use { db ->
            checkpoint("after_open")
            transaction(db) {
                val current = read(db)
                storageRequire(current.identity.revision == expectedRevision, "stale_revision")
                val write = decision(current) ?: throw WitnessStorageFailure("stale_revision")
                write(db, revision)
                result = read(db)
            }
        }
        checkpoint("after_close")
        paths.synchronizeDirectories()
        checkpoint("before_response")
        return checkNotNull(result)
    }

    override fun close() = synchronized(lifecycle) {
        if (!closed) {
            closed = true
            issuedFences.clear()
            val held = lease
            lease = null
            held?.close()
        }
    }

    private fun requireExistingDatabase() {
        storageRequire(paths.database.isFile && paths.database.length() > 0, "incomplete_store")
        // A read-only SQLite open may need recovery writes for a hot journal. Never attempt it here.
    }

    private fun acquire(create: Boolean): WitnessProcessLock.Lease = when (val result = WitnessProcessLock(paths.lock).tryAcquire(create)) {
        is WitnessProcessLock.Acquisition.Acquired -> result.lease
        WitnessProcessLock.Acquisition.Busy -> throw WitnessStorageFailure("storage_busy")
        is WitnessProcessLock.Acquisition.Refused -> throw WitnessStorageFailure(result.reason)
    }

    private fun open(write: Boolean, create: Boolean): SQLiteDatabase {
        val flags = SQLiteDatabase.NO_LOCALIZED_COLLATORS or if (write) 0 else SQLiteDatabase.OPEN_READONLY
        val builder = SQLiteDatabase.OpenParams.Builder().setOpenFlags(flags).setErrorHandler(corruptionHandler)
        if (create) builder.addOpenFlags(SQLiteDatabase.CREATE_IF_NECESSARY)
        if (write) builder.setJournalMode("DELETE").setSynchronousMode("EXTRA")
        val db = SQLiteDatabase.openDatabase(paths.database, builder.build())
        try {
            if (write) {
                storageRequire(scalarText(db, "PRAGMA journal_mode") == "delete" && scalarLong(db, "PRAGMA synchronous") == 3L, "unsafe_sqlite_mode")
                db.setForeignKeyConstraintsEnabled(true)
            }
            return db
        } catch (error: Throwable) { db.close(); throw error }
    }

    private fun transaction(db: SQLiteDatabase, change: () -> Unit) {
        checkpoint("before_begin")
        db.beginTransaction()
        try {
            checkpoint("after_begin")
            change()
            checkpoint("before_commit")
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        checkpoint("after_commit")
    }

    private fun read(db: SQLiteDatabase): WitnessSnapshot {
        storageRequire(scalarLong(db, "PRAGMA user_version") == 1L, "unknown_schema")
        val actual = mutableMapOf<String, String>()
        db.rawQuery("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name", null).use { cursor ->
            while (cursor.moveToNext()) {
                storageRequire(cursor.getString(0) == "table", "unknown_schema")
                actual[cursor.getString(1)] = cursor.getString(2)
            }
        }
        storageRequire(actual == schema, "unknown_schema")
        val identity = db.rawQuery("SELECT * FROM identity LIMIT 2", null).use { cursor ->
            storageRequire(cursor.moveToFirst(), "invalid_store")
            storageRequire(integer(cursor, "id") == 1L && text(cursor, "product") == BuildConfig.LATTICE_PRODUCT &&
                text(cursor, "app_id") == BuildConfig.LATTICE_APP_ID && integer(cursor, "profile_version") == 1L, "wrong_product")
            val attempt = witness32(blob(cursor, "creation_attempt_id"))
            val phase = WitnessPhase.entries.find { it.stored == text(cursor, "phase") } ?: throw WitnessStorageFailure("invalid_store")
            val revision = integer(cursor, "revision")
            storageRequire(revision >= 0L, "invalid_store")
            val challenge = optionalBlob(cursor, "generation_challenge")?.let { witness32(it) }
            val publicKey = optionalBlob(cursor, "public_key")
            val spki = optionalBlob(cursor, "spki")
            val signer = optionalBlob(cursor, "creation_app_signer_sha256")
            val version = optionalText(cursor, "creation_version_code")
            val chain = readChain(db)
            val metadata = if (phase == WitnessPhase.GENERATED_UNVALIDATED) {
                storageRequire(challenge != null && publicKey != null && spki != null && signer != null && version != null, "invalid_store")
                CapturedWitnessIdentity(publicKey!!, spki!!, signer!!, version!!, chain).also {
                    storageRequire(it.appSignerSha256 == expectedSigner, "app_signer_changed")
                }
            } else {
                storageRequire(publicKey == null && spki == null && signer == null && version == null && chain.isEmpty(), "invalid_store")
                storageRequire((phase == WitnessPhase.PREPARED) == (challenge == null), "invalid_store")
                null
            }
            storageRequire(!cursor.moveToNext(), "invalid_store")
            WitnessIdentityRecord(attempt, phase, challenge, metadata, revision)
        }
        val enrollments = mutableListOf<WitnessEnrollment>()
        db.rawQuery("SELECT enrollment_id,replica,CAST(replica AS BLOB) AS replica_bytes,recipient,creation_attempt_id FROM enrollments ORDER BY enrollment_id LIMIT 4097", null).use { cursor ->
            while (cursor.moveToNext()) {
                storageRequire(cursor.getType(index(cursor, "replica")) == Cursor.FIELD_TYPE_STRING, "invalid_store")
                val replica = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(blob(cursor, "replica_bytes"))).toString()
                val record = WitnessEnrollment(blob(cursor, "enrollment_id"), replica, blob(cursor, "recipient"), blob(cursor, "creation_attempt_id"))
                storageRequire(record.creationAttemptId == identity.creationAttemptId, "invalid_store")
                enrollments.add(record)
            }
        }
        storageRequire(enrollments.size in 1..4096 && enrollments.map { it.enrollmentId }.toSet().size == enrollments.size, "invalid_store")
        val ids = enrollments.map { it.enrollmentId }.toSet()
        val spent = mutableListOf<SpentNonceRecord>()
        db.rawQuery("SELECT * FROM spent_nonces ORDER BY validator_nonce LIMIT 4097", null).use { cursor ->
            while (cursor.moveToNext()) {
                val record = SpentNonceRecord(witness32(blob(cursor, "validator_nonce")), witness32(blob(cursor, "enrollment_id")),
                    witness32(blob(cursor, "attempt_id")), witness32(blob(cursor, "native_nonce")), witness32(blob(cursor, "session_digest")))
                storageRequire(record.enrollmentId in ids, "invalid_store")
                spent.add(record)
            }
        }
        storageRequire(spent.size <= 4096 && spent.map { it.validatorNonce }.toSet().size == spent.size, "invalid_store")
        storageRequire(spent.isEmpty() || identity.phase == WitnessPhase.GENERATED_UNVALIDATED, "invalid_store")
        db.rawQuery("PRAGMA foreign_key_check", null).use { storageRequire(!it.moveToFirst(), "invalid_store") }
        identity.metadata?.let { requireResponseFits(it, identity.creationAttemptId, identity.generationChallenge!!, enrollments) }
        return WitnessSnapshot(identity, enrollments, spent)
    }

    /** Private size-only projection. Placeholder bytes are neither stored, returned nor signed. */
    private fun requireResponseFits(metadata: CapturedWitnessIdentity, attempt: WitnessBytes,
        challenge: WitnessBytes, enrollments: List<WitnessEnrollment>) {
        fun base64(value: WitnessBytes) = Base64.getEncoder().encodeToString(value.copyBytes())
        val identity = JSONObject().put("version", 1).put("product", BuildConfig.LATTICE_PRODUCT)
            .put("appId", BuildConfig.LATTICE_APP_ID).put("creationAttemptId", base64(attempt))
            .put("generationChallenge", base64(challenge)).put("publicKey", base64(metadata.publicKey))
            .put("spki", base64(metadata.spki)).put("creationAppSignerSha256", base64(metadata.appSignerSha256))
            .put("creationVersionCode", metadata.creationVersionCode)
            .put("certificateChain", JSONArray(metadata.certificateChain.map { base64(it) }))
        val challengeDigest = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(challenge.copyBytes()))
        val futureFieldSize = Base64.getEncoder().encodeToString(ByteArray(32) { -1 })
        val signatureSize = Base64.getEncoder().encodeToString(ByteArray(64) { -1 })
        for (enrollment in enrollments) {
            val claim = JSONObject().put("domain", "lattice-witness-binding-challenge-v1").put("version", 1)
                .put("product", BuildConfig.LATTICE_PRODUCT).put("appId", BuildConfig.LATTICE_APP_ID)
                .put("replica", enrollment.replica).put("enrollmentId", base64(enrollment.enrollmentId))
                .put("recipient", base64(enrollment.recipient)).put("creationAttemptId", base64(attempt))
                .put("actualWitnessPublicKey", base64(metadata.publicKey)).put("generationChallengeDigest", challengeDigest)
                .put("freshValidatorNonce", futureFieldSize).put("nativeRandomNonce", futureFieldSize)
                .put("nativeCallerSessionDigest", futureFieldSize)
            val candidate = JSONObject().put("identity", identity)
                .put("binding", JSONObject().put("claim", claim).put("signature", signatureSize))
            storageRequire(candidate.toString().toByteArray(StandardCharsets.UTF_8).size <= 131072, "response_too_large")
        }
    }

    private fun readChain(db: SQLiteDatabase): List<ByteArray> {
        val chain = mutableListOf<ByteArray>()
        db.rawQuery("SELECT * FROM identity_chain ORDER BY ordinal LIMIT 9", null).use { cursor ->
            while (cursor.moveToNext()) {
                storageRequire(integer(cursor, "ordinal") == chain.size.toLong(), "invalid_store")
                chain.add(blob(cursor, "der"))
            }
        }
        return chain
    }

    private fun insertEnrollment(db: SQLiteDatabase, enrollment: WitnessEnrollment) = db.execSQL(
        "INSERT INTO enrollments (enrollment_id,replica,recipient,creation_attempt_id) VALUES (?,?,?,?)",
        arrayOf(enrollment.enrollmentId.copyBytes(), enrollment.replica, enrollment.recipient.copyBytes(), enrollment.creationAttemptId.copyBytes()))

    private fun nextRevision(current: Long): Long { storageRequire(current < Long.MAX_VALUE, "revision_exhausted"); return current + 1L }
    private fun index(cursor: Cursor, name: String) = cursor.getColumnIndexOrThrow(name)
    private fun blob(cursor: Cursor, name: String): ByteArray { val at = index(cursor, name); storageRequire(cursor.getType(at) == Cursor.FIELD_TYPE_BLOB, "invalid_store"); return cursor.getBlob(at) }
    private fun optionalBlob(cursor: Cursor, name: String): ByteArray? = if (cursor.isNull(index(cursor, name))) null else blob(cursor, name)
    private fun text(cursor: Cursor, name: String): String { val at = index(cursor, name); storageRequire(cursor.getType(at) == Cursor.FIELD_TYPE_STRING, "invalid_store"); return cursor.getString(at) }
    private fun optionalText(cursor: Cursor, name: String): String? = if (cursor.isNull(index(cursor, name))) null else text(cursor, name)
    private fun integer(cursor: Cursor, name: String): Long { val at = index(cursor, name); storageRequire(cursor.getType(at) == Cursor.FIELD_TYPE_INTEGER, "invalid_store"); return cursor.getLong(at) }
    private fun scalarText(db: SQLiteDatabase, sql: String): String = db.rawQuery(sql, null).use { storageRequire(it.moveToFirst(), "invalid_store"); it.getString(0) }
    private fun scalarLong(db: SQLiteDatabase, sql: String): Long = db.rawQuery(sql, null).use { storageRequire(it.moveToFirst(), "invalid_store"); it.getLong(0) }

    private fun <T> operation(block: () -> WitnessResult<T>): WitnessResult<T> = synchronized(lifecycle) {
        if (closed) return@synchronized WitnessResult.Refused("journal_closed")
        val future = io.submit(Callable {
            try { block() } catch (error: Exception) {
                WitnessResult.Refused(if (error is WitnessStorageFailure) error.reason else "storage_io_error")
            }
        })
        var interrupted = false
        try {
            while (true) {
                try {
                    val result = future.get()
                    return@synchronized if (interrupted) WitnessResult.Refused("storage_interrupted") else result
                } catch (_error: InterruptedException) { interrupted = true }
            }
            @Suppress("UNREACHABLE_CODE") WitnessResult.Refused("storage_io_error")
        } catch (error: ExecutionException) { throw error.cause ?: error }
        finally { if (interrupted) Thread.currentThread().interrupt() }
    }

    private companion object {
        val io = Executors.newCachedThreadPool { runnable -> Thread(runnable, "treehouse-witness-storage").apply { isDaemon = true } }
        fun bytes(name: String, width: Int, nullable: Boolean = false): String =
            "$name BLOB ${if (nullable) "" else "NOT NULL "}CHECK(${if (nullable) "$name IS NULL OR " else ""}(typeof($name)='blob' AND length($name)=$width))"
        val schema: Map<String, String> = mapOf(
            "identity" to ("CREATE TABLE identity (id INTEGER PRIMARY KEY CHECK(id=1),product TEXT NOT NULL,app_id TEXT NOT NULL,profile_version INTEGER NOT NULL CHECK(profile_version=1)," +
                bytes("creation_attempt_id", 32) + " UNIQUE,phase TEXT NOT NULL CHECK(phase IN ('prepared','generation_started','generated_unvalidated'))," +
                bytes("generation_challenge", 32, true) + "," + bytes("public_key", 32, true) + "," + bytes("spki", 44, true) + "," + bytes("creation_app_signer_sha256", 32, true) +
                ",creation_version_code TEXT,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0))"),
            "identity_chain" to "CREATE TABLE identity_chain (ordinal INTEGER PRIMARY KEY CHECK(ordinal BETWEEN 0 AND 7),der BLOB NOT NULL CHECK(typeof(der)='blob' AND length(der) BETWEEN 1 AND 16384))",
            "enrollments" to ("CREATE TABLE enrollments (" + bytes("enrollment_id", 32) + " PRIMARY KEY,replica TEXT NOT NULL CHECK(typeof(replica)='text' AND length(CAST(replica AS BLOB)) BETWEEN 1 AND 512)," +
                bytes("recipient", 32) + "," + bytes("creation_attempt_id", 32) + ",FOREIGN KEY(creation_attempt_id) REFERENCES identity(creation_attempt_id))"),
            "spent_nonces" to ("CREATE TABLE spent_nonces (" + bytes("validator_nonce", 32) + " PRIMARY KEY," + bytes("enrollment_id", 32) + "," + bytes("attempt_id", 32) + "," +
                bytes("native_nonce", 32) + "," + bytes("session_digest", 32) + ",FOREIGN KEY(enrollment_id) REFERENCES enrollments(enrollment_id))")
        )
    }
}
