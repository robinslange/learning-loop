pub mod bge_small;
pub mod embeddinggemma;
pub mod loader;

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub model_id: String,
    pub dim: usize,
    pub max_tokens: usize,
    pub query_prefix: Option<String>,
    pub passage_prefix: Option<String>,
    pub needs_token_type_ids: bool,
    pub needs_external_pooling: bool,
    pub normalize_embeddings: bool,
    pub output_tensor_name: Option<String>,
}

pub trait EmbeddingProvider: Send + Sync {
    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    fn config(&self) -> &ModelConfig;

    fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        let prefixed = match &self.config().query_prefix {
            Some(prefix) => format!("{}{}", prefix, text),
            None => text.to_string(),
        };
        let mut results = self.embed_batch(&[prefixed])?;
        Ok(results.remove(0))
    }

    fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        match &self.config().passage_prefix {
            Some(prefix) => {
                let prefixed: Vec<String> =
                    texts.iter().map(|t| format!("{}{}", prefix, t)).collect();
                self.embed_batch(&prefixed)
            }
            None => self.embed_batch(texts),
        }
    }

    fn dim(&self) -> usize {
        self.config().dim
    }

    fn model_id(&self) -> &str {
        &self.config().model_id
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "model")]
pub enum KnownModel {
    BgeSmallEnV15,
    EmbeddingGemma300m,
}

impl KnownModel {
    pub fn config(&self) -> ModelConfig {
        match self {
            KnownModel::BgeSmallEnV15 => bge_small::config(),
            KnownModel::EmbeddingGemma300m => embeddinggemma::config(),
        }
    }

}
