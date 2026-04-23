use std::sync::OnceLock;

use crate::model::{EmbeddingProvider, KnownModel};
use crate::model::loader;

static PROVIDER: OnceLock<Box<dyn EmbeddingProvider>> = OnceLock::new();

pub fn init_provider(model: &KnownModel) {
    if let Some(existing) = PROVIDER.get() {
        let requested = model.config().model_id;
        let active = existing.model_id();
        if active != requested {
            panic!(
                "embedding provider already initialized with '{}', cannot switch to '{}'",
                active, requested
            );
        }
        return;
    }
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

pub fn try_provider() -> Option<&'static dyn EmbeddingProvider> {
    PROVIDER.get().map(|b| b.as_ref())
}

pub fn try_embed_query(text: &str) -> anyhow::Result<Vec<f32>> {
    provider().embed_query(text).map_err(|e| anyhow::anyhow!("embed_query: {e}"))
}

pub fn try_embed_documents(texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
    provider().embed_documents(texts).map_err(|e| anyhow::anyhow!("embed_documents: {e}"))
}
