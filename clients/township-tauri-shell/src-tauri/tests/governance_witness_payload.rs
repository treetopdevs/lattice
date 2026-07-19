use sha2::{Digest, Sha256};
use township_tauri_shell::governance_witness::canonical_governance_witness_payload;

const CLAIM_PAYLOAD_HEX: &str = concat!(
    "82581d6c6174746963652d73756363657373696f6e2d7769746e6573732d7631",
    "a7d9ea6044726f6c65d9ea6045636c65726bd9ea6046686f6c64657258209826",
    "99a4c274494da57f7bf6963c340f4e4fc78a66a18d63508215bf5f61999ed9ea",
    "60477265706c696361585d7265706c6963613a6d61747465723a73756363657373",
    "696f6e2d7769746e65737365642d7265636f7665727923726f6f743a6c633947",
    "75785a4d77456c393958307a4e68444c4161366a52396e387042582d327a465333",
    "67685277576fd9ea604776657273696f6e01d9ea6049706f6c6963795f696458",
    "2b41504f744a7a5a717130586d71786b43524b32736c344c2d2d4f2d6e725a35",
    "516878554f48705a684a3330d9ea6049737563636573736f7258200c1635db5715",
    "6f53be05d2be36e730159c99b544ddacfa718676765a0e358e36d9ea604c686f",
    "6c6465725f65706f6368582b534a4d692d4b384955505576746b337a595255564d",
    "65736b612d4b6355764e545f386f5057546c4b444149"
);
const CLAIM_PAYLOAD_SHA256_HEX: &str =
    "534b4fb858a618734c6718d4ae2133bf563787b404f6ccb2442928c72f303f51";
const SECOND_PAYLOAD_HEX: &str = concat!(
    "82581d6c6174746963652d73756363657373696f6e2d7769746e6573732d7631",
    "a7d9ea6044726f6c65d9ea6045636c65726bd9ea6046686f6c64657258200101",
    "010101010101010101010101010101010101010101010101010101010101d9ea",
    "60477265706c696361582b7265706c6963613a6d61747465723a6e6174697665",
    "2d63616e6f6e6963616c2d666561736962696c697479d9ea604776657273696f",
    "6e01d9ea6049706f6c6963795f6964582b424151454241514542415145424151",
    "45424151454241514542415145424151454241514542415145424151d9ea6049",
    "737563636573736f725820030303030303030303030303030303030303030303",
    "0303030303030303030303d9ea604c686f6c6465725f65706f6368582b416749",
    "4341674943416749434167494341674943416749434167494341674943416749",
    "4341674943416749"
);
const SECOND_PAYLOAD_SHA256_HEX: &str =
    "2ab0d887789f29ca3c14c5483b57c3ace45f8f8b978c9cdddc239b1926f2cf47";

fn claim() -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "replica": "replica:matter:succession-witnessed-recovery#root:lc9GuxZMwEl99X0zNhDLAa6jR9n8pBX-2zFS3ghRwWo",
        "role": "clerk",
        "holder": "mCaZpMJ0SU2lf3v2ljw0D05Px4pmoY1jUIIVv19hmZ4=",
        "holderEpoch": "SJMi-K8IUPUvtk3zYRUVMeska-KcUvNT_8oPWTlKDAI",
        "successor": "DBY121cVb1O+BdK+NucwFZyZtUTdrPpxhnZ2Wg41jjY=",
        "policyId": "APOtJzZqq0XmqxkCRK2sl4L--O-nrZ5QhxUOHpZhJ30"
    })
}

#[test]
fn fixed_claim_matches_the_beam_and_typescript_payload_oracle() {
    let payload = canonical_governance_witness_payload(&claim()).unwrap();

    assert_eq!(hex_lower(&payload.bytes), CLAIM_PAYLOAD_HEX);
    assert_eq!(hex_lower(&payload.sha256), CLAIM_PAYLOAD_SHA256_HEX);
    assert_eq!(
        payload.sha256.as_slice(),
        Sha256::digest(&payload.bytes).as_slice()
    );
}

#[test]
fn a_second_beam_and_typescript_oracle_rules_out_fixture_lookup() {
    let second = serde_json::json!({
        "version": 1,
        "replica": "replica:matter:native-canonical-feasibility",
        "role": "clerk",
        "holder": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        "holderEpoch": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
        "successor": "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
        "policyId": "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"
    });
    let payload = canonical_governance_witness_payload(&second).unwrap();

    assert_eq!(hex_lower(&payload.bytes), SECOND_PAYLOAD_HEX);
    assert_eq!(hex_lower(&payload.sha256), SECOND_PAYLOAD_SHA256_HEX);
    assert_eq!(
        payload.sha256.as_slice(),
        Sha256::digest(&payload.bytes).as_slice()
    );
}

#[test]
fn json_object_order_is_not_semantic() {
    let reordered = serde_json::json!({
        "policyId": "APOtJzZqq0XmqxkCRK2sl4L--O-nrZ5QhxUOHpZhJ30",
        "successor": "DBY121cVb1O+BdK+NucwFZyZtUTdrPpxhnZ2Wg41jjY=",
        "holderEpoch": "SJMi-K8IUPUvtk3zYRUVMeska-KcUvNT_8oPWTlKDAI",
        "holder": "mCaZpMJ0SU2lf3v2ljw0D05Px4pmoY1jUIIVv19hmZ4=",
        "role": "clerk",
        "replica": "replica:matter:succession-witnessed-recovery#root:lc9GuxZMwEl99X0zNhDLAa6jR9n8pBX-2zFS3ghRwWo",
        "version": 1
    });

    assert_eq!(
        canonical_governance_witness_payload(&reordered).unwrap(),
        canonical_governance_witness_payload(&claim()).unwrap()
    );
}

#[test]
fn exact_claim_shape_is_required() {
    let mut extra = claim();
    extra["bytes"] = serde_json::json!("arbitrary-payload");
    assert!(canonical_governance_witness_payload(&extra).is_err());

    let mut missing = claim();
    missing.as_object_mut().unwrap().remove("holderEpoch");
    assert!(canonical_governance_witness_payload(&missing).is_err());

    assert!(canonical_governance_witness_payload(&serde_json::json!([
        "lattice-succession-witness-v1",
        {"arbitrary": "term"}
    ]))
    .is_err());
}

#[test]
fn unsupported_or_noncanonical_claim_fields_are_rejected() {
    for (field, value) in [
        ("version", serde_json::json!(2)),
        ("role", serde_json::json!("resident")),
        (
            "holder",
            serde_json::json!("mCaZpMJ0SU2lf3v2ljw0D05Px4pmoY1jUIIVv19hmZ4"),
        ),
        ("successor", serde_json::json!("not-base64")),
        (
            "holderEpoch",
            serde_json::json!("SJMi-K8IUPUvtk3zYRUVMeska-KcUvNT_8oPWTlKDAI="),
        ),
        (
            "policyId",
            serde_json::json!("APOtJzZqq0XmqxkCRK2sl4L--O-nrZ5QhxUOHpZhJ3+"),
        ),
    ] {
        let mut malformed = claim();
        malformed[field] = value;
        assert!(
            canonical_governance_witness_payload(&malformed).is_err(),
            "accepted malformed {field}"
        );
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
