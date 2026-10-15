use anyhow::Result;

use super::{EmbeddingProvider, KnownModel};

/// The download, SHA-256 pinning and provider live in `ll_core::models`; this
/// only maps a [`KnownModel`] to its loader.
pub fn load_provider(model: &KnownModel) -> Result<Box<dyn EmbeddingProvider>> {
    match model {
        KnownModel::BgeSmallEnV15 => ll_core::models::bge_small::load(),
    }
}
