//! Embedding provider trait and model configuration.
//!
//! Implement [`EmbeddingProvider`] to plug in any on-device ONNX embedding
//! model. The bundled `BGESmall` model in `ll-search` is the primary
//! implementation.

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Configuration for a text embedding model.
///
/// All fields are public so ll-search can construct configs inline. A
/// `#[non_exhaustive]` annotation is deferred to the 0.2.0 release; until
/// then, use the [`ModelConfig::new`] constructor for forward-compatible
/// construction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    /// Unique model identifier used in log messages and cache keys.
    pub model_id: String,
    /// Embedding vector dimension (e.g. 384 for `bge-small-en-v1.5`).
    pub dim: usize,
    /// Maximum number of tokens the model accepts per input.
    pub max_tokens: usize,
    /// Optional prefix prepended to query strings before embedding.
    ///
    /// BGE models use `"Represent this sentence for searching relevant passages: "`.
    pub query_prefix: Option<String>,
    /// Optional prefix prepended to document strings before embedding.
    pub passage_prefix: Option<String>,
    /// Whether the model requires token type ID tensors as input.
    pub needs_token_type_ids: bool,
    /// Whether the model requires external mean-pooling applied after inference.
    ///
    /// When `true`, the caller must average across the sequence dimension of
    /// the model output before L2-normalizing.
    pub needs_external_pooling: bool,
    /// Whether output vectors should be L2-normalized to unit length.
    pub normalize_embeddings: bool,
    /// Name of the output tensor to extract from the ONNX session.
    ///
    /// Defaults to `None`, which selects the first output tensor.
    pub output_tensor_name: Option<String>,
}

impl ModelConfig {
    /// Construct a `ModelConfig` with the three required fields and sensible
    /// defaults for everything else.
    ///
    /// Defaults:
    /// - `query_prefix` / `passage_prefix` -- `None`
    /// - `needs_token_type_ids` -- `false`
    /// - `needs_external_pooling` -- `false`
    /// - `normalize_embeddings` -- `true`
    /// - `output_tensor_name` -- `None`
    pub fn new(model_id: String, dim: usize, max_tokens: usize) -> Self {
        Self {
            model_id,
            dim,
            max_tokens,
            query_prefix: None,
            passage_prefix: None,
            needs_token_type_ids: false,
            needs_external_pooling: false,
            normalize_embeddings: true,
            output_tensor_name: None,
        }
    }
}

/// Trait for on-device text embedding models.
///
/// Implementations must be `Send + Sync` so they can be shared across async
/// tasks and stored in long-lived state.
///
/// # Required methods
///
/// Only [`embed_batch`](EmbeddingProvider::embed_batch) and
/// [`config`](EmbeddingProvider::config) must be implemented. The remaining
/// methods have default implementations that delegate to these two.
///
/// # Error type
///
/// The trait returns `anyhow::Result` so that implementors can use `?` without
/// committing to a specific error type. Call sites that need a typed
/// `ll_core::Result` can convert with `.map_err(ll_core::Error::from)`, which
/// routes through the `From<anyhow::Error>` bridge in [`crate::error`]. Full
/// migration of this trait to `ll_core::Result` is deferred to 0.2.0 (track 2R).
pub trait EmbeddingProvider: Send + Sync {
    /// Embed a batch of texts and return one vector per input.
    ///
    /// The caller is responsible for any prefix application. Use
    /// [`embed_query`](EmbeddingProvider::embed_query) or
    /// [`embed_documents`](EmbeddingProvider::embed_documents) for
    /// prefix-aware embedding.
    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;

    /// Return the model configuration for this provider.
    fn config(&self) -> &ModelConfig;

    /// Embed a single query string, applying the query prefix if configured.
    ///
    /// Validates that the returned vector has the expected dimension from
    /// [`config`](EmbeddingProvider::config).
    fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        let prefixed = match &self.config().query_prefix {
            Some(prefix) => format!("{}{}", prefix, text),
            None => text.to_string(),
        };
        let mut results = self.embed_batch(&[prefixed])?;
        let vec = results.remove(0);
        let expected = self.config().dim;
        anyhow::ensure!(
            vec.len() == expected,
            "embedding dim mismatch: model {} produced {} dims, expected {}",
            self.config().model_id, vec.len(), expected
        );
        Ok(vec)
    }

    /// Embed a slice of document strings, applying the passage prefix if configured.
    ///
    /// Returns an empty vec when `texts` is empty. Validates the dimension of
    /// the first returned vector.
    fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let results = match &self.config().passage_prefix {
            Some(prefix) => {
                let prefixed: Vec<String> =
                    texts.iter().map(|t| format!("{}{}", prefix, t)).collect();
                self.embed_batch(&prefixed)?
            }
            None => self.embed_batch(texts)?,
        };
        let expected = self.config().dim;
        if let Some(vec) = results.first() {
            anyhow::ensure!(
                vec.len() == expected,
                "embedding dim mismatch: model {} produced {} dims, expected {}",
                self.config().model_id, vec.len(), expected
            );
        }
        Ok(results)
    }

    /// Return the embedding dimension from this provider's config.
    fn dim(&self) -> usize {
        self.config().dim
    }

    /// Return the model ID string from this provider's config.
    fn model_id(&self) -> &str {
        &self.config().model_id
    }
}
