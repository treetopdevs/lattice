import assert from "node:assert/strict";
import { assembleWitnessedSuccessionArtifact, exportWitnessedSuccessionArtifactJson, } from "../src/index";
console.log("\n▸ witnessed succession artifact contract");
const claim = {
    version: 1,
    replica: "replica:matter:succession-witness-artifact",
    role: "clerk",
    holder: "mCaZpMJ0SU2lf3v2ljw0D05Px4pmoY1jUIIVv19hmZ4=",
    holderEpoch: "SJMi-K8IUPUvtk3zYRUVMeska-KcUvNT_8oPWTlKDAI",
    successor: "DBY121cVb1O+BdK+NucwFZyZtUTdrPpxhnZ2Wg41jjY=",
    policyId: "7vxBnpmtE9EdrlqMZWah5D7rTHs47sGHwTy-Kytnzj8",
};
const witness = "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
const signature = "/T0CLPi87WYjXxaE8A8/vD6N+oJS/ojb6stGalPA3frPZTJhg8gTuB7prrK+UXjotDjlg9hlNVkhqjkF9mV2Bw==";
const artifactId = "bwOAXkuFI7Vfez1nEtZ0FJmr1GBrowaZuryrVUCRt7k";
const artifact = assembleWitnessedSuccessionArtifact(claim, { witness, signature });
assert.deepEqual(artifact, {
    v: 1,
    artifactId,
    claim,
    witness,
    signature,
});
assert.equal(exportWitnessedSuccessionArtifactJson(artifact), `{"v":1,"artifactId":"${artifactId}","claim":{"version":1,"replica":"${claim.replica}","role":"clerk","holder":"${claim.holder}","holderEpoch":"${claim.holderEpoch}","successor":"${claim.successor}","policyId":"${claim.policyId}"},"witness":"${witness}","signature":"${signature}"}`);
const reorderedClaim = {
    policyId: claim.policyId,
    successor: claim.successor,
    holderEpoch: claim.holderEpoch,
    holder: claim.holder,
    role: claim.role,
    replica: claim.replica,
    version: claim.version,
};
assert.equal(exportWitnessedSuccessionArtifactJson(assembleWitnessedSuccessionArtifact(reorderedClaim, { signature, witness })), exportWitnessedSuccessionArtifactJson(artifact));
for (const malformed of [
    { ...claim, unexpected: "field" },
    { ...claim, version: 2 },
    { ...claim, role: "resident" },
    { ...claim, replica: "" },
    { ...claim, holder: claim.holder.slice(0, -1) },
    { ...claim, holderEpoch: `${claim.holderEpoch}=` },
    { ...claim, policyId: `${claim.policyId.slice(0, -1)}+` },
]) {
    assert.throws(() => assembleWitnessedSuccessionArtifact(malformed, { witness, signature }));
}
for (const malformedSignature of [
    { witness: Buffer.alloc(31, 7).toString("base64"), signature },
    { witness, signature: Buffer.alloc(63, 7).toString("base64") },
]) {
    assert.throws(() => assembleWitnessedSuccessionArtifact(claim, malformedSignature));
}
console.log("\x1b[32m✓ witnessed succession artifact contract passed\x1b[0m");
