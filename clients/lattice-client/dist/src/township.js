import { authorCarrierDelegation, authorCarrierOp, canonicalBase64Bytes, canonicalHash } from "./codec";
import { carrierDelegationsFromFrames, carrierOpsToSemanticOps } from "./carrier";
import { frontier } from "./sync";
export function townshipCommandBody(command) {
    switch (command.command) {
        case "set_title":
        case "set_summary":
        case "post":
            return commandBody(command.command, [command.text]);
        case "admit":
        case "remove_member":
            return commandBody(command.command, [command.member]);
        case "close_matter":
        case "reopen_matter":
            return commandBody(command.command, []);
    }
}
export function townshipCapTerm(capId) {
    return capId === null ? ["nil"] : ["bin", textBase64(capId)];
}
export function townshipGrantBody(delegation) {
    return ["tuple", [["atom", "grant"], ["delegation", delegation]]];
}
export function townshipGenesisBody(delegation, policies = {}) {
    return ["tuple", [["atom", "genesis"], ["delegation", delegation], townshipGenesisPoliciesTerm(policies)]];
}
export function townshipRevokeBody(delegationId) {
    return ["tuple", [["atom", "revoke"], ["bin", textBase64(delegationId)]]];
}
export function selectTownshipCapId(command, delegations, audiencePubkey) {
    const audience = typeof audiencePubkey === "string" ? audiencePubkey : bytesBase64(audiencePubkey);
    const role = townshipCommandRole(command.command);
    const delegation = delegations.find((candidate) => {
        if (candidate.audience !== audience)
            return false;
        if (!candidate.ops.includes(command.command))
            return false;
        return role === null || candidate.roles.includes(role);
    });
    return delegation?.id ?? null;
}
export function selectTownshipDelegationParentId(delegations, issuerPubkey, options = {}) {
    const issuer = typeof issuerPubkey === "string" ? issuerPubkey : bytesBase64(issuerPubkey);
    const neededOps = new Set(options.ops ?? []);
    const neededRoles = new Set(options.roles ?? []);
    const neededLive = options.live ?? false;
    const delegation = delegations.find((candidate) => {
        if (candidate.audience !== issuer)
            return false;
        if (options.replica !== undefined && candidate.replica !== options.replica)
            return false;
        if (neededLive && !candidate.live)
            return false;
        if (!setSubset(neededOps, candidate.ops))
            return false;
        return setSubset(neededRoles, candidate.roles);
    });
    return delegation?.id ?? null;
}
export function authorTownshipCommand(input) {
    return authorCarrierOp({
        replica: input.replica,
        deps: input.deps,
        kind: "command",
        body: townshipCommandBody(input.command),
        cap: townshipCapTerm(input.capId),
        signer: input.signer,
    });
}
export function authorTownshipCommandFromLog(input) {
    return authorTownshipCommand({
        replica: input.replica,
        deps: frontier(input.localOps),
        command: input.command,
        capId: input.capId,
        signer: input.signer,
    });
}
export async function authorTownshipDelegation(input) {
    const delegationInput = {
        replica: input.replica,
        audiencePubkey: input.audiencePubkey,
        signer: input.signer,
    };
    if (input.parentId !== undefined)
        delegationInput.parentId = input.parentId;
    if (input.ops !== undefined)
        delegationInput.ops = input.ops;
    if (input.roles !== undefined)
        delegationInput.roles = input.roles;
    if (input.live !== undefined)
        delegationInput.live = input.live;
    if (input.expiresEpoch !== undefined)
        delegationInput.expiresEpoch = input.expiresEpoch;
    const delegation = await authorCarrierDelegation(delegationInput);
    return authorCarrierOp({
        replica: input.replica,
        deps: input.deps,
        kind: "authority",
        body: townshipGrantBody(delegation),
        cap: ["nil"],
        signer: input.signer,
    });
}
export async function authorTownshipGenesis(input) {
    const commitment = townshipReplicaCommitment(input.replica);
    if (commitment !== null && commitment !== await townshipReplicaRootTag(input.signer.publicKey)) {
        throw new Error("genesis signer does not match the bound replica root");
    }
    const replica = commitment === null
        ? await bindTownshipReplica(input.replica, input.signer.publicKey)
        : input.replica;
    const delegationInput = {
        replica,
        audiencePubkey: input.signer.publicKey,
        parentId: null,
        live: input.live ?? true,
        signer: input.signer,
    };
    if (input.ops !== undefined)
        delegationInput.ops = input.ops;
    if (input.roles !== undefined)
        delegationInput.roles = input.roles;
    const delegation = await authorCarrierDelegation(delegationInput);
    return authorCarrierOp({
        replica,
        deps: [],
        kind: "authority",
        body: townshipGenesisBody(delegation, input.policies),
        cap: ["nil"],
        signer: input.signer,
    });
}
export function authorTownshipRevocation(input) {
    return authorCarrierOp({
        replica: input.replica,
        deps: input.deps,
        kind: "authority",
        body: townshipRevokeBody(input.delegationId),
        cap: ["nil"],
        signer: input.signer,
    });
}
export async function bindTownshipReplica(replica, rootPubkey) {
    if (replica.includes("#root:"))
        throw new Error("replica name already contains reserved #root: marker");
    return `${replica}#root:${await townshipReplicaRootTag(rootPubkey)}`;
}
export function townshipReplicaCommitment(replica) {
    const marker = "#root:";
    const offset = replica.indexOf(marker);
    if (offset === -1)
        return null;
    const commitment = replica.slice(offset + marker.length);
    return /^[A-Za-z0-9_-]{43}$/.test(commitment) ? commitment : null;
}
export function townshipReplicaRootTag(rootPubkey) {
    return canonicalHash(pubkeyBytes(rootPubkey));
}
export async function authorAndPersistTownshipCommand(input) {
    const [localOps, delegationFrames] = await Promise.all([
        input.localLog.load(),
        loadAuthorDelegationFrames(input),
    ]);
    const capId = selectTownshipCapId(input.command, carrierDelegationsFromFrames(delegationFrames), input.signer.publicKey);
    if (capId === null)
        throw new Error(`no local delegation authorizes ${input.command.command}`);
    const frame = await authorTownshipCommandFromLog({
        replica: input.replica,
        localOps,
        command: input.command,
        capId,
        signer: input.signer,
    });
    const op = carrierOpsToSemanticOps([frame], input.realmByPubkey)[0];
    if (!op)
        throw new Error(`authored carrier frame ${frame.id} did not produce a semantic op`);
    await input.localLog.append(op);
    await input.carrierFrames.append(frame);
    return { frame, op, capId };
}
export async function authorAndPersistTownshipDelegation(input) {
    const [localOps, delegationFrames] = await Promise.all([
        input.localLog.load(),
        loadAuthorDelegationFrames(input),
    ]);
    const parentOptions = { replica: input.replica };
    if (input.ops !== undefined)
        parentOptions.ops = input.ops;
    if (input.roles !== undefined)
        parentOptions.roles = input.roles;
    if (input.live !== undefined)
        parentOptions.live = input.live;
    const parentId = input.parentId === undefined
        ? selectTownshipDelegationParentId(carrierDelegationsFromFrames(delegationFrames), input.signer.publicKey, parentOptions)
        : input.parentId;
    if (parentId === null)
        throw new Error("no local delegation authorizes grant");
    const delegationInput = {
        replica: input.replica,
        deps: frontier(localOps),
        audiencePubkey: input.audiencePubkey,
        parentId,
        signer: input.signer,
    };
    if (input.ops !== undefined)
        delegationInput.ops = input.ops;
    if (input.roles !== undefined)
        delegationInput.roles = input.roles;
    if (input.live !== undefined)
        delegationInput.live = input.live;
    if (input.expiresEpoch !== undefined)
        delegationInput.expiresEpoch = input.expiresEpoch;
    const frame = await authorTownshipDelegation(delegationInput);
    const op = carrierOpsToSemanticOps([frame], input.realmByPubkey)[0];
    if (!op)
        throw new Error(`authored carrier frame ${frame.id} did not produce a semantic op`);
    const delegation = carrierDelegationsFromFrames([frame])[0];
    if (!delegation)
        throw new Error(`authored carrier frame ${frame.id} did not contain a delegation`);
    await input.localLog.append(op);
    await input.carrierFrames.append(frame);
    await input.delegationFrames?.append(frame);
    return { frame, op, delegation, parentId };
}
async function loadAuthorDelegationFrames(input) {
    if (!input.delegationFrames)
        return input.carrierFrames.load();
    const delegationFrames = await input.delegationFrames.load();
    if (delegationFrames.length > 0)
        return delegationFrames;
    return input.carrierFrames.load();
}
function townshipCommandRole(command) {
    switch (command) {
        case "close_matter":
        case "reopen_matter":
            return "clerk";
        case "set_title":
        case "set_summary":
        case "post":
        case "admit":
        case "remove_member":
            return null;
    }
}
function commandBody(command, args) {
    return [
        "tuple",
        [
            ["atom", command],
            ["list", args.map((arg) => ["bin", textBase64(arg)])],
        ],
    ];
}
function townshipGenesisPoliciesTerm(policies) {
    return [
        "map",
        Object.entries(policies)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([role, policy]) => {
            if ("mode" in policy) {
                if (role !== "__beacon__")
                    throw new Error("witnessed beacon policy requires __beacon__ key");
                return [
                    ["atom", role],
                    [
                        "map",
                        [
                            [
                                ["atom", "mode"],
                                ["atom", policy.mode],
                            ],
                            [
                                ["atom", "version"],
                                ["int", policy.version],
                            ],
                            [
                                ["atom", "witnesses"],
                                [
                                    "list",
                                    policy.witnesses.map((key) => ["bin", pubkeyBase64(key)]),
                                ],
                            ],
                            [
                                ["atom", "threshold"],
                                ["int", policy.threshold],
                            ],
                            [
                                ["atom", "max_epoch_step"],
                                ["int", policy.maxEpochStep],
                            ],
                        ],
                    ],
                ];
            }
            return [
                ["atom", role],
                [
                    "map",
                    [
                        [
                            ["atom", "successor"],
                            ["bin", pubkeyBase64(policy.successorPubkey)],
                        ],
                        [
                            ["atom", "dormant_ticks"],
                            ["int", policy.dormantTicks],
                        ],
                    ],
                ],
            ];
        }),
    ];
}
function textBase64(value) {
    return bytesBase64(new TextEncoder().encode(value));
}
function pubkeyBase64(value) {
    return typeof value === "string" ? value : bytesBase64(value);
}
function pubkeyBytes(value) {
    const decoded = typeof value === "string" ? canonicalBase64Bytes(value, 32) : value;
    if (decoded === null || decoded.length !== 32) {
        throw new Error("invalid canonical Ed25519 public key");
    }
    return decoded;
}
function bytesBase64(bytes) {
    if (typeof Buffer !== "undefined")
        return Buffer.from(bytes).toString("base64");
    const btoaFn = globalThis.btoa;
    if (!btoaFn)
        throw new Error("base64 encoding unavailable");
    return btoaFn(String.fromCharCode(...bytes));
}
function setSubset(needed, availableValues) {
    const available = new Set(availableValues);
    for (const value of needed) {
        if (!available.has(value))
            return false;
    }
    return true;
}
