use anyhow::{Context, Result};
use serde::Serialize;

pub fn emit<T: Serialize>(value: &T, pretty: bool) -> Result<()> {
    let s = if pretty {
        serde_json::to_string_pretty(value)
    } else {
        serde_json::to_string(value)
    }
    .context("serialize response to JSON")?;
    println!("{s}");
    Ok(())
}
