//! Product-neutral LAN pairing discovery packet codec and collector.
//!
//! Extracted from the Township shell: the JSON discovery packet shape, size
//! bound and UDP collection loop. The packet type string is the product
//! parameter, so a Toolshed advert can never satisfy a Township listener.

use std::collections::HashSet;
use std::io::ErrorKind;
use std::net::UdpSocket;
use std::time::{Duration, Instant};

pub const PAIRING_DISCOVERY_MAX_PACKET_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingDiscoveryAdvert {
    pub label: Option<String>,
    pub handoff: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct PairingDiscoveryPacket {
    #[serde(rename = "type")]
    packet_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    handoff: Option<String>,
}

pub fn decode_pairing_discovery_packet(
    bytes: &[u8],
    packet_type: &str,
) -> Result<Option<PairingDiscoveryAdvert>, String> {
    let packet: PairingDiscoveryPacket = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid discovery packet: {error}"))?;

    if packet.packet_type != packet_type {
        return Ok(None);
    }

    let handoff = present_string(packet.handoff)
        .ok_or_else(|| "discovery packet handoff cannot be empty".to_string())?;

    Ok(Some(PairingDiscoveryAdvert {
        label: present_string(packet.label),
        handoff,
    }))
}

pub fn encode_pairing_discovery_packet(
    advert: &PairingDiscoveryAdvert,
    packet_type: &str,
) -> Result<Vec<u8>, String> {
    let handoff = present_string(Some(advert.handoff.clone()))
        .ok_or_else(|| "discovery packet handoff cannot be empty".to_string())?;
    let packet = PairingDiscoveryPacket {
        packet_type: packet_type.to_string(),
        label: present_string(advert.label.clone()),
        handoff: Some(handoff),
    };
    let bytes = serde_json::to_vec(&packet)
        .map_err(|error| format!("discovery packet encode failed: {error}"))?;

    if bytes.len() > PAIRING_DISCOVERY_MAX_PACKET_BYTES {
        return Err(format!("discovery packet too large: {} bytes", bytes.len()));
    }

    Ok(bytes)
}

pub fn collect_pairing_discovery_adverts(
    socket: UdpSocket,
    timeout: Duration,
    packet_type: &str,
) -> Result<Vec<PairingDiscoveryAdvert>, String> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .unwrap_or_else(Instant::now);
    let mut buffer = [0u8; PAIRING_DISCOVERY_MAX_PACKET_BYTES];
    let mut adverts = Vec::new();
    let mut seen_handoffs = HashSet::new();

    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }

        socket
            .set_read_timeout(Some(remaining))
            .map_err(|error| format!("pairing discovery timeout setup failed: {error}"))?;

        match socket.recv_from(&mut buffer) {
            Ok((len, _)) => {
                if let Ok(Some(advert)) =
                    decode_pairing_discovery_packet(&buffer[..len], packet_type)
                {
                    if seen_handoffs.insert(advert.handoff.clone()) {
                        adverts.push(advert);
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) =>
            {
                break;
            }
            Err(error) => return Err(format!("pairing discovery receive failed: {error}")),
        }
    }

    Ok(adverts)
}

fn present_string(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}
