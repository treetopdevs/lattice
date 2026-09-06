use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;
use treehouse_tauri_shell::witness_binding::BindingClaim;

fn vectors() -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!("../../test/fixtures/witness_binding_v1.json"))
        .unwrap()["vectors"].as_array().unwrap().clone()
}

#[test]
fn public_claims_match_beam_bytes_and_signatures_without_custody() {
    for vector in vectors() {
        let fields = &vector["fields"];
        let claim = BindingClaim::from_public_json(&fields.to_string()).unwrap();
        let expected = STANDARD.decode(vector["canonicalBase64"].as_str().unwrap()).unwrap();
        assert_eq!(claim.canonical_bytes(), expected);
        let key: [u8; 32] = STANDARD.decode(fields["actualWitnessPublicKey"].as_str().unwrap()).unwrap().try_into().unwrap();
        let key = VerifyingKey::from_bytes(&key).unwrap();
        let signature = Signature::from_slice(&STANDARD.decode(vector["signatureBase64"].as_str().unwrap()).unwrap()).unwrap();
        assert!(key.verify_strict(&expected, &signature).is_ok());
        for name in fields.as_object().unwrap().keys() {
            let mut changed = fields.clone();
            changed[name] = if name == "replica" { "other".into() } else { STANDARD.encode([42; 32]).into() };
            let bytes = BindingClaim::from_public_json(&changed.to_string()).unwrap().canonical_bytes();
            assert!(key.verify_strict(&bytes, &signature).is_err(), "{name}");
        }
    }
}

#[test]
fn malformed_public_fields_refuse_before_encoding() {
    let fixture = vectors().remove(0);
    let original = fixture["fields"].clone();
    for replica in ["".to_string(), "a".repeat(513), "🌲".repeat(129)] {
        let mut fields = original.clone(); fields["replica"] = replica.into();
        assert!(BindingClaim::from_public_json(&fields.to_string()).is_err());
    }
    for name in original.as_object().unwrap().keys().filter(|name| *name != "replica") {
        for value in [format!("{}\n", original[name].as_str().unwrap()), STANDARD.encode([0; 31]), STANDARD.encode([0; 33])] {
            let mut fields = original.clone(); fields[name] = value.into();
            assert!(BindingClaim::from_public_json(&fields.to_string()).is_err());
        }
        let mut fields = original.clone(); fields.as_object_mut().unwrap().remove(name);
        assert!(BindingClaim::from_public_json(&fields.to_string()).is_err());
    }
    for extra in ["product", "alias", "purpose", "bytes"] {
        let mut fields = original.clone(); fields[extra] = "township".into();
        assert!(BindingClaim::from_public_json(&fields.to_string()).is_err());
    }
    let duplicate = original.to_string().replacen('{', "{\"replica\":\"other\",", 1);
    assert!(BindingClaim::from_public_json(&duplicate).is_err());
}
