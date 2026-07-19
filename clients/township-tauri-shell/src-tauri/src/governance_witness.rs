use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD};
use base64::Engine as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};

const CLAIM_DOMAIN: &str = "lattice-succession-witness-v1";
const ATOM_TAG: u64 = 60_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalGovernanceWitnessPayload {
    pub bytes: Vec<u8>,
    pub sha256: [u8; 32],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GovernanceWitnessClaim {
    version: u64,
    replica: String,
    role: String,
    holder: String,
    holder_epoch: String,
    successor: String,
    policy_id: String,
}

pub fn canonical_governance_witness_payload(
    value: &serde_json::Value,
) -> Result<CanonicalGovernanceWitnessPayload, String> {
    let claim: GovernanceWitnessClaim = serde_json::from_value(value.clone())
        .map_err(|error| format!("malformed governance witness claim: {error}"))?;
    if claim.version != 1 {
        return Err("unsupported governance witness claim version".to_string());
    }
    if claim.role != "clerk" {
        return Err("unsupported governance witness role".to_string());
    }
    if claim.replica.is_empty() {
        return Err("governance witness replica cannot be empty".to_string());
    }

    let holder = canonical_base64_32(&claim.holder, "holder")?;
    let successor = canonical_base64_32(&claim.successor, "successor")?;
    canonical_base64_url_digest(&claim.holder_epoch, "holder epoch")?;
    canonical_base64_url_digest(&claim.policy_id, "policy id")?;

    let mut bytes = Vec::with_capacity(384);
    append_major(&mut bytes, 4, 2);
    append_binary(&mut bytes, CLAIM_DOMAIN.as_bytes());
    append_major(&mut bytes, 5, 7);

    append_atom(&mut bytes, "role");
    append_atom(&mut bytes, &claim.role);
    append_atom(&mut bytes, "holder");
    append_binary(&mut bytes, &holder);
    append_atom(&mut bytes, "replica");
    append_binary(&mut bytes, claim.replica.as_bytes());
    append_atom(&mut bytes, "version");
    append_major(&mut bytes, 0, claim.version);
    append_atom(&mut bytes, "policy_id");
    append_binary(&mut bytes, claim.policy_id.as_bytes());
    append_atom(&mut bytes, "successor");
    append_binary(&mut bytes, &successor);
    append_atom(&mut bytes, "holder_epoch");
    append_binary(&mut bytes, claim.holder_epoch.as_bytes());

    let sha256 = Sha256::digest(&bytes).into();
    Ok(CanonicalGovernanceWitnessPayload { bytes, sha256 })
}

fn canonical_base64_32(value: &str, field: &str) -> Result<[u8; 32], String> {
    let decoded = BASE64
        .decode(value)
        .map_err(|_| format!("governance witness {field} is not canonical base64"))?;
    if BASE64.encode(&decoded) != value {
        return Err(format!(
            "governance witness {field} is not canonical base64"
        ));
    }
    decoded
        .try_into()
        .map_err(|_| format!("governance witness {field} is not 32 bytes"))
}

fn canonical_base64_url_digest(value: &str, field: &str) -> Result<(), String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| format!("governance witness {field} is not canonical base64url"))?;
    if decoded.len() != 32 || URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err(format!(
            "governance witness {field} is not canonical base64url"
        ));
    }
    Ok(())
}

fn append_atom(output: &mut Vec<u8>, value: &str) {
    append_major(output, 6, ATOM_TAG);
    append_binary(output, value.as_bytes());
}

fn append_binary(output: &mut Vec<u8>, value: &[u8]) {
    append_major(output, 2, value.len() as u64);
    output.extend_from_slice(value);
}

fn append_major(output: &mut Vec<u8>, major: u8, value: u64) {
    let prefix = major << 5;
    match value {
        0..=23 => output.push(prefix | value as u8),
        24..=0xff => output.extend_from_slice(&[prefix | 24, value as u8]),
        0x100..=0xffff => {
            output.push(prefix | 25);
            output.extend_from_slice(&(value as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            output.push(prefix | 26);
            output.extend_from_slice(&(value as u32).to_be_bytes());
        }
        _ => {
            output.push(prefix | 27);
            output.extend_from_slice(&value.to_be_bytes());
        }
    }
}
