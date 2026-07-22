//! Normative product isolation manifest (plan 158 "Product isolation contract").

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductManifest {
    pub product: String,
    pub app_id: String,
    pub deep_link_scheme: String,
    pub key_service: String,
    pub database_file: String,
    pub android_signing_alias: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProductManifestError {
    UnknownProduct(String),
}

impl std::fmt::Display for ProductManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProductManifestError::UnknownProduct(product) => {
                write!(f, "unknown product: {product}")
            }
        }
    }
}

impl std::error::Error for ProductManifestError {}

impl ProductManifest {
    /// Every product manifest in the normative isolation table.
    pub fn all() -> Vec<ProductManifest> {
        Vec::new()
    }

    /// The manifest for a named product, or an error for an unknown product.
    pub fn for_product(product: &str) -> Result<ProductManifest, ProductManifestError> {
        Err(ProductManifestError::UnknownProduct(product.to_string()))
    }

    /// Whether a deep link scheme belongs to this product. Cross-product
    /// scheme dispatch must refuse.
    pub fn accepts_scheme(&self, _scheme: &str) -> bool {
        true
    }
}
