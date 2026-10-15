#[cfg(feature = "research")]
pub mod benchmark;
pub mod loader;

pub use ll_core::embed::{EmbeddingProvider, ModelConfig};
pub use ll_core::models::bge_small;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "model")]
pub enum KnownModel {
    BgeSmallEnV15,
}

impl KnownModel {
    pub fn config(&self) -> ModelConfig {
        match self {
            KnownModel::BgeSmallEnV15 => bge_small::config(),
        }
    }
}
