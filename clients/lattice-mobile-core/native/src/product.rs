//! Normative product isolation manifest (plan 158 "Product isolation contract").
//!
//! The single source of truth is `clients/lattice-mobile-core/products.json`;
//! the TypeScript package consumes the same file, so both runtimes pin the
//! identical table. A change to that table requires updating the collision
//! contract before any product shell lands.

use std::sync::LazyLock;

const PRODUCTS_JSON: &str = include_str!("../../products.json");

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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductManifestTable {
    #[allow(dead_code)]
    comment: Option<String>,
    products: Vec<ProductManifest>,
}

static PRODUCT_MANIFESTS: LazyLock<Vec<ProductManifest>> = LazyLock::new(|| {
    let table: ProductManifestTable = serde_json::from_str(PRODUCTS_JSON)
        .expect("products.json is the normative table and must parse");
    table.products
});

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
        PRODUCT_MANIFESTS.clone()
    }

    /// The manifest for a named product, or an error for an unknown product.
    pub fn for_product(product: &str) -> Result<ProductManifest, ProductManifestError> {
        PRODUCT_MANIFESTS
            .iter()
            .find(|manifest| manifest.product == product)
            .cloned()
            .ok_or_else(|| ProductManifestError::UnknownProduct(product.to_string()))
    }

    /// Whether a deep link scheme belongs to this product. Cross-product
    /// scheme dispatch must refuse.
    pub fn accepts_scheme(&self, scheme: &str) -> bool {
        !scheme.is_empty() && scheme == self.deep_link_scheme
    }
}
