pub mod benchmark;
pub mod bge_small;
pub mod loader;

pub use ll_core::embed::{EmbeddingProvider, ModelConfig};

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
