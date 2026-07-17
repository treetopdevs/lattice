use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use core_foundation::base::TCFType;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use objc2::rc::Retained;
use objc2_foundation::NSString;
use objc2_local_authentication::LAContext;
use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework::base::Error;
use security_framework::item::{ItemClass, ItemSearchOptions, SearchResult};
use security_framework::passwords::{
    delete_generic_password_options, generic_password, AccessControlOptions, PasswordOptions,
};
use security_framework_sys::base::{errSecDuplicateItem, errSecItemNotFound};
use security_framework_sys::item::kSecValueData;
use security_framework_sys::keychain_item::SecItemAdd;

use crate::{
    GovernanceWitnessCreateError, GovernanceWitnessKeyStore, GovernanceWitnessPresence,
    GovernanceWitnessPresenceError, GovernanceWitnessProviderKind,
};

const SEED_ACCOUNT: &str = "governance-witness-v1.seed";
const PUBLIC_KEY_ACCOUNT: &str = "governance-witness-v1.public";
const SEED_PUBLIC_KEY_ATTRIBUTE_PREFIX: &str = "township-governance-public-key:";
const ERR_SEC_USER_CANCELED: i32 = -128;
const ERR_SEC_NOT_AVAILABLE: i32 = -25291;
const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

pub struct MacosGovernanceWitnessCustody {
    service: String,
    pending_reason: Mutex<Option<String>>,
}

impl MacosGovernanceWitnessCustody {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            pending_reason: Mutex::new(None),
        }
    }

    fn password_options(&self, account: &str) -> PasswordOptions {
        let mut options = PasswordOptions::new_generic_password(&self.service, account);
        options.use_protected_keychain();
        options.set_access_synchronized(Some(false));
        options
    }

    fn create_item(
        &self,
        account: &str,
        bytes: &[u8],
        access_control: SecAccessControl,
        comment: Option<&str>,
    ) -> Result<(), GovernanceWitnessCreateError> {
        let mut options = self.password_options(account);
        options.set_access_control(access_control);
        if let Some(comment) = comment {
            options.set_comment(comment);
        }
        #[allow(deprecated)]
        options.query.push((
            unsafe { CFString::wrap_under_get_rule(kSecValueData) },
            CFData::from_buffer(bytes).into_CFType(),
        ));
        #[allow(deprecated)]
        let query = CFDictionary::from_CFType_pairs(&options.query);
        let status = unsafe { SecItemAdd(query.as_concrete_TypeRef(), std::ptr::null_mut()) };
        if status == 0 {
            Ok(())
        } else if status == errSecDuplicateItem {
            Err(GovernanceWitnessCreateError::Duplicate)
        } else {
            Err(GovernanceWitnessCreateError::Backend(format!(
                "governance witness Keychain creation failed: {}",
                Error::from(status)
            )))
        }
    }

    fn public_identity_attribute(&self) -> Result<Option<[u8; 32]>, String> {
        let mut search = ItemSearchOptions::new();
        search
            .class(ItemClass::generic_password())
            .service(&self.service)
            .account(SEED_ACCOUNT)
            .cloud_sync(Some(false))
            .ignore_legacy_keychains()
            .load_attributes(true);
        let results = match search.search() {
            Ok(results) => results,
            Err(error) if error.code() == errSecItemNotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "governance witness Keychain identity query failed: {error}"
                ));
            }
        };
        let attributes = results
            .first()
            .and_then(SearchResult::simplify_dict)
            .ok_or_else(|| {
                "governance witness Keychain identity attributes are malformed".to_string()
            })?;
        let encoded = attributes
            .values()
            .find_map(|value| value.strip_prefix(SEED_PUBLIC_KEY_ATTRIBUTE_PREFIX));
        match encoded {
            Some(encoded) => decode_public_key(encoded).map(Some),
            None => Ok(None),
        }
    }

    fn read_item(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
        match generic_password(self.password_options(account)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.code() == errSecItemNotFound => Ok(None),
            Err(error) => Err(format!("governance witness Keychain read failed: {error}")),
        }
    }

    fn read_protected_seed(
        &self,
        reason: &str,
    ) -> Result<Option<[u8; 32]>, GovernanceWitnessPresenceError> {
        let context = unsafe { LAContext::new() };
        let reason = NSString::from_str(reason);
        unsafe {
            context.setLocalizedReason(&reason);
            context.setTouchIDAuthenticationAllowableReuseDuration(0.0);
        }

        let mut search = ItemSearchOptions::new();
        search
            .class(ItemClass::generic_password())
            .service(&self.service)
            .account(SEED_ACCOUNT)
            .cloud_sync(Some(false))
            .ignore_legacy_keychains()
            .load_data(true);
        // Transfer the retained +1; security-framework adopts it under CF's create rule.
        let context = Retained::into_raw(context).cast();
        #[allow(deprecated)]
        unsafe {
            search.authentication_context(context);
        }
        let results = match search.search() {
            Ok(results) => results,
            Err(error) if error.code() == errSecItemNotFound => return Ok(None),
            Err(error) => return Err(classify_protected_seed_status(error.code())),
        };
        let bytes = match results.first() {
            Some(SearchResult::Data(bytes)) => bytes,
            _ => {
                return Err(GovernanceWitnessPresenceError::Failed(
                    "governance witness protected seed is malformed".to_string(),
                ));
            }
        };
        bytes.as_slice().try_into().map(Some).map_err(|_| {
            GovernanceWitnessPresenceError::Failed(
                "governance witness protected seed is not 32 bytes".to_string(),
            )
        })
    }
}

