import { authorCarrierOp } from "./codec";
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
export async function authorAndPersistTownshipCommand(input) {
    const [localOps, carrierFrames] = await Promise.all([
        input.localLog.load(),
        input.carrierFrames.load(),
    ]);
    const capId = selectTownshipCapId(input.command, carrierDelegationsFromFrames(carrierFrames), input.signer.publicKey);
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
function textBase64(value) {
    return bytesBase64(new TextEncoder().encode(value));
}
function bytesBase64(bytes) {
    if (typeof Buffer !== "undefined")
        return Buffer.from(bytes).toString("base64");
    const btoaFn = globalThis.btoa;
    if (!btoaFn)
        throw new Error("base64 encoding unavailable");
    return btoaFn(String.fromCharCode(...bytes));
}
