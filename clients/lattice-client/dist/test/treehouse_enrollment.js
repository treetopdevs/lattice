import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { acceptTreehouseInvitation, authorCarrierOp, authorTownshipDelegation, authorTownshipRevocation, carrierDelegationsFromFrames, authorTownshipGenesis, authorTreehouseCommand, authorTreehouseAdmitAndGrant, authorTreehouseIssueInvitation, carrierOpsToSemanticOps, decodeTreehouseAcceptance, decodeTreehouseJoinRequest, decodeTreehouseOffer, encodeTreehouseAcceptance, encodeTreehouseJoinRequest, encodeTreehouseOffer, liveTreehouseDelegations, memberCapability, observeTreehouse, reviewTreehouseInvitation, signTreehouseAcceptance, treehouseCommandDecoders, treehouseCommandFields, treehouseCommandRoles, TREEHOUSE_LITE_THREAD_CAP, TREEHOUSE_OFFER_MAX_CHARS, } from "../src/index";
import { frontier } from "../src/sync";
const here = dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(readFileSync(join(here, "vectors", "treehouse_enrollment", "enrollment.json"), "utf8"));
const byName = (name) => scenarios.find((scenario) => scenario.name === name);
assert.equal(scenarios.length, 9);
// The static command-field table behind treehouseCommandRoles matches the decoders: the same commands, and
// every decoded command in the corpus writes exactly its listed fields.
for (const product of ["Treehouse.Space", "Treehouse.Thread"])
    for (const command of treehouseCommandDecoders(product).keys())
        assert.notEqual(treehouseCommandFields(product, command), null, `${product} ${command} has a field entry`);
{
    let checked = 0;
    for (const scenario of scenarios)
        for (const log of scenario.logs)
            for (const op of carrierOpsToSemanticOps(log.frames, {}, treehouseCommandDecoders(log.product)))
                if (op.kind === "command" && op.command !== undefined && op.effects !== undefined) {
                    assert.deepEqual([...new Set(op.effects.map((effect) => effect.field))].sort(), [...treehouseCommandFields(log.product, op.command)].sort(), `${log.product} ${op.command} fields`);
                    checked++;
                }
    assert(checked > 20, "the corpus exercises the decoders");
    assert.deepEqual(treehouseCommandRoles("Treehouse.Thread", "archive_thread"), ["moderator"]);
    assert.deepEqual(treehouseCommandRoles("Treehouse.Thread", "post"), []);
    assert.deepEqual(treehouseCommandRoles("Treehouse.Space", "admit_member"), ["admin"]);
}
const signerFromSeed = (text) => {
    const seed = createHash("sha256").update(text).digest();
    return { publicKey: ed25519.getPublicKey(seed), sign: (bytes) => ed25519.sign(bytes, seed) };
};
const signerFor = (scenario, realm) => signerFromSeed(scenario.seeds[realm]);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const decoders = (product) => treehouseCommandDecoders(product);
const opsOf = (product, frames) => carrierOpsToSemanticOps(frames, {}, decoders(product));
function commandOf(product, input) {
    const a = input.args;
    switch (input.command) {
        case "create_space": return { command: "create_space", name: a[0] };
        case "create_thread": return product === "Treehouse.Space" ? { command: "create_thread", threadReplica: a[0], title: a[1] } : { command: "create_thread", title: a[0] };
        case "issue_invitation": return { command: "issue_invitation", recipient: a[0], threads: a[1] };
        case "revoke_invitation": return { command: "revoke_invitation", invitationId: a[0] };
        case "admit_member": return { command: "admit_member", invitationId: a[0], recipient: a[1], level: a[2], acceptance: a[3] };
        case "post": return { command: "post", text: a[0] };
        case "author_edit": return { command: "author_edit", postId: a[0], targetId: a[1], text: a[2] };
        case "archive_thread": return { command: "archive_thread" };
    }
    throw new Error(`unmapped vector command ${input.command}`);
}
const expectedFrame = (scenario, id) => scenario.logs.flatMap((log) => log.frames).find((frame) => frame.id === id);
/** Re-author one vector step with the TS authoring primitives from the public seed and exact Sim deps. */
async function authorStep(scenario, step, authored, deps = step.deps) {
    const log = scenario.logs.find((entry) => entry.label === step.log);
    const signer = signerFor(scenario, step.realm);
    const input = step.input;
    if (input.type === "genesis") {
        return authorTownshipGenesis({ replica: log.replica, signer, ops: input.ops, roles: input.roles, live: input.live });
    }
    if (input.type === "grant") {
        return authorTownshipDelegation({ replica: log.replica, deps, audiencePubkey: input.audiencePub, parentId: input.parentId,
            ops: input.ops, roles: input.roles, live: input.live, signer });
    }
    assert.equal(input.type, "command");
    const command = commandOf(log.product, input);
    if (command.command === "admit_member") {
        // The acceptance signature is recomputed in TS. Negative vectors sign with another realm or another replica,
        // so the candidate set is every realm over the real replica and one foreign replica.
        const invitation = opsOf("Treehouse.Space", [authored.get(command.invitationId)])[0];
        const candidates = [];
        for (const replica of [log.replica, "treehouse:r13:another-space"]) {
            for (const realm of Object.keys(scenario.seeds))
                candidates.push({ replica, realm });
        }
        const match = [];
        for (const candidate of candidates) {
            const text = await acceptTreehouseInvitation(candidate.replica, invitation, signerFor(scenario, candidate.realm));
            if (text === command.acceptance)
                match.push(candidate);
        }
        assert.equal(match.length, 1, `${scenario.name}/${step.label}: acceptance is reproducible in TS`);
        if (scenario.name === "join_flow")
            assert.deepEqual(match[0], { replica: log.replica, realm: "joiner" });
    }
    return authorTreehouseCommand({ product: log.product, replica: log.replica, deps, signer, capId: step.cap, command });
}
function assertParity(frame, expected, label) {
    assert.equal(frame.id, expected.id, `${label}: op id`);
    assert.deepEqual(frame, expected, `${label}: frame bytes including signature`);
}
let replayedSteps = 0;
for (const scenario of scenarios) {
    const authored = new Map();
    for (const step of scenario.steps) {
        if (step.type === "sync")
            continue;
        const frame = await authorStep(scenario, step, authored);
        assertParity(frame, expectedFrame(scenario, step.id), `${scenario.name}/${step.label}`);
        authored.set(frame.id, frame);
        replayedSteps++;
    }
}
console.log(`PASS TS authored frame ids and bytes equal BEAM for ${replayedSteps} steps in ${scenarios.length} scenarios`);
// A dependency perturbation changes the id and fails the parity assertion.
{
    const scenario = byName("join_flow");
    const authored = new Map();
    let perturbed = 0;
    for (const step of scenario.steps) {
        if (step.type === "sync")
            continue;
        if (step.deps.length > 0 && perturbed === 0) {
            const wrong = await authorStep(scenario, step, authored, []);
            assert.notEqual(wrong.id, step.id);
            assert.throws(() => assertParity(wrong, expectedFrame(scenario, step.id), "perturbed"));
            perturbed++;
        }
        authored.set(step.id, await authorStep(scenario, step, authored));
    }
    assert.equal(perturbed, 1);
    // A changed frame byte breaks the same assertion.
    const frame = expectedFrame(scenario, scenario.steps.find((step) => step.input?.command === "post").id);
    const flipped = { ...frame, sig: b64(Buffer.alloc(64, 7)) };
    assert.throws(() => assertParity(flipped, frame, "flipped"));
    console.log("PASS a perturbed dependency or a changed signature fails the parity assertion");
}
// ---- State and verdict parity ------------------------------------------------------------------------------
const sortedKeys = (record) => Object.keys(record).sort();
for (const scenario of scenarios) {
    for (const log of scenario.logs) {
        const ops = opsOf(log.product, log.frames);
        const view = observeTreehouse(log.product, ops);
        const reasons = Object.fromEntries(view.quarantineReasons);
        assert.deepEqual(reasons, log.reasons, `${scenario.name}/${log.label}: verdict reasons`);
        assert.deepEqual(sortedKeys(Object.fromEntries(ops.filter((op) => !view.quarantineReasons.has(op.id)).map((op) => [op.id, 1]))), [...log.honored].sort(), `${scenario.name}/${log.label}: honored set`);
        assert.equal(view.operationCount, log.observed.operation_count, `${scenario.name}/${log.label}: operation count`);
        assert.deepEqual(view.posts, log.observed.posts, `${scenario.name}/${log.label}: posts`);
        const state = view.state;
        const expected = log.observed.state;
        if (log.product === "Treehouse.Thread") {
            assert.equal(state.title, expected.title);
            assert.equal(state.archived, expected.archived);
            assert.deepEqual(state.posts, expected.posts);
        }
        else {
            assert.equal(state.name, expected.name);
            assert.deepEqual([...state.members].sort(), [...expected.members].sort(), `${scenario.name}: members`);
            assert.deepEqual(state.invitations, expected.invitations, `${scenario.name}: invitations`);
            assert.deepEqual([...(state.revoked_invitations ?? [])].sort(), [...(expected.revoked_invitations ?? [])].sort());
            assert.deepEqual(state.membership_events, expected.membership_events, `${scenario.name}: membership events`);
        }
    }
}
console.log("PASS TS state, verdicts and exact quarantine reasons equal BEAM for every vector log");
// Pinned exact reasons across the negatives (BEAM reports operation_not_granted for a capability lacking the op).
{
    const scenario = byName("grantless_post");
    const reasonOf = (label) => {
        const id = scenario.steps.find((step) => step.label === label).id;
        return Object.fromEntries(observeTreehouse("Treehouse.Thread", opsOf("Treehouse.Thread", scenario.logs.find((log) => log.label === "thread:general").frames)).quarantineReasons)[id];
    };
    assert.equal(reasonOf("post without capability"), "no_capability");
    assert.equal(reasonOf("post under unknown capability"), "no_capability");
    assert.equal(reasonOf("post under capability lacking post"), "operation_not_granted");
    assert.equal(reasonOf("archive under capability lacking moderator"), "role_not_granted");
    const wrongParent = byName("wrong_parent_grant");
    const reasons = observeTreehouse("Treehouse.Thread", opsOf("Treehouse.Thread", wrongParent.logs[0].frames)).quarantineReasons;
    assert.equal(reasons.get(wrongParent.steps.find((step) => step.label === "grant with unrooted parent").id), "nongenesis_root");
    assert.equal(reasons.get(wrongParent.steps.find((step) => step.label === "post under unrooted grant").id), "invalid_capability");
    const recipient = byName("wrong_recipient_acceptance");
    const spaceReasons = observeTreehouse("Treehouse.Space", opsOf("Treehouse.Space", recipient.logs[0].frames)).quarantineReasons;
    for (const label of ["admit with other's acceptance", "admit with wrong replica acceptance", "admit naming other"]) {
        assert.equal(spaceReasons.get(recipient.steps.find((step) => step.label === label).id), "application_invalid_invitation", label);
    }
    const replay = byName("replayed_admit");
    const replayView = observeTreehouse("Treehouse.Space", opsOf("Treehouse.Space", replay.logs[0].frames));
    assert.equal(replayView.quarantineReasons.size, 0);
    assert.equal(replayView.state.members.length, 1);
    console.log("PASS exact reasons: no_capability, operation_not_granted, role_not_granted, nongenesis_root, invalid_capability, application_invalid_invitation");
}
// ---- Artifact codecs ---------------------------------------------------------------------------------------
const founderKey = byName("join_flow").pubkeys.founder;
const joinerKey = byName("join_flow").pubkeys.joiner;
const sampleRoute = { url: "ws://127.0.0.1:41001", expectedPeerRealm: "relay", expectedPeerPubkey: founderKey, replica: "treehouse:x#root:abc" };
{
    const request = encodeTreehouseJoinRequest({ publicKey: joinerKey });
    assert.match(request, /^treehouse-join-request:v1:[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeTreehouseJoinRequest(request), { publicKey: joinerKey });
    assert.equal(encodeTreehouseJoinRequest({ publicKey: joinerKey }), request, "encoding is canonical and deterministic");
    const offer = { space: "treehouse:s#root:abc", invitationId: "inv", localRealm: "joiner", routes: [sampleRoute],
        threads: [{ replica: "treehouse:t1#root:abc", archived: false }, { replica: "treehouse:t2#root:abc", archived: true }] };
    const offerText = encodeTreehouseOffer(offer);
    assert.match(offerText, /^treehouse-offer:v1:/);
    assert.deepEqual(decodeTreehouseOffer(offerText), offer);
    const acceptance = { replica: "treehouse:s#root:abc", invitationId: "inv", recipient: joinerKey, acceptance: b64(Buffer.alloc(64, 1)) };
    const acceptanceText = encodeTreehouseAcceptance(acceptance);
    assert.match(acceptanceText, /^treehouse-acceptance:v1:/);
    assert.deepEqual(decodeTreehouseAcceptance(acceptanceText), acceptance);
    const refuses = (run, reason) => assert.throws(run, (error) => error.message === reason, reason);
    const payload = (text) => JSON.parse(Buffer.from(text.slice(text.lastIndexOf(":") + 1), "base64url").toString("utf8"));
    const wrap = (prefix, value) => `${prefix}${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
    // Wrong product marker, prefix and version.
    refuses(() => decodeTreehouseOffer(wrap("treehouse-offer:v1:", { ...payload(offerText), product: "township" })), "wrong_product");
    refuses(() => decodeTreehouseOffer("township-pairing:v1:e30"), "wrong_product");
    refuses(() => decodeTreehouseOffer(request), "wrong_product");
    refuses(() => decodeTreehouseOffer("treehouse-offer:v2:e30"), "unsupported_artifact_version");
    refuses(() => decodeTreehouseOffer("not an offer"), "invalid_artifact_format");
    refuses(() => decodeTreehouseOffer(`treehouse-offer:v1:${"!".repeat(8)}`), "invalid_artifact_payload");
    // Unknown fields, missing fields, and non-canonical encodings.
    refuses(() => decodeTreehouseOffer(wrap("treehouse-offer:v1:", { ...payload(offerText), extra: "x" })), "invalid_artifact_payload");
    refuses(() => decodeTreehouseOffer(wrap("treehouse-offer:v1:", { ...payload(offerText), invitationId: undefined })), "invalid_artifact_payload");
    refuses(() => decodeTreehouseJoinRequest(wrap("treehouse-join-request:v1:", { ...payload(request), publicKey: "short" })), "invalid_artifact_payload");
    refuses(() => decodeTreehouseJoinRequest(`${request}=`), "invalid_artifact_payload");
    refuses(() => decodeTreehouseJoinRequest(wrap("treehouse-join-request:v1:", { publicKey: joinerKey, product: "treehouse", kind: "join_request", v: 1 })), "invalid_artifact_payload");
    // Secret-looking fields, at the top level and inside an opaque route entry.
    for (const key of ["seed", "privateKey", "secret", "password", "token", "bearer", "mnemonic"]) {
        refuses(() => decodeTreehouseOffer(wrap("treehouse-offer:v1:", { ...payload(offerText), [key]: "x" })), "secret_field");
        refuses(() => decodeTreehouseOffer(wrap("treehouse-offer:v1:", { ...payload(offerText), routes: [{ ...sampleRoute, [key]: "x" }] })), "secret_field");
        refuses(() => encodeTreehouseOffer({ ...offer, routes: [{ ...sampleRoute, [key]: "x" }] }), "secret_field");
    }
    // Oversize input and oversize routes.
    refuses(() => decodeTreehouseOffer(`treehouse-offer:v1:${"A".repeat(TREEHOUSE_OFFER_MAX_CHARS)}`), "artifact_too_large");
    refuses(() => encodeTreehouseOffer({ ...offer, routes: Array.from({ length: 40 }, () => sampleRoute) }), "invalid_artifact_payload");
    refuses(() => encodeTreehouseOffer({ ...offer, routes: [{ ...sampleRoute, url: "x".repeat(TREEHOUSE_OFFER_MAX_CHARS) }] }), "artifact_too_large");
    // The offer carries no key material of its own beyond public route keys.
    assert.equal(JSON.stringify(payload(offerText)).includes("sig"), false);
    console.log("PASS artifact codecs: canonical, versioned, product-marked, no unknown fields, no secret fields, bounded");
}
// ---- Capability lookup, review, issue and admit-and-grant over the vectors ---------------------------------
const joinFlow = byName("join_flow");
const framesOf = (scenario, label, until) => {
    const frames = scenario.logs.find((log) => log.label === label).frames;
    if (until === undefined)
        return frames;
    const cut = frames.findIndex((frame) => frame.id === until);
    return frames.slice(0, cut + 1);
};
const stepId = (scenario, label) => scenario.steps.find((step) => step.label === label).id;
const threadFramesJoin = framesOf(joinFlow, "thread:general");
const joinThreadReplica = joinFlow.expect.scope[0];
{
    const grantStep = joinFlow.steps.find((step) => step.label === "grant general");
    const thread = { product: "Treehouse.Thread" };
    const capability = memberCapability(threadFramesJoin, joinerKey, joinThreadReplica, thread);
    assert.equal(capability?.id, grantStep.input.delegationId);
    assert.deepEqual(capability?.ops, ["author_edit", "author_tombstone", "post"]);
    assert.equal(capability?.parent_id, joinFlow.steps.find((step) => step.label === "thread genesis").input.delegationId);
    assert.equal(memberCapability(threadFramesJoin, joinerKey, joinThreadReplica, { ...thread, command: "post" })?.id, grantStep.input.delegationId);
    assert.equal(memberCapability(threadFramesJoin, joinerKey, joinThreadReplica, { ...thread, command: "archive_thread" }), null);
    assert.equal(memberCapability(threadFramesJoin, joinerKey, "treehouse:other", thread), null);
    assert.equal(memberCapability(threadFramesJoin, byName("join_flow").pubkeys.other, joinThreadReplica, thread), null);
    // The founder resolves to its root delegation, so the lookup generalizes the issuer-root case.
    assert.equal(memberCapability(threadFramesJoin, founderKey, joinThreadReplica, { ...thread, command: "post" })?.id, joinFlow.steps.find((step) => step.label === "thread genesis").input.delegationId);
    // A quarantined grant is never offered as a capability, although the frame does carry a delegation to the joiner.
    const wrongParent = byName("wrong_parent_grant");
    const unrooted = wrongParent.logs[0];
    assert(carrierDelegationsFromFrames(unrooted.frames).some((delegation) => delegation.audience === wrongParent.pubkeys.joiner));
    assert.equal(memberCapability(unrooted.frames, wrongParent.pubkeys.joiner, unrooted.replica, thread), null);
    // A capability must carry every role its command needs: a grant of archive_thread without the moderator
    // role is never offered for archive_thread, though it still serves post, which needs no role.
    const grantless = byName("grantless_post");
    const general = grantless.logs.find((log) => log.label === "thread:general");
    const noRole = grantless.steps.find((step) => step.label === "grant archive without moderator").input.delegationId;
    assert.equal(memberCapability(general.frames, grantless.pubkeys.joiner, general.replica, { ...thread, command: "archive_thread" }), null);
    assert.equal(memberCapability(general.frames, grantless.pubkeys.joiner, general.replica, { ...thread, command: "post" })?.id, noRole);
    console.log("PASS memberCapability finds the audience's delegation and never offers a quarantined grant");
}
{
    // Review: every refusal path, against frames the BEAM vectors already classified.
    const space = joinFlow.logs.find((log) => log.label === "space");
    const inviteId = stepId(joinFlow, "invite");
    const upToInvite = framesOf(joinFlow, "space", inviteId);
    const ok = reviewTreehouseInvitation({ replica: space.replica, frames: upToInvite, invitationId: inviteId, recipient: joinerKey });
    assert.deepEqual(ok, { ok: true, invitationId: inviteId, recipient: joinerKey, threads: joinFlow.expect.scope, admitted: false });
    const full = reviewTreehouseInvitation({ replica: space.replica, frames: space.frames, invitationId: inviteId, recipient: joinerKey });
    assert.deepEqual(full, { ok: true, invitationId: inviteId, recipient: joinerKey, threads: joinFlow.expect.scope, admitted: true });
    const bad = (input, reason) => assert.deepEqual(reviewTreehouseInvitation(input), { ok: false, reason });
    bad({ replica: space.replica, frames: upToInvite, invitationId: inviteId, recipient: byName("join_flow").pubkeys.other }, "wrong_recipient");
    bad({ replica: "treehouse:r13:another-space", frames: upToInvite, invitationId: inviteId, recipient: joinerKey }, "wrong_replica");
    bad({ replica: space.replica, frames: upToInvite, invitationId: "no-such-invitation", recipient: joinerKey }, "invitation_not_found");
    bad({ replica: space.replica, frames: upToInvite, invitationId: inviteId, recipient: joinerKey, offerThreads: ["treehouse:other"] }, "offer_scope_mismatch");
    assert.equal(reviewTreehouseInvitation({ replica: space.replica, frames: upToInvite, invitationId: inviteId, recipient: joinerKey, offerThreads: joinFlow.expect.scope }).ok, true);
    bad({ replica: space.replica, frames: upToInvite.slice(0, -1), invitationId: inviteId, recipient: joinerKey }, "invitation_not_found");
    const revoked = byName("revoked_invitation");
    bad({ replica: revoked.logs[0].replica, frames: revoked.logs[0].frames, invitationId: stepId(revoked, "invite"), recipient: revoked.pubkeys.joiner }, "revoked");
    const stale = byName("scope_mismatch_after_new_thread");
    bad({ replica: stale.logs[0].replica, frames: stale.logs[0].frames, invitationId: stepId(stale, "invite"), recipient: stale.pubkeys.joiner }, "stale_scope");
    const fresh = reviewTreehouseInvitation({ replica: stale.logs[0].replica, frames: stale.logs[0].frames, invitationId: stepId(stale, "issue with fresh scope"), recipient: stale.pubkeys.joiner });
    assert.deepEqual(fresh, { ok: true, invitationId: stepId(stale, "issue with fresh scope"), recipient: stale.pubkeys.joiner, threads: stale.expect.scope, admitted: true });
    // A quarantined invitation is not reviewable (an invitation over a scope that dropped the archived Thread).
    const archived = byName("archived_thread_scope");
    bad({ replica: archived.logs[0].replica, frames: archived.logs[0].frames, invitationId: stepId(archived, "invite without archived"), recipient: archived.pubkeys.joiner }, "invitation_not_honored");
    const archivedOk = reviewTreehouseInvitation({ replica: archived.logs[0].replica, frames: archived.logs[0].frames, invitationId: stepId(archived, "invite"), recipient: archived.pubkeys.joiner });
    assert.equal(archivedOk.ok && archivedOk.threads.length, 2);
    assert.deepEqual(archivedOk.ok && archivedOk.threads, archived.expect.scope, "the archived Thread stays in the signed scope");
    console.log("PASS review refuses wrong recipient, wrong replica, unknown, stale scope, revoked, offer mismatch and reports scope with archived Threads");
}
{
    // Admit and grant from the pre-admit state reproduces the BEAM admit and grant frames byte for byte.
    const scenario = byName("archived_thread_scope");
    const space = scenario.logs.find((log) => log.label === "space");
    const inviteId = stepId(scenario, "invite");
    const spaceFrames = framesOf(scenario, "space", inviteId);
    const threadFrames = {};
    const live = scenario.logs.find((log) => log.label === "thread:live");
    const archivedLog = scenario.logs.find((log) => log.label === "thread:archived");
    threadFrames[live.replica] = framesOf(scenario, "thread:live", stepId(scenario, "title live"));
    threadFrames[archivedLog.replica] = framesOf(scenario, "thread:archived", stepId(scenario, "archive"));
    const joiner = signerFor(scenario, "joiner");
    const acceptance = await signTreehouseAcceptance({ replica: space.replica, frames: spaceFrames, invitationId: inviteId, signer: joiner });
    assert.deepEqual(acceptance, { replica: space.replica, invitationId: inviteId, recipient: scenario.pubkeys.joiner,
        acceptance: scenario.steps.find((step) => step.label === "admit").input.args[3] });
    const founder = signerFor(scenario, "founder");
    const result = await authorTreehouseAdmitAndGrant({ signer: founder, replica: space.replica, frames: spaceFrames, threadFrames, acceptance });
    assertParity(result.admit, expectedFrame(scenario, stepId(scenario, "admit")), "admit");
    assert.equal(result.grants.length, 2);
    assert.deepEqual(result.grants.map((grant) => grant.replica), [...scenario.expect.scope].sort());
    for (const grant of result.grants) {
        const label = grant.replica === live.replica ? "grant live" : "grant archived";
        assertParity(grant.frame, expectedFrame(scenario, stepId(scenario, label)), label);
        assert.equal(grant.delegation.id, scenario.steps.find((step) => step.label === label).input.delegationId);
    }
    // Replay after the admit and grants landed authors nothing new: the resume path is idempotent.
    const landedSpace = [...spaceFrames, result.admit];
    const landedThreads = Object.fromEntries(Object.entries(threadFrames).map(([replica, frames]) => [replica, [...frames, result.grants.find((grant) => grant.replica === replica).frame]]));
    const again = await authorTreehouseAdmitAndGrant({ signer: founder, replica: space.replica, frames: landedSpace, threadFrames: landedThreads, acceptance });
    assert.equal(again.admit, null);
    assert.deepEqual(again.grants, []);
    // Admit landed but one grant is missing: only the missing grant is authored.
    const partial = await authorTreehouseAdmitAndGrant({ signer: founder, replica: space.replica, frames: landedSpace,
        threadFrames: { ...landedThreads, [archivedLog.replica]: threadFrames[archivedLog.replica] }, acceptance });
    assert.equal(partial.admit, null);
    assert.deepEqual(partial.grants.map((grant) => grant.replica), [archivedLog.replica]);
    // An honored grant that carries post but not author_edit and author_tombstone does not satisfy the skip:
    // the full member grant is still authored for that Thread.
    const liveFrames = landedThreads[live.replica].filter((frame) => frame.id !== result.grants.find((grant) => grant.replica === live.replica).frame.id);
    const root = carrierDelegationsFromFrames(liveFrames).find((delegation) => delegation.audience === scenario.pubkeys.founder && delegation.ops.includes("post"));
    const postOnly = await authorTownshipDelegation({ replica: live.replica, deps: frontier(carrierOpsToSemanticOps(liveFrames, {}, treehouseCommandDecoders("Treehouse.Thread"))),
        audiencePubkey: scenario.pubkeys.joiner, parentId: root.id, ops: ["post"], roles: [], live: false, signer: founder });
    const narrow = await authorTreehouseAdmitAndGrant({ signer: founder, replica: space.replica, frames: landedSpace,
        threadFrames: { ...landedThreads, [live.replica]: [...liveFrames, postOnly] }, acceptance });
    assert.deepEqual(narrow.grants.map((grant) => grant.replica), [live.replica]);
    assert.deepEqual([...narrow.grants[0].delegation.ops].sort(), ["author_edit", "author_tombstone", "post"]);
    // Refusals: wrong recipient's acceptance, missing Thread history, a foreign signer.
    const other = signerFor(scenario, "other");
    const forged = b64(await other.sign(new Uint8Array([1])));
    await assert.rejects(() => authorTreehouseAdmitAndGrant({ signer: founder, replica: space.replica, frames: spaceFrames, threadFrames,
        acceptance: { ...acceptance, acceptance: forged } }), /invalid_acceptance/);
    await assert.rejects(() => authorTreehouseAdmitAndGrant({ signer: founder, replica: space.replica, frames: spaceFrames, threadFrames,
        acceptance: { ...acceptance, recipient: scenario.pubkeys.other } }), /wrong_recipient/);
    await assert.rejects(() => authorTreehouseAdmitAndGrant({ signer: founder, replica: "treehouse:r13:another-space", frames: spaceFrames, threadFrames, acceptance }), /wrong_replica/);
    await assert.rejects(() => authorTreehouseAdmitAndGrant({ signer: founder, replica: space.replica, frames: spaceFrames,
        threadFrames: { [live.replica]: threadFrames[live.replica] }, acceptance }), /thread_not_available/);
    await assert.rejects(() => authorTreehouseAdmitAndGrant({ signer: other, replica: space.replica, frames: spaceFrames, threadFrames, acceptance }), /no_capability/);
    console.log("PASS admit-and-grant reproduces BEAM admit and per-Thread grants (archived included), resumes idempotently, and refuses bad input");
}
// ---- Founder and joiner end to end in TS, issue guard and the route cap ------------------------------------
const founderSigner = signerFromSeed("treehouse-ts-enrollment:founder");
const joinerSigner = signerFromSeed("treehouse-ts-enrollment:joiner");
const joinerPub = b64(joinerSigner.publicKey);
const spaceOps = ["create_space", "create_thread", "issue_invitation", "revoke_invitation", "admit_member", "remove_member"];
const threadOps = ["create_thread", "post", "author_edit", "author_tombstone", "moderator_tombstone", "archive_thread"];
async function founderWorld(threadCount, archive = []) {
    const genesis = await authorTownshipGenesis({ replica: "treehouse:ts-enroll:space", signer: founderSigner, ops: spaceOps, roles: ["admin", "moderator"] });
    const spaceCap = genesis.body[1][1][1].id;
    let tip = genesis;
    const frames = [genesis];
    const push = async (command) => {
        tip = await authorTreehouseCommand({ product: "Treehouse.Space", replica: genesis.replica, deps: [tip.id], signer: founderSigner, capId: spaceCap, command });
        frames.push(tip);
    };
    await push({ command: "create_space", name: "Canopy" });
    const threads = {};
    const routes = [];
    for (let n = 0; n < threadCount; n++) {
        const threadGenesis = await authorTownshipGenesis({ replica: `treehouse:ts-enroll:thread${n}`, signer: founderSigner, ops: threadOps, roles: ["moderator"] });
        const cap = threadGenesis.body[1][1][1].id;
        const title = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: threadGenesis.replica, deps: [threadGenesis.id], signer: founderSigner, capId: cap, command: { command: "create_thread", title: `T${n}` } });
        threads[threadGenesis.replica] = [threadGenesis, title];
        if (archive.includes(n)) {
            const archived = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: threadGenesis.replica, deps: [title.id], signer: founderSigner, capId: cap, command: { command: "archive_thread" } });
            threads[threadGenesis.replica].push(archived);
        }
        routes.push({ replica: threadGenesis.replica });
        await push({ command: "create_thread", threadReplica: threadGenesis.replica, title: `T${n}` });
    }
    return { replica: genesis.replica, frames, threads, routes };
}
{
    const world = await founderWorld(3, [1]);
    const spaceRoute = { replica: world.replica };
    const issued = await authorTreehouseIssueInvitation({ signer: founderSigner, replica: world.replica, frames: world.frames, threadFrames: world.threads,
        routes: [spaceRoute, ...world.routes], recipient: joinerPub });
    assert.equal(issued.threads.length, 3);
    assert.deepEqual(issued.threads.map((thread) => thread.archived), [false, true, false].map((_, i) => i === 1));
    assert.deepEqual(issued.threads.map((thread) => thread.replica), [...world.routes.map((route) => route.replica)].sort());
    const spaceFrames = [...world.frames, issued.frame];
    const reviewed = reviewTreehouseInvitation({ replica: world.replica, frames: spaceFrames, invitationId: issued.frame.id, recipient: joinerPub, offerThreads: issued.threads.map((thread) => thread.replica) });
    assert.equal(reviewed.ok, true);
    const acceptance = await signTreehouseAcceptance({ replica: world.replica, frames: spaceFrames, invitationId: issued.frame.id, signer: joinerSigner });
    const admitted = await authorTreehouseAdmitAndGrant({ signer: founderSigner, replica: world.replica, frames: spaceFrames, threadFrames: world.threads, acceptance });
    assert.equal(admitted.grants.length, 3);
    const landedSpace = [...spaceFrames, admitted.admit];
    const view = observeTreehouse("Treehouse.Space", opsOf("Treehouse.Space", landedSpace));
    assert.equal(view.quarantineReasons.size, 0);
    assert.deepEqual(view.state.members, [joinerPub]);
    // The joiner posts to every Thread (the archived one is quarantined for the archive, not for authority).
    for (const grant of admitted.grants) {
        const frames = [...world.threads[grant.replica], grant.frame];
        const cap = memberCapability(frames, joinerPub, grant.replica, { command: "post", product: "Treehouse.Thread" });
        assert.equal(cap?.id, grant.delegation.id);
        const post = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: grant.replica, deps: frontier(opsOf("Treehouse.Thread", frames)),
            signer: joinerSigner, capId: cap.id, command: { command: "post", text: "hello" } });
        const after = observeTreehouse("Treehouse.Thread", opsOf("Treehouse.Thread", [...frames, post]));
        const archived = world.threads[grant.replica].length === 3;
        assert.equal(after.quarantineReasons.get(post.id), archived ? "application_archived_thread" : undefined);
        assert.equal(after.posts.length, archived ? 0 : 1);
    }
    // A revoked grant is never offered, although its own frame stays honored, and replaying admit-and-grant
    // refuses it. The reducer confirms the revoke is effective: a post under the old grant is revoked_capability.
    const revokedGrant = admitted.grants.find((grant) => world.threads[grant.replica].length !== 3);
    const grantedFrames = [...world.threads[revokedGrant.replica], revokedGrant.frame];
    const revoke = await authorTownshipRevocation({ replica: revokedGrant.replica, deps: frontier(opsOf("Treehouse.Thread", grantedFrames)),
        signer: founderSigner, delegationId: revokedGrant.delegation.id });
    const revokedFrames = [...grantedFrames, revoke];
    assert.equal(observeTreehouse("Treehouse.Thread", opsOf("Treehouse.Thread", revokedFrames)).quarantineReasons.has(revokedGrant.frame.id), false);
    assert.equal(memberCapability(revokedFrames, joinerPub, revokedGrant.replica, { command: "post", product: "Treehouse.Thread" }), null);
    const stalePost = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: revokedGrant.replica, deps: frontier(opsOf("Treehouse.Thread", revokedFrames)),
        signer: joinerSigner, capId: revokedGrant.delegation.id, command: { command: "post", text: "late" } });
    assert.equal(observeTreehouse("Treehouse.Thread", opsOf("Treehouse.Thread", [...revokedFrames, stalePost])).quarantineReasons.get(stalePost.id), "revoked_capability");
    const regrantThreads = Object.fromEntries(admitted.grants.map((grant) => [grant.replica, grant.replica === revokedGrant.replica ? revokedFrames : [...world.threads[grant.replica], grant.frame]]));
    await assert.rejects(() => authorTreehouseAdmitAndGrant({ signer: founderSigner, replica: world.replica, frames: landedSpace, threadFrames: regrantThreads, acceptance }), /grant_revoked/);
    // A member removed after admission is not re-admitted by replaying the same invitation.
    const removeCap = memberCapability(landedSpace, founderSigner.publicKey, world.replica, { command: "remove_member", product: "Treehouse.Space" });
    const removal = await authorTreehouseCommand({ product: "Treehouse.Space", replica: world.replica, deps: frontier(opsOf("Treehouse.Space", landedSpace)),
        signer: founderSigner, capId: removeCap.id, command: { command: "remove_member", recipient: joinerPub } });
    const removedSpace = [...landedSpace, removal];
    assert.deepEqual(observeTreehouse("Treehouse.Space", opsOf("Treehouse.Space", removedSpace)).state.members, []);
    assert.deepEqual(reviewTreehouseInvitation({ replica: world.replica, frames: removedSpace, invitationId: issued.frame.id, recipient: joinerPub }), { ok: false, reason: "member_removed" });
    await assert.rejects(() => authorTreehouseAdmitAndGrant({ signer: founderSigner, replica: world.replica, frames: removedSpace, threadFrames: regrantThreads, acceptance }), /member_removed/);
    console.log("PASS TS founder issues, joiner accepts, founder admits and grants, joiner posts under the member capability");
    console.log("PASS a revoked grant is never offered or silently re-issued; a removed member is not re-admitted by replay");
    // A leased grant is offered until a valid root beacon passes its epoch, and never after. The reducer
    // confirms the lapse: a post under it after the beacon is lease_expired.
    const leaseThread = revokedGrant.replica;
    const leaseBase = world.threads[leaseThread];
    const leaseHolder = signerFromSeed("treehouse-ts-enrollment:lease-holder");
    const leaseRoot = carrierDelegationsFromFrames(leaseBase).find((delegation) => delegation.parent_id === null);
    const leased = await authorTownshipDelegation({ replica: leaseThread, deps: frontier(opsOf("Treehouse.Thread", leaseBase)),
        audiencePubkey: leaseHolder.publicKey, parentId: leaseRoot.id, ops: ["post"], roles: [], live: false, expiresEpoch: 3, signer: founderSigner });
    const leasedFrames = [...leaseBase, leased];
    const leasedId = carrierDelegationsFromFrames([leased])[0].id;
    assert.equal(memberCapability(leasedFrames, leaseHolder.publicKey, leaseThread, { command: "post", product: "Treehouse.Thread" })?.id, leasedId);
    const beacon = await authorCarrierOp({ replica: leaseThread, deps: frontier(opsOf("Treehouse.Thread", leasedFrames)), kind: "authority",
        body: ["tuple", [["atom", "beacon"], ["int", 5]]], cap: ["nil"], signer: founderSigner });
    const lapsedFrames = [...leasedFrames, beacon];
    assert.equal(observeTreehouse("Treehouse.Thread", opsOf("Treehouse.Thread", lapsedFrames)).quarantineReasons.has(beacon.id), false, "the beacon is valid");
    assert.equal(memberCapability(lapsedFrames, leaseHolder.publicKey, leaseThread, { command: "post", product: "Treehouse.Thread" }), null);
    assert.equal(liveTreehouseDelegations("Treehouse.Thread", lapsedFrames, leaseThread).some((delegation) => delegation.id === leasedId), false);
    const latePost = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: leaseThread, deps: frontier(opsOf("Treehouse.Thread", lapsedFrames)),
        signer: leaseHolder, capId: leasedId, command: { command: "post", text: "late" } });
    assert.equal(observeTreehouse("Treehouse.Thread", opsOf("Treehouse.Thread", [...lapsedFrames, latePost])).quarantineReasons.get(latePost.id), "lease_expired");
    console.log("PASS a leased grant is never offered once a valid beacon passes its epoch");
    // A delegation-shaped term nested inside a signed but inert authority body is not authority evidence: it
    // never counts as a member grant, so it cannot suppress the real grant, and it is never offered.
    const inertThread = admitted.grants.find((grant) => grant.replica !== revokedGrant.replica).replica;
    const inertBase = world.threads[inertThread];
    const unpublished = await authorTownshipDelegation({ replica: inertThread, deps: frontier(opsOf("Treehouse.Thread", inertBase)),
        audiencePubkey: joinerPub, parentId: carrierDelegationsFromFrames(inertBase).find((delegation) => delegation.parent_id === null).id,
        ops: ["post", "author_edit", "author_tombstone"], roles: [], live: false, signer: founderSigner });
    const findDelegationTerm = (term) => term?.[0] === "delegation" ? term
        : Array.isArray(term?.[1]) ? term[1].map(findDelegationTerm).find(Boolean) : undefined;
    const inert = await authorCarrierOp({ replica: inertThread, deps: frontier(opsOf("Treehouse.Thread", inertBase)), kind: "authority",
        body: ["tuple", [["atom", "note"], findDelegationTerm(unpublished.body)]], cap: ["nil"], signer: founderSigner });
    const inertFrames = [...inertBase, inert];
    assert.equal(carrierDelegationsFromFrames([inert]).length, 1, "the nested term is delegation-shaped");
    assert.equal(memberCapability(inertFrames, joinerPub, inertThread, { command: "post", product: "Treehouse.Thread" }), null);
    const inertThreads = Object.fromEntries(Object.entries(world.threads).map(([replica, frames]) => [replica, replica === inertThread ? inertFrames : frames]));
    const throughInert = await authorTreehouseAdmitAndGrant({ signer: founderSigner, replica: world.replica, frames: spaceFrames, threadFrames: inertThreads, acceptance });
    assert(throughInert.grants.some((grant) => grant.replica === inertThread), "the real grant is still authored");
    console.log("PASS a delegation nested in an inert authority body is never treated as a grant");
}
{
    // Route cap and missing routes.
    const four = await founderWorld(4);
    const refuse = (promise, reason) => assert.rejects(promise, (error) => error.message === reason);
    assert.equal(TREEHOUSE_LITE_THREAD_CAP, 3);
    await refuse(authorTreehouseIssueInvitation({ signer: founderSigner, replica: four.replica, frames: four.frames, threadFrames: four.threads,
        routes: [{ replica: four.replica }, ...four.routes], recipient: joinerPub }), "thread_scope_exceeds_routes");
    const archivedFour = await founderWorld(4, [0, 1, 2, 3]);
    await refuse(authorTreehouseIssueInvitation({ signer: founderSigner, replica: archivedFour.replica, frames: archivedFour.frames, threadFrames: archivedFour.threads,
        routes: [{ replica: archivedFour.replica }, ...archivedFour.routes], recipient: joinerPub }), "thread_scope_exceeds_routes");
    const three = await founderWorld(3);
    await refuse(authorTreehouseIssueInvitation({ signer: founderSigner, replica: three.replica, frames: three.frames, threadFrames: three.threads,
        routes: [{ replica: three.replica }, ...three.routes.slice(1)], recipient: joinerPub }), "thread_scope_exceeds_routes");
    await refuse(authorTreehouseIssueInvitation({ signer: founderSigner, replica: three.replica, frames: three.frames, threadFrames: three.threads,
        routes: [{ replica: three.replica }, ...three.routes], recipient: "not-a-key" }), "invalid_recipient");
    await refuse(authorTreehouseIssueInvitation({ signer: founderSigner, replica: three.replica, frames: three.frames, threadFrames: {},
        routes: [{ replica: three.replica }, ...three.routes], recipient: joinerPub }), "thread_not_available");
    await refuse(authorTreehouseIssueInvitation({ signer: joinerSigner, replica: three.replica, frames: three.frames, threadFrames: three.threads,
        routes: [{ replica: three.replica }, ...three.routes], recipient: joinerPub }), "no_capability");
    // The BEAM vector shows the domain itself honors a four Thread scope. The cap is a shell-lite refusal.
    const cap = byName("four_thread_cap");
    assert.equal(cap.expect.liteRouteCap, TREEHOUSE_LITE_THREAD_CAP);
    assert.equal(cap.expect.liteRefusal, "thread_scope_exceeds_routes");
    assert.equal(cap.expect.honoredThreads, 4);
    console.log("PASS an invitation over the route cap, or without a route for a Thread in scope, refuses thread_scope_exceeds_routes");
}
// Wrong inputs authored through the public seam, bypassing local refusal, quarantine with the BEAM reasons.
{
    const world = await founderWorld(1);
    const threadReplica = world.routes[0].replica;
    const grantless = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: threadReplica, deps: frontier(opsOf("Treehouse.Thread", world.threads[threadReplica])),
        signer: joinerSigner, capId: null, command: { command: "post", text: "no capability" } });
    const view = observeTreehouse("Treehouse.Thread", opsOf("Treehouse.Thread", [...world.threads[threadReplica], grantless]));
    assert.equal(view.quarantineReasons.get(grantless.id), "no_capability");
    console.log("PASS a grantless joiner post quarantines no_capability");
}
console.log("PASS treehouse enrollment module");
