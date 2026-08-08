//! Collision contract for the plan-158 product isolation table.
//!
//! The table is normative: Township, Toolshed and Treehouse must each carry a
//! unique app ID, deep-link scheme, native key service, database file and
//! Android signing alias, and cross-product scheme dispatch must refuse.

use std::collections::HashSet;

use lattice_mobile_core::{ProductManifest, ProductManifestError};

#[test]
fn all_three_product_manifests_exist_and_match_the_plan_158_table() {
    let manifests = ProductManifest::all();
    assert_eq!(
        manifests.len(),
        3,
        "expected exactly the Township, Toolshed and Treehouse manifests"
    );

    let township = ProductManifest::for_product("township").expect("township manifest");
    assert_eq!(township.app_id, "dev.treetop.lattice.township");
    assert_eq!(township.deep_link_scheme, "township");
    assert_eq!(township.key_service, "dev.treetop.lattice.township.carrier");
    assert_eq!(township.database_file, "township-v1.sqlite3");
    assert_eq!(township.android_signing_alias, "township-pilot-v1");

    let toolshed = ProductManifest::for_product("toolshed").expect("toolshed manifest");
    assert_eq!(toolshed.app_id, "dev.treetop.lattice.toolshed");
    assert_eq!(toolshed.deep_link_scheme, "toolshed");
    assert_eq!(toolshed.key_service, "dev.treetop.lattice.toolshed.carrier");
    assert_eq!(toolshed.database_file, "toolshed-v1.sqlite3");
    assert_eq!(toolshed.android_signing_alias, "toolshed-pilot-v1");

    let treehouse = ProductManifest::for_product("treehouse").expect("treehouse manifest");
    assert_eq!(treehouse.app_id, "dev.treetop.lattice.treehouse");
    assert_eq!(treehouse.deep_link_scheme, "treehouse");
    assert_eq!(
        treehouse.key_service,
        "dev.treetop.lattice.treehouse.carrier"
    );
    assert_eq!(treehouse.database_file, "treehouse-v1.sqlite3");
    assert_eq!(treehouse.android_signing_alias, "treehouse-pilot-v1");
}

#[test]
fn product_manifest_identifiers_never_collide() {
    let manifests = ProductManifest::all();
    assert_eq!(
        manifests.len(),
        3,
        "collision test needs all three products"
    );

    assert_all_unique(manifests.iter().map(|manifest| manifest.product.clone()));
    assert_all_unique(manifests.iter().map(|manifest| manifest.app_id.clone()));
    assert_all_unique(
        manifests
            .iter()
            .map(|manifest| manifest.deep_link_scheme.clone()),
    );
    assert_all_unique(
        manifests
            .iter()
            .map(|manifest| manifest.key_service.clone()),
    );
    assert_all_unique(
        manifests
            .iter()
            .map(|manifest| manifest.database_file.clone()),
    );
    assert_all_unique(
        manifests
            .iter()
            .map(|manifest| manifest.android_signing_alias.clone()),
    );
}

#[test]
fn cross_product_scheme_dispatch_refuses() {
    let manifests = ProductManifest::all();
    assert_eq!(
        manifests.len(),
        3,
        "scheme dispatch test needs all three products"
    );

    for manifest in &manifests {
        assert!(
            manifest.accepts_scheme(&manifest.deep_link_scheme),
            "{} must accept its own scheme",
            manifest.product
        );
        for other in &manifests {
            if other.product == manifest.product {
                continue;
            }
            assert!(
                !manifest.accepts_scheme(&other.deep_link_scheme),
                "{} must refuse the {} scheme",
                manifest.product,
                other.product
            );
        }
        assert!(!manifest.accepts_scheme(""), "empty scheme must refuse");
        assert!(
            !manifest.accepts_scheme("https"),
            "unrelated scheme must refuse"
        );
    }
}

#[test]
fn unknown_product_is_refused() {
    assert_eq!(
        ProductManifest::for_product("mystery"),
        Err(ProductManifestError::UnknownProduct("mystery".to_string()))
    );
}

fn assert_all_unique<I>(values: I)
where
    I: Iterator<Item = String>,
{
    let values: Vec<String> = values.collect();
    let unique: HashSet<&String> = values.iter().collect();
    assert_eq!(
        unique.len(),
        values.len(),
        "product manifest identifiers collide: {values:?}"
    );
}
