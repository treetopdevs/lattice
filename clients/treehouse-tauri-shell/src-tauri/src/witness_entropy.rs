//! Native-only random operation/session/nonces. Entropy failure never supplies a fallback.
use crate::witness_bridge::Bytes32;
use rand_core::{OsRng, RngCore};

pub(crate) fn nonce32() -> Result<Bytes32, &'static str> {
    filled(|bytes| OsRng.try_fill_bytes(bytes))
}

fn filled<E>(fill: impl FnOnce(&mut [u8]) -> Result<(), E>) -> Result<Bytes32, &'static str> {
    let mut bytes = [0; 32];
    fill(&mut bytes).map_err(|_| "native_entropy_unavailable")?;
    Ok(Bytes32(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_entropy_failure_cannot_release_zero_or_partial_nonce() {
        assert_eq!(
            filled(|bytes| {
                bytes[0] = 7;
                Err(())
            }),
            Err("native_entropy_unavailable")
        );
        assert_eq!(
            filled(|bytes| {
                bytes.fill(9);
                Ok::<_, ()>(())
            }),
            Ok(Bytes32([9; 32]))
        );
    }
}
