use std::sync::OnceLock;

use anyhow::Context as _;

use crate::model::loader;
use crate::model::{EmbeddingProvider, KnownModel};

static PROVIDER: OnceLock<Box<dyn EmbeddingProvider>> = OnceLock::new();

pub fn init_provider(model: &KnownModel) -> anyhow::Result<()> {
    if PROVIDER.get().is_none() {
        let loaded = loader::load_provider(model).context("failed to load embedding model")?;
        // A concurrent init may have set the provider first. Whichever won,
        // the check below compares it against the model this caller asked for.
        let _ = PROVIDER.set(loaded);
    }
    let active = initialized()?.model_id();
    let requested = model.config().model_id;
    anyhow::ensure!(
        active == requested,
        "embedding provider already initialized with '{active}', cannot switch to '{requested}'"
    );
    Ok(())
}

pub fn try_provider() -> Option<&'static dyn EmbeddingProvider> {
    PROVIDER.get().map(|b| b.as_ref())
}

fn initialized() -> anyhow::Result<&'static dyn EmbeddingProvider> {
    try_provider().context("embedding provider not initialized -- call init_provider first")
}

pub fn embed_query(text: &str) -> anyhow::Result<Vec<f32>> {
    initialized()?
        .embed_query(text)
        .context("embed_query failed")
}

pub fn embed_documents(texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
    initialized()?
        .embed_documents(texts)
        .context("embed_documents failed")
}

#[cfg(test)]
mod tests {
    // No lib test initialises the process-wide provider, so these calls reach
    // the uninitialised branch.
    #[test]
    fn embedding_before_init_is_an_error_not_a_panic() {
        let err = super::embed_query("q").expect_err("no provider, so no embedding");
        assert!(format!("{err:#}").contains("not initialized"), "{err:#}");
        assert!(super::embed_documents(&["d".to_string()]).is_err());
    }
}
