use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use township_tauri_shell::{
    advertise_township_pairing_handoff, build_platform_secure_township_app,
    collect_township_pairing_discovery_adverts, configure_platform_secure_township_builder,
    configure_platform_secure_township_builder_with_values_file, configure_township_builder,
    decode_township_pairing_discovery_packet, encode_township_pairing_discovery_packet,
    seed_dev_carrier_key_from_vars, township_command_names, CarrierKeySeedStore,
    InMemoryCarrierKeySeedStore, KeyringCarrierKeySeedStore, TownshipNativeState,
    TownshipPairingDiscoveryAdvert, TOWNSHIP_DEV_CARRIER_KEY_ID_ENV,
    TOWNSHIP_DEV_CARRIER_KEY_SEED_ENV, TOWNSHIP_KEYRING_SERVICE,
    TOWNSHIP_PAIRING_DISCOVERY_PACKET_TYPE,
};

const W1_SESSION_SEED: &str = "township-g1";
const W1_SESSION_PUBKEY: &str = "Ze1W+4DnnK6aoJY5GiUoDVyZVhq5/PCL7UwQALXUQNk=";
const W1_TRANSCRIPT_B64: &str = "h1JjYXJyaWVyLXNlc3Npb24tdjFIcmVzaWRlbnRYS3JlcGxpY2E6bWF0dGVyOnRvd25zaGlwLWcxI3Jvb3Q6UVVCN293cFZJc1puM0l5b1ZMSmJzRmM1SExrb3poaTJQVkJMNUx6aGozd0tmaXhlZC1ub25jZQFIcmVzaWRlbnRYIGXtVvuA55yumqCWORolKA1cmVYaufzwi+1MEAC11EDZ";
const W1_SIGNATURE_B64: &str =
    "TS9+HPGiV88JMWJw0vm8euvAJEkmMLDxaKnTGz7wBX5vxLYi6wKRuFHLyHgxN3Igu2tFRjPaTIqq4p2RD5CDCg==";
const PAIRING_HANDOFF: &str = "township-pairing:v1:eyJ2IjoxfQ==";

#[test]
fn command_names_match_the_tauri_bridge_contract() {
    assert_eq!(
        township_command_names(),
        &[
            "lattice_kv_get",
            "lattice_kv_set",
            "lattice_ensure_carrier_key",
            "lattice_public_key",
            "lattice_sign_carrier",
            "lattice_discover_pairing_adverts",
            "lattice_advertise_pairing_handoff",
            "lattice_android_current_intent_url",
            "lattice_log_probe",
            "lattice_trace_dev_event"
        ]
    );
}

