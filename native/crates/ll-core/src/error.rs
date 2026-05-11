//! Typed error enum for ll-core operations.
//!
//! All fallible public functions return `crate::Result<T>`, which is an alias
//! for `std::result::Result<T, Error>`. This module is `#[non_exhaustive]` so
//! new variants can be added in patch releases without breaking callers that
//! match on the enum.

use thiserror::Error;

/// The single error type for all ll-core operations.
///
/// Variants are non-exhaustive: always include a catch-all arm when matching.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    /// Embedding vector has the wrong number of dimensions.
    #[error("embedding dimension mismatch: expected {expected}, got {actual}")]
    EmbeddingDimMismatch {
        /// Expected number of dimensions from the model config.
        expected: usize,
        /// Actual number of dimensions returned.
        actual: usize,
    },

    /// An empty batch was passed to a function that requires at least one item.
    #[error("batch must not be empty")]
    BatchEmpty,

    /// ONNX inference returned an error.
    #[error("inference error: {0}")]
    Inference(String),

    /// Tokenizer returned an error.
    #[error("tokenization error: {0}")]
    Tokenization(String),

    /// Underlying SQLite error.
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// A key expected to be present in the store was not found.
    #[error("store lookup failed for key: {key}")]
    StoreLookup {
        /// The key that was not found.
        key: String,
    },

    /// A `Mutex` was poisoned, meaning a thread panicked while holding the lock.
    ///
    /// `what` identifies the resource protected by the lock (e.g. `"reranker session"`).
    #[error("mutex lock poisoned: {what}")]
    LockPoisoned {
        /// Short label identifying the lock that was poisoned.
        what: &'static str,
    },
}

/// Convenience alias so callers write `ll_core::Result<T>` instead of
/// `std::result::Result<T, ll_core::Error>`.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Bridge from `anyhow::Error` to [`Error::Inference`].
///
/// The [`EmbeddingProvider`] trait returns `anyhow::Result` so that implementors
/// can use the `?` operator freely. Call sites that want a typed `ll_core::Result`
/// can convert with `.map_err(ll_core::Error::from)`. Full trait migration to
/// `ll_core::Result` is deferred to 0.2.0 (track 2R).
///
/// [`EmbeddingProvider`]: crate::embed::EmbeddingProvider
impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        Error::Inference(format!("{:#}", e))
    }
}
