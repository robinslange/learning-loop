use std::sync::OnceLock;

use crate::model::{EmbeddingProvider, KnownModel};
use crate::model::loader;

static PROVIDER: OnceLock<Box<dyn EmbeddingProvider>> = OnceLock::new();

pub fn init_provider(model: &KnownModel) {
    PROVIDER.get_or_init(|| {
        loader::load_provider(model)
            .expect("failed to load embedding model")
    });
}

fn provider() -> &'static dyn EmbeddingProvider {
    PROVIDER.get()
        .expect("embedding provider not initialized -- call init_provider first")
        .as_ref()
}

pub fn embedding_dim() -> usize {
    provider().dim()
}

pub fn model_id() -> &'static str {
    provider().model_id()
}

pub fn embed_query(text: &str) -> Vec<f32> {
    provider().embed_query(text).expect("embed_query failed")
}

pub fn embed_documents(texts: &[String]) -> Vec<Vec<f32>> {
    provider().embed_documents(texts).expect("embed_documents failed")
}