impl GovernanceWitnessKeyStore for MacosGovernanceWitnessCustody {
    fn provider_kind(&self) -> GovernanceWitnessProviderKind {
        GovernanceWitnessProviderKind::MacosProtectedKeychain
    }

    fn load_seed_public_key(&self) -> Result<Option<[u8; 32]>, String> {
        self.public_identity_attribute()
    }

    fn load_seed(&self) -> Result<Option<[u8; 32]>, GovernanceWitnessPresenceError> {
        let reason = self
            .pending_reason
            .lock()
            .map_err(|_| {
                GovernanceWitnessPresenceError::Failed(
                    "governance witness authentication context lock poisoned".to_string(),
                )
            })?
            .take()
            .ok_or_else(|| {
                GovernanceWitnessPresenceError::Failed(
                    "governance witness authentication context is missing".to_string(),
                )
            })?;
        self.read_protected_seed(&reason)
    }

    fn load_public_key(&self) -> Result<Option<[u8; 32]>, String> {
        match self.read_item(PUBLIC_KEY_ACCOUNT)? {
            Some(bytes) => bytes
                .as_slice()
                .try_into()
                .map(Some)
                .map_err(|_| "governance witness public sidecar is not 32 bytes".to_string()),
            None => Ok(None),
        }
    }

    fn create_seed(&self, seed: [u8; 32]) -> Result<(), GovernanceWitnessCreateError> {
        let public_key = ed25519_dalek::SigningKey::from_bytes(&seed)
            .verifying_key()
            .to_bytes();
        let comment = format!(
            "{SEED_PUBLIC_KEY_ATTRIBUTE_PREFIX}{}",
            BASE64.encode(public_key)
        );
        let access_control = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            AccessControlOptions::USER_PRESENCE.bits(),
        )
        .map_err(|error| {
            GovernanceWitnessCreateError::Backend(format!(
                "governance witness Keychain access control failed: {error}"
            ))
        })?;
        self.create_item(SEED_ACCOUNT, &seed, access_control, Some(&comment))
    }

    fn create_public_key(&self, public_key: [u8; 32]) -> Result<(), GovernanceWitnessCreateError> {
        let access_control = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            0,
        )
        .map_err(|error| {
            GovernanceWitnessCreateError::Backend(format!(
                "governance witness Keychain sidecar access control failed: {error}"
            ))
        })?;
        self.create_item(PUBLIC_KEY_ACCOUNT, &public_key, access_control, None)
    }

    fn delete_seed(&self) -> Result<(), String> {
        delete_generic_password_options(self.password_options(SEED_ACCOUNT))
            .map_err(|error| format!("governance witness Keychain seed rollback failed: {error}"))
    }
}

impl GovernanceWitnessPresence for MacosGovernanceWitnessCustody {
    fn provider_kind(&self) -> GovernanceWitnessProviderKind {
        GovernanceWitnessProviderKind::MacosProtectedKeychain
    }

    fn authorize(&self, reason: &str) -> Result<(), GovernanceWitnessPresenceError> {
        if reason.is_empty() {
            return Err(GovernanceWitnessPresenceError::Failed(
                "empty authentication reason".to_string(),
            ));
        }
        let mut pending = self.pending_reason.lock().map_err(|_| {
            GovernanceWitnessPresenceError::Failed(
                "authentication context lock poisoned".to_string(),
            )
        })?;
        if pending.is_some() {
            return Err(GovernanceWitnessPresenceError::Failed(
                "authentication context already pending".to_string(),
            ));
        }
        *pending = Some(reason.to_string());
        Ok(())
    }
}

fn decode_public_key(encoded: &str) -> Result<[u8; 32], String> {
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "governance witness seed identity metadata is not base64".to_string())?;
    if BASE64.encode(&bytes) != encoded {
        return Err(
            "governance witness seed identity metadata is not canonical base64".to_string(),
        );
    }
    bytes
        .try_into()
        .map_err(|_| "governance witness seed identity metadata is not 32 bytes".to_string())
}

fn classify_protected_seed_status(status: i32) -> GovernanceWitnessPresenceError {
    match status {
        ERR_SEC_USER_CANCELED => GovernanceWitnessPresenceError::Cancelled,
        ERR_SEC_NOT_AVAILABLE | ERR_SEC_INTERACTION_NOT_ALLOWED => {
            GovernanceWitnessPresenceError::Unavailable
        }
        _ => GovernanceWitnessPresenceError::Failed(
            "governance witness protected seed access failed".to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::classify_protected_seed_status;
    use crate::GovernanceWitnessPresenceError;

    #[test]
    fn protected_seed_prompt_statuses_preserve_coarse_user_outcomes() {
        assert_eq!(
            classify_protected_seed_status(-128),
            GovernanceWitnessPresenceError::Cancelled
        );
        for status in [-25291, -25308] {
            assert_eq!(
                classify_protected_seed_status(status),
                GovernanceWitnessPresenceError::Unavailable
            );
        }
        assert_eq!(
            classify_protected_seed_status(-25293),
            GovernanceWitnessPresenceError::Failed(
                "governance witness protected seed access failed".to_string()
            )
        );
    }
}
