//! Hybrid semantic search primitives for the learning-loop plugin.
//!
//! ll-core provides the pure algorithmic layer used by `ll-search`:
//!
//! - **`embed`** -- `EmbeddingProvider` trait + `ModelConfig` for on-device ONNX inference.
//! - **`store`** -- `EmbeddingStore`: an in-memory index with `Arc<[f32]>` accessors.
//! - **`scoring`** -- BM25/FTS query helpers, RRF fusion, Rocchio PRF.
//! - **`graph`** -- Personalized PageRank over a wikilink graph.
//! - **`rerank`** -- Cross-encoder reranking with a bundled ONNX model.
//! - **`error`** -- Typed `Error` enum; re-exported as `ll_core::Error` / `ll_core::Result`.
//! - **`config`** -- Shared numeric constants; re-exported as `ll_core::TOP_K` etc.
//!
//! # Versioning
//!
//! This crate follows semver strictly. The `0.1.x` series is additive-only.
//! Breaking changes ship as `0.2.0`.

#![warn(missing_docs)]

pub mod config;
pub mod embed;
pub mod error;
pub mod graph;
pub mod rerank;
pub mod scoring;
pub mod store;

pub use config::{PAGERANK_ITERS, TOP_K};
pub use error::{Error, Result};
