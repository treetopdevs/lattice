use std::sync::atomic::{AtomicUsize, Ordering};

use ed25519_dalek::SigningKey;

use crate::governance_provider::LegacySeedBackend;
use crate::{
    trace_dev_command, GovernanceWitnessCreateError, GovernanceWitnessPresenceError,
    GovernanceWitnessProviderKind, TOWNSHIP_GOVERNANCE_TEST_PRESENCE_TRACE,
};

const TEST_SEED: [u8; 32] = [0xA5; 32];
static AUTHORIZATION_COUNT: AtomicUsize = AtomicUsize::new(0);

pub struct TestGovernanceWitnessCustody;

impl LegacySeedBackend for TestGovernanceWitnessCustody {
    fn provider_kind(&self) -> GovernanceWitnessProviderKind {
        GovernanceWitnessProviderKind::TestPresence
    }

    fn load_seed_public_key(&self) -> Result<Option<[u8; 32]>, String> {
        Ok(Some(test_public_key()))
    }

    fn authorize_and_load_seed(
        &self,
        _reason: &str,
    ) -> Result<Option<[u8; 32]>, GovernanceWitnessPresenceError> {
        AUTHORIZATION_COUNT.fetch_add(1, Ordering::SeqCst);
        trace_dev_command(TOWNSHIP_GOVERNANCE_TEST_PRESENCE_TRACE);
        Ok(Some(TEST_SEED))
    }

    fn load_public_key(&self) -> Result<Option<[u8; 32]>, String> {
        Ok(Some(test_public_key()))
    }

    fn create_seed(&self, _seed: [u8; 32]) -> Result<(), GovernanceWitnessCreateError> {
        Err(GovernanceWitnessCreateError::Duplicate)
    }

    fn create_public_key(&self, _public_key: [u8; 32]) -> Result<(), GovernanceWitnessCreateError> {
        Err(GovernanceWitnessCreateError::Duplicate)
    }

    fn delete_seed(&self) -> Result<(), String> {
        Err("governance test presence identity cannot be deleted".to_string())
    }
}

pub fn authorization_count() -> usize {
    AUTHORIZATION_COUNT.load(Ordering::SeqCst)
}

fn test_public_key() -> [u8; 32] {
    SigningKey::from_bytes(&TEST_SEED)
        .verifying_key()
        .to_bytes()
}