#[test]
fn registered_tauri_commands_roundtrip_through_mock_ipc() {
    let app =
        configure_township_builder(tauri::test::mock_builder(), TownshipNativeState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert_ipc_response(
        &webview,
        "lattice_kv_get",
        serde_json::json!({ "key": "township:resident:ops" }),
        Ok(None::<String>),
    );
    assert_ipc_response(
        &webview,
        "lattice_kv_set",
        serde_json::json!({
            "key": "township:resident:ops",
            "value": "[{\"id\":\"op-1\"}]"
        }),
        Ok(()),
    );
    assert_ipc_response(
        &webview,
        "lattice_kv_get",
        serde_json::json!({ "key": "township:resident:ops" }),
        Ok(Some("[{\"id\":\"op-1\"}]".to_string())),
    );

    let public_key: String = ipc_response(
        &webview,
        "lattice_ensure_carrier_key",
        serde_json::json!({ "keyId": "resident" }),
    )
    .unwrap();
    let reused_public_key: String = ipc_response(
        &webview,
        "lattice_ensure_carrier_key",
        serde_json::json!({ "keyId": "resident" }),
    )
    .unwrap();
    assert_eq!(reused_public_key, public_key);

    let signature: String = ipc_response(
        &webview,
        "lattice_sign_carrier",
        serde_json::json!({
            "keyId": "resident",
            "bytes": W1_TRANSCRIPT_B64
        }),
    )
    .unwrap();
    assert_signature(&public_key, W1_TRANSCRIPT_B64, &signature);

    let discovery: Vec<TownshipPairingDiscoveryAdvert> = ipc_response(
        &webview,
        "lattice_discover_pairing_adverts",
        serde_json::json!({ "timeoutMs": 1 }),
    )
    .unwrap();
    assert!(discovery.is_empty());

    let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
    listener
        .set_read_timeout(Some(Duration::from_millis(750)))
        .unwrap();
    let listener_addr = listener.local_addr().unwrap().to_string();
    assert_ipc_response(
        &webview,
        "lattice_advertise_pairing_handoff",
        serde_json::json!({
            "handoff": PAIRING_HANDOFF,
            "label": " Town hall carrier ",
            "targetAddr": listener_addr
        }),
        Ok(()),
    );
    let mut buffer = [0u8; 16 * 1024];
    let (packet_len, _) = listener.recv_from(&mut buffer).unwrap();
    assert_eq!(
        decode_township_pairing_discovery_packet(&buffer[..packet_len])
            .unwrap()
            .unwrap(),
        TownshipPairingDiscoveryAdvert {
            label: Some("Town hall carrier".to_string()),
            handoff: PAIRING_HANDOFF.to_string()
        }
    );

    assert_ipc_response(
        &webview,
        "lattice_android_current_intent_url",
        serde_json::json!({}),
        Ok(None::<String>),
    );

    assert_ipc_response(
        &webview,
        "lattice_log_probe",
        serde_json::json!({ "event": "township-canonical-probe digest=test" }),
        Ok(()),
    );

    assert_ipc_response(
        &webview,
        "lattice_trace_dev_event",
        serde_json::json!({ "event": "deep-link:township://pairing" }),
        Ok(()),
    );
}

#[test]
fn discovery_packets_encode_public_pairing_adverts_only() {
    let packet = encode_township_pairing_discovery_packet(&TownshipPairingDiscoveryAdvert {
        label: Some(" Town hall carrier ".to_string()),
        handoff: format!("  {PAIRING_HANDOFF}  "),
    })
    .unwrap();
    let packet_value: serde_json::Value = serde_json::from_slice(&packet).unwrap();

    assert_eq!(
        packet_value,
        serde_json::json!({
            "type": TOWNSHIP_PAIRING_DISCOVERY_PACKET_TYPE,
            "label": "Town hall carrier",
            "handoff": PAIRING_HANDOFF
        })
    );
    assert!(!String::from_utf8(packet)
        .unwrap()
        .contains("resident-device"));
}

#[test]
fn discovery_packets_decode_public_pairing_adverts_only() {
    let packet = serde_json::json!({
        "type": TOWNSHIP_PAIRING_DISCOVERY_PACKET_TYPE,
        "label": "  Town hall carrier  ",
        "handoff": format!("  {PAIRING_HANDOFF}  "),
        "localRealm": "resident-device-local",
        "keyId": "resident-device-key"
    })
    .to_string();

    let advert = decode_township_pairing_discovery_packet(packet.as_bytes())
        .unwrap()
        .unwrap();

    assert_eq!(
        advert,
        TownshipPairingDiscoveryAdvert {
            label: Some("Town hall carrier".to_string()),
            handoff: PAIRING_HANDOFF.to_string()
        }
    );
    assert!(!serde_json::to_string(&advert)
        .unwrap()
        .contains("resident-device"));
}

#[test]
fn discovery_packets_reject_malformed_or_empty_handoffs_without_poisoning_other_packets() {
    let ignored = serde_json::json!({
        "type": "other-discovery",
        "handoff": PAIRING_HANDOFF
    })
    .to_string();
    assert_eq!(
        decode_township_pairing_discovery_packet(ignored.as_bytes()).unwrap(),
        None
    );

    let missing_handoff = serde_json::json!({
        "type": TOWNSHIP_PAIRING_DISCOVERY_PACKET_TYPE,
        "label": "Town hall carrier"
    })
    .to_string();
    assert!(
        decode_township_pairing_discovery_packet(missing_handoff.as_bytes())
            .unwrap_err()
            .contains("handoff")
    );
    assert!(decode_township_pairing_discovery_packet(b"not json")
        .unwrap_err()
        .contains("invalid discovery packet"));
}

#[test]
fn udp_pairing_discovery_advertise_sends_loopback_public_handoff_only() {
    let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
    listener
        .set_read_timeout(Some(Duration::from_millis(750)))
        .unwrap();
    let listener_addr = listener.local_addr().unwrap().to_string();

    advertise_township_pairing_handoff(
        PAIRING_HANDOFF.to_string(),
        Some(" Town hall carrier ".to_string()),
        Some(listener_addr),
    )
    .unwrap();

    let mut buffer = [0u8; 16 * 1024];
    let (packet_len, _) = listener.recv_from(&mut buffer).unwrap();
    let packet = String::from_utf8(buffer[..packet_len].to_vec()).unwrap();
    assert!(!packet.contains("resident-device-local"));
    assert!(!packet.contains("resident-device-key"));
    assert_eq!(
        decode_township_pairing_discovery_packet(packet.as_bytes())
            .unwrap()
            .unwrap(),
        TownshipPairingDiscoveryAdvert {
            label: Some("Town hall carrier".to_string()),
            handoff: PAIRING_HANDOFF.to_string()
        }
    );
}

#[test]
fn udp_pairing_discovery_collects_loopback_public_adverts() {
    let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
    let listener_addr = listener.local_addr().unwrap();
    let handle = std::thread::spawn(move || {
        collect_township_pairing_discovery_adverts(listener, Duration::from_millis(750)).unwrap()
    });

    let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
    let bad_packet = serde_json::json!({
        "type": TOWNSHIP_PAIRING_DISCOVERY_PACKET_TYPE,
        "handoff": ""
    })
    .to_string();
    sender
        .send_to(bad_packet.as_bytes(), listener_addr)
        .unwrap();

    let packet = serde_json::json!({
        "type": TOWNSHIP_PAIRING_DISCOVERY_PACKET_TYPE,
        "label": "Town hall carrier",
        "handoff": PAIRING_HANDOFF,
        "localRealm": "resident-device-local",
        "keyId": "resident-device-key"
    })
    .to_string();
    sender.send_to(packet.as_bytes(), listener_addr).unwrap();

    let adverts = handle.join().unwrap();
    assert_eq!(
        adverts,
        vec![TownshipPairingDiscoveryAdvert {
            label: Some("Town hall carrier".to_string()),
            handoff: PAIRING_HANDOFF.to_string()
        }]
    );
}

#[test]
fn platform_secure_builder_uses_stable_keyring_service_and_registers_commands() {
    assert_eq!(
        TOWNSHIP_KEYRING_SERVICE,
        "dev.treetop.lattice.township.carrier"
    );

    let app = configure_platform_secure_township_builder(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert_ipc_response(
        &webview,
        "lattice_kv_get",
        serde_json::json!({ "key": "township:bootstrap:probe" }),
        Ok(None::<String>),
    );
}

#[test]
fn platform_secure_app_construction_builds_mock_app_and_registers_commands() {
    let app = build_platform_secure_township_app(
        tauri::test::mock_builder(),
        tauri::test::mock_context(tauri::test::noop_assets()),
    )
    .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert_ipc_response(
        &webview,
        "lattice_kv_get",
        serde_json::json!({ "key": "township:bootstrap:constructed-app" }),
        Ok(None::<String>),
    );
}

#[test]
fn platform_secure_builder_persists_native_kv_across_app_restarts_when_file_is_configured() {
    let path = unique_test_kv_path("township-platform-native-kv");
    let _ = std::fs::remove_file(&path);

    {
        let app = configure_platform_secure_township_builder_with_values_file(
            tauri::test::mock_builder(),
            &path,
        )
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        assert_ipc_response(
            &webview,
            "lattice_kv_set",
            serde_json::json!({
                "key": "township:zoning-variance-24:carrier_peer_config",
                "value": "{\"url\":\"ws://10.0.2.2:4111/carrier\"}"
            }),
            Ok(()),
        );
    }

    let app = configure_platform_secure_township_builder_with_values_file(
        tauri::test::mock_builder(),
        &path,
    )
    .build(tauri::test::mock_context(tauri::test::noop_assets()))
    .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert_ipc_response(
        &webview,
        "lattice_kv_get",
        serde_json::json!({ "key": "township:zoning-variance-24:carrier_peer_config" }),
        Ok(Some("{\"url\":\"ws://10.0.2.2:4111/carrier\"}".to_string())),
    );

    let _ = std::fs::remove_file(path);
}

fn assert_ipc_response<T>(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: serde_json::Value,
    expected: Result<T, T>,
) where
    T: serde::Serialize + std::fmt::Debug + Send + Sync + 'static,
{
    tauri::test::assert_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: body.into(),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
        expected,
    );
}

fn ipc_response<T>(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<T, serde_json::Value>
where
    T: DeserializeOwned,
{
    tauri::test::get_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: body.into(),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}

#[test]
fn key_value_commands_roundtrip_and_preserve_missing_reads() {
    let state = TownshipNativeState::default();

    assert_eq!(state.kv_get("township:resident:ops").unwrap(), None);
    state
        .kv_set("township:resident:ops", "[{\"id\":\"op-1\"}]")
        .unwrap();

    assert_eq!(
        state.kv_get("township:resident:ops").unwrap(),
        Some("[{\"id\":\"op-1\"}]".to_string())
    );
}

#[test]
fn key_value_store_reloads_from_persistent_file_across_state_instances() {
    let path = unique_test_kv_path("township-native-kv");
    let _ = std::fs::remove_file(&path);

    let first_state = TownshipNativeState::with_persistent_values_file(&path).unwrap();
    first_state
        .kv_set(
            "township:zoning-variance-24:carrier_peer_config",
            "{\"url\":\"ws://10.0.2.2:4111/carrier\"}",
        )
        .unwrap();
    first_state
        .kv_set(
            "township:zoning-variance-24:carrier_frames",
            "[{\"id\":\"op-1\"}]",
        )
        .unwrap();

    let second_state = TownshipNativeState::with_persistent_values_file(&path).unwrap();
    assert_eq!(
        second_state
            .kv_get("township:zoning-variance-24:carrier_peer_config")
            .unwrap(),
        Some("{\"url\":\"ws://10.0.2.2:4111/carrier\"}".to_string())
    );
    assert_eq!(
        second_state
            .kv_get("township:zoning-variance-24:carrier_frames")
            .unwrap(),
        Some("[{\"id\":\"op-1\"}]".to_string())
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn corrupt_persistent_key_value_file_recovers_as_empty_replayable_state() {
    let path = unique_test_kv_path("township-native-kv-corrupt");
    std::fs::write(&path, "{").unwrap();

    let recovered_state = TownshipNativeState::with_persistent_values_file(&path).unwrap();
    assert_eq!(
        recovered_state
            .kv_get("township:zoning-variance-24:carrier_peer_config")
            .unwrap(),
        None
    );

    recovered_state
        .kv_set(
            "township:zoning-variance-24:carrier_peer_config",
            "{\"url\":\"ws://10.0.2.2:4111/carrier\"}",
        )
        .unwrap();

    let reloaded_state = TownshipNativeState::with_persistent_values_file(&path).unwrap();
    assert_eq!(
        reloaded_state
            .kv_get("township:zoning-variance-24:carrier_peer_config")
            .unwrap(),
        Some("{\"url\":\"ws://10.0.2.2:4111/carrier\"}".to_string())
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn seeded_dev_key_matches_ts_w1_session_public_key_and_signature() {
    let state = TownshipNativeState::default();
    state
        .insert_seeded_dev_key("session", W1_SESSION_SEED)
        .unwrap();

    assert_eq!(state.public_key("session").unwrap(), W1_SESSION_PUBKEY);
    assert_eq!(
        state.sign_carrier("session", W1_TRANSCRIPT_B64).unwrap(),
        W1_SIGNATURE_B64
    );
}

#[test]
fn dev_seed_env_vars_prime_the_w1_session_key() {
    let state = TownshipNativeState::default();

    let seeded = seed_dev_carrier_key_from_vars(
        &state,
        [
            (
                TOWNSHIP_DEV_CARRIER_KEY_ID_ENV.to_string(),
                "session".to_string(),
            ),
            (
                TOWNSHIP_DEV_CARRIER_KEY_SEED_ENV.to_string(),
                W1_SESSION_SEED.to_string(),
            ),
        ],
    )
    .unwrap();

    assert!(seeded);
    assert_eq!(state.public_key("session").unwrap(), W1_SESSION_PUBKEY);
    assert_eq!(
        state.sign_carrier("session", W1_TRANSCRIPT_B64).unwrap(),
        W1_SIGNATURE_B64
    );
}

#[test]
fn native_key_seed_bytes_do_not_enter_key_value_state() {
    let state = TownshipNativeState::default();
    state
        .insert_seeded_dev_key("session", W1_SESSION_SEED)
        .unwrap();
    state
        .kv_set("township:resident:ops", "[{\"id\":\"op-1\"}]")
        .unwrap();
    state.ensure_carrier_key("resident").unwrap();

    let digest = Sha256::digest(W1_SESSION_SEED.as_bytes());
    let snapshot = serde_json::to_string(&state.kv_snapshot().unwrap()).unwrap();

    assert!(!snapshot.contains(W1_SESSION_SEED));
    assert!(!snapshot.contains(&base64_string(&digest)));
    assert!(!snapshot.contains(&hex_lower(&digest)));
}

#[test]
fn ensure_carrier_key_creates_and_reuses_native_signing_keys() {
    let state = TownshipNativeState::default();

    let public_key = state.ensure_carrier_key("resident").unwrap();
    let reused_public_key = state.ensure_carrier_key("resident").unwrap();
    assert_eq!(reused_public_key, public_key);

    let signature = state.sign_carrier("resident", W1_TRANSCRIPT_B64).unwrap();
    assert_signature(&public_key, W1_TRANSCRIPT_B64, &signature);
}

#[test]
fn ensure_carrier_key_reloads_persisted_native_seed_across_state_instances() {
    let store = InMemoryCarrierKeySeedStore::default();
    let first_state = TownshipNativeState::with_key_store(store.clone());

    let public_key = first_state.ensure_carrier_key("resident").unwrap();
    let signature = first_state
        .sign_carrier("resident", W1_TRANSCRIPT_B64)
        .unwrap();
    assert_signature(&public_key, W1_TRANSCRIPT_B64, &signature);

    let second_state = TownshipNativeState::with_key_store(store);
    let reloaded_public_key = second_state.ensure_carrier_key("resident").unwrap();
    let reloaded_signature = second_state
        .sign_carrier("resident", W1_TRANSCRIPT_B64)
        .unwrap();

    assert_eq!(reloaded_public_key, public_key);
    assert_signature(&reloaded_public_key, W1_TRANSCRIPT_B64, &reloaded_signature);
}

#[test]
fn concurrent_ensure_carrier_key_returns_one_public_key_per_id() {
    let state = Arc::new(TownshipNativeState::with_key_store(
        CoordinatedMissingSeedStore::default(),
    ));

    let first = {
        let state = Arc::clone(&state);
        std::thread::spawn(move || state.ensure_carrier_key("resident").unwrap())
    };
    let second = {
        let state = Arc::clone(&state);
        std::thread::spawn(move || state.ensure_carrier_key("resident").unwrap())
    };

    let first_public_key = first.join().unwrap();
    let second_public_key = second.join().unwrap();

    assert_eq!(second_public_key, first_public_key);
    assert_eq!(
        state.ensure_carrier_key("resident").unwrap(),
        first_public_key
    );
}

#[test]
fn platform_secure_constructor_exposes_keyring_backed_seed_store() {
    let _store = KeyringCarrierKeySeedStore::new("dev.treetop.lattice.test");
    let _state = TownshipNativeState::platform_secure("dev.treetop.lattice.test");
}

#[test]
fn signing_rejects_missing_keys() {
    let state = TownshipNativeState::default();

    let error = state
        .sign_carrier("missing", W1_TRANSCRIPT_B64)
        .unwrap_err();
    assert!(error.contains("missing signing key"));
}

#[test]
fn signing_rejects_malformed_base64_payloads() {
    let state = TownshipNativeState::default();
    state
        .insert_seeded_dev_key("session", W1_SESSION_SEED)
        .unwrap();

    let error = state.sign_carrier("session", "not base64").unwrap_err();
    assert!(error.contains("invalid carrier bytes"));
}

fn assert_signature(public_key_base64: &str, payload_base64: &str, signature_base64: &str) {
    let public_key: [u8; 32] = base64_bytes(public_key_base64).try_into().unwrap();
    let signature: [u8; 64] = base64_bytes(signature_base64).try_into().unwrap();
    let payload = base64_bytes(payload_base64);

    VerifyingKey::from_bytes(&public_key)
        .unwrap()
        .verify(&payload, &Signature::from_bytes(&signature))
        .unwrap();
}

fn base64_bytes(value: &str) -> Vec<u8> {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;

    BASE64.decode(value).unwrap()
}

fn base64_string(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;

    BASE64.encode(bytes)
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unique_test_kv_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "{label}-{}-{:?}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[derive(Clone, Default)]
struct CoordinatedMissingSeedStore {
    seed: Arc<Mutex<Option<[u8; 32]>>>,
    load_count: Arc<AtomicUsize>,
}

impl CarrierKeySeedStore for CoordinatedMissingSeedStore {
    fn load_seed(&self, _key_id: &str) -> Result<Option<[u8; 32]>, String> {
        let load_number = self.load_count.fetch_add(1, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_millis(100);
        while self.load_count.load(Ordering::SeqCst) < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }

        if load_number < 2 {
            return Ok(None);
        }

        Ok(*self.seed.lock().unwrap())
    }

    fn save_seed(&self, _key_id: &str, seed: [u8; 32]) -> Result<(), String> {
        *self.seed.lock().unwrap() = Some(seed);
        Ok(())
    }
}
