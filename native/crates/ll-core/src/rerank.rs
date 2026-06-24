//! Cross-encoder reranking using a bundled ONNX model.
//!
//! The reranker scores query-document pairs and returns documents ordered by
//! relevance. It is loaded lazily on first use via a `OnceLock`.

use std::sync::{Mutex, OnceLock};

use ort::{ep, session::Session, value::Tensor};
use serde::Serialize;
use tokenizers::Tokenizer;

const RERANKER_MODEL: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/reranker.onnx"));
const RERANKER_TOKENIZER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/reranker_tokenizer.json"));

/// A single reranked result returned by [`rerank`].
#[derive(Debug, Serialize)]
pub struct RerankResult {
    /// Original zero-based position of this document in the input `documents` slice.
    pub index: usize,
    /// Cross-encoder relevance score; higher is more relevant.
    pub score: f64,
    /// Note path for this document.
    pub path: String,
}

struct RerankState {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    /// Whether the loaded ONNX graph expects a `token_type_ids` input.
    /// BERT-family cross-encoders (MiniLM, BGE) do; some others (Jina v1 turbo,
    /// RoBERTa-derived rerankers) don't. Introspected at session load.
    wants_token_type_ids: bool,
}

static STATE: OnceLock<RerankState> = OnceLock::new();

fn state() -> &'static RerankState {
    STATE.get_or_init(|| {
        crate::dylib::ensure_dylib().expect("locating ONNX Runtime");
        let session = Session::builder()
            .expect("session builder")
            .with_execution_providers([ep::CPU::default().build()])
            .expect("CPU EP")
            .commit_from_memory(RERANKER_MODEL)
            .expect("load reranker model");

        let wants_token_type_ids = session
            .inputs()
            .iter()
            .any(|o| o.name() == "token_type_ids");

        let mut tokenizer =
            Tokenizer::from_bytes(RERANKER_TOKENIZER).expect("load reranker tokenizer");
        tokenizer
            .with_truncation(Some(tokenizers::TruncationParams {
                max_length: 512,
                ..Default::default()
            }))
            .expect("set truncation");
        tokenizer.with_padding(None);

        RerankState {
            session: Mutex::new(session),
            tokenizer,
            wants_token_type_ids,
        }
    })
}

/// A document for which cross-encoder scoring failed during [`rerank_with_report`].
#[derive(Debug, Serialize)]
pub struct RerankFailure {
    /// Zero-based position of this document in the input `documents` slice.
    pub index: usize,
    /// Note path for this document.
    pub path: String,
    /// Human-readable reason the document was not scored.
    pub reason: String,
}

/// Return value of [`rerank_with_report`], distinguishing scored from failed documents.
///
/// Use this instead of [`rerank`] when the caller needs to log or surface
/// inference failures rather than silently dropping them.
#[derive(Debug, Serialize)]
pub struct RerankReport {
    /// Documents that were successfully scored, sorted by descending relevance.
    pub scored: Vec<RerankResult>,
    /// Documents that could not be scored, in original input order.
    pub failed: Vec<RerankFailure>,
}

/// Score each `(path, text)` pair against `query` and return the top `top_n`
/// results ordered by descending relevance.
///
/// Documents for which inference fails are silently skipped. If all documents
/// fail, an empty vec is returned. The `index` field of each result corresponds
/// to the document's original position in the `documents` slice.
///
/// Use [`rerank_with_report`] when failures should be surfaced rather than dropped.
pub fn rerank(query: &str, documents: &[(String, String)], top_n: usize) -> Vec<RerankResult> {
    rerank_with_report(query, documents, top_n).scored
}

/// Score each `(path, text)` pair against `query`, returning both scored results
/// and a record of any documents that failed inference.
///
/// Scored results are sorted by descending relevance and truncated to `top_n`.
/// Failed documents appear in the `failed` field in their original input order.
/// The `index` field in both [`RerankResult`] and [`RerankFailure`] corresponds
/// to the document's original position in the `documents` slice.
pub fn rerank_with_report(
    query: &str,
    documents: &[(String, String)],
    top_n: usize,
) -> RerankReport {
    let st = state();
    let mut scored: Vec<RerankResult> = Vec::with_capacity(documents.len());
    let mut failed: Vec<RerankFailure> = Vec::new();

    for (i, (path, text)) in documents.iter().enumerate() {
        match score_pair_typed(st, query, text) {
            Ok(score) => scored.push(RerankResult {
                index: i,
                score,
                path: path.clone(),
            }),
            Err(reason) => failed.push(RerankFailure {
                index: i,
                path: path.clone(),
                reason,
            }),
        }
    }

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_n);
    RerankReport { scored, failed }
}

fn score_pair_typed(st: &RerankState, query: &str, document: &str) -> Result<f64, String> {
    let encoding = st
        .tokenizer
        .encode((query, document), true)
        .map_err(|e| format!("tokenization failed: {e}"))?;

    let ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
    let mask: Vec<i64> = encoding
        .get_attention_mask()
        .iter()
        .map(|&m| m as i64)
        .collect();

    let len = ids.len() as i64;
    let shape = vec![1i64, len];

    let input_ids = Tensor::from_array((shape.clone(), ids.into_boxed_slice()))
        .map_err(|e| format!("tensor build failed: {e}"))?;
    let attention_mask = Tensor::from_array((shape.clone(), mask.into_boxed_slice()))
        .map_err(|e| format!("tensor build failed: {e}"))?;

    let mut session = st
        .session
        .lock()
        .map_err(|_| "reranker session mutex poisoned".to_string())?;

    let outputs = if st.wants_token_type_ids {
        let type_ids: Vec<i64> = encoding
            .get_type_ids()
            .iter()
            .map(|&t| t as i64)
            .collect();
        let token_type_ids = Tensor::from_array((shape, type_ids.into_boxed_slice()))
            .map_err(|e| format!("tensor build failed: {e}"))?;
        let inputs = ort::inputs! {
            "input_ids" => input_ids,
            "attention_mask" => attention_mask,
            "token_type_ids" => token_type_ids,
        };
        session
            .run(inputs)
            .map_err(|e| format!("inference failed: {e}"))?
    } else {
        let inputs = ort::inputs! {
            "input_ids" => input_ids,
            "attention_mask" => attention_mask,
        };
        session
            .run(inputs)
            .map_err(|e| format!("inference failed: {e}"))?
    };
    let (_, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("output extract failed: {e}"))?;

    Ok(data[0] as f64)
}
