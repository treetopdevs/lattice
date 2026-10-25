import { readFileSync } from 'node:fs';
import { fixtureSigner, fixtureId } from './export_treehouse_catalog_trust';
import { prepareTreehouseSpaceCreation, authorTreehouseCommand, treehouseCommandDecoders, observeTreehouse } from '../../src/treehouse';
import { treehouseInvitationAcceptanceBytes } from '../../src/treehouse';
import { carrierDelegationsFromFrames } from '../../src/carrier';
import { carrierOpsToSemanticOps } from '../../src/carrier';
import { verifyCarrierOp, canonicalBase64Bytes } from '../../src/codec';
import { verifyEd25519 } from '../../src/signature';
if (process.argv[2] === 'produce') {
    const signer = fixtureSigner('strict-signature-root'), member = fixtureSigner('strict-signature-member');
    const creation = await prepareTreehouseSpaceCreation({ replica: `replica:treehouse:space:${fixtureId('strict-signature')}`, name: 'Strict signature Space', signer });
    const base = creation.pending, replica = creation.replica, capId = carrierDelegationsFromFrames(base)[0].id;
    const histories = [];
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const forged = new Uint8Array(64);
    forged[0] = 1;
    for (const mode of ['valid', 'weak']) {
        const pub = mode === 'valid' ? member.publicKey : identity, recipient = Buffer.from(pub).toString('base64');
        const invite = await authorTreehouseCommand({ product: 'Treehouse.Space', replica, signer, capId, deps: [base.at(-1).id], command: { command: 'issue_invitation', recipient, threads: [] } });
        const semantic = carrierOpsToSemanticOps([invite], {}, treehouseCommandDecoders('Treehouse.Space'))[0];
        const acceptance = Buffer.from(mode === 'valid' ? await member.sign(treehouseInvitationAcceptanceBytes(replica, semantic)) : forged).toString('base64');
        const admission = await authorTreehouseCommand({ product: 'Treehouse.Space', replica, signer, capId, deps: [invite.id], command: { command: 'admit_member', invitationId: invite.id, recipient, level: 'member', acceptance } });
        histories.push({ name: 'ts-' + mode, replica, frames: [...base, invite, admission], admission: admission.id, expected: mode === 'valid' });
    }
    console.log(JSON.stringify({ histories }));
}
else {
    const input = JSON.parse(readFileSync(process.argv[3] ?? 0, 'utf8'));
    const results = [];
    for (const history of input.histories) {
        for (const frame of history.frames) {
            if (!(await verifyCarrierOp(frame, { verify: async (pub, bytes, sig) => verifyEd25519(sig, bytes, canonicalBase64Bytes(pub, 32)) })).valid)
                throw new Error('fixture outer signature must be valid');
        }
        const ops = carrierOpsToSemanticOps(history.frames, {}, treehouseCommandDecoders('Treehouse.Space'));
        const projection = observeTreehouse('Treehouse.Space', ops);
        const { admin, moderator, ...state } = projection.state;
        results.push({ state, reasons: Object.fromEntries(ops.filter(o => o.kind === 'command').map(o => [o.id, projection.quarantineReasons.get(o.id) ?? null])) });
    }
    console.log(JSON.stringify({ results }));
}
