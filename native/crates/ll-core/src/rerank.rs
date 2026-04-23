use std::sync::{Mutex, OnceLock};

use ort::{ep, session::Session, value::Tensor};
use serde::Serialize;
use tokenizers::Tokenizer;

const RERANKER_MODEL: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/reranker.onnx"));
const RERANKER_TOKENIZER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/reranker_tokenizer.json"));

#[derive(Serialize)]
pub struct RerankResult {
    pub index: usize,
    pub score: f64,
    pub path: String,
}

struct RerankState {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
}

static STATE: OnceLock<RerankState> = OnceLock::new();

fn state() -> &'static RerankState {
    STATE.get_or_init(|| {
        let session = Session::builder()
            .expect("session builder")
            .with_execution_providers([ep::CPU::default().build()])
            .expect("CPU EP")
            .commit_from_memory(RERANKER_MODEL)
            .expect("load reranker model");

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
        }
    })
}

pub fn rerank(query: &str, documents: &[(String, String)], top_n: usize) -> Vec<RerankResult> {
    let st = state();
    let mut results: Vec<RerankResult> = Vec::with_capacity(documents.len());

    for (i, (path, text)) in documents.iter().enumerate() {
        let score = match score_pair(st, query, text) {
            Some(s) => s,
            None => {
                eprintln!("rerank: skipping document, inference failed");
                continue;
            }
        };
        results.push(RerankResult {
            index: i,
            score,
            path: path.clone(),
        });
    }

    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_n);
    results
}

fn score_pair(st: &RerankState, query: &str, document: &str) -> Option<f64> {
    let encoding = st
        .tokenizer
        .encode((query, document), true)
        .ok()?;

    let ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
    let mask: Vec<i64> = encoding
        .get_attention_mask()
        .iter()
        .map(|&m| m as i64)
        .collect();
    let type_ids: Vec<i64> = encoding
        .get_type_ids()
        .iter()
        .map(|&t| t as i64)
        .collect();

    let len = ids.len() as i64;
    let shape = vec![1i64, len];

    let input_ids =
        Tensor::from_array((shape.clone(), ids.into_boxed_slice())).ok()?;
    let attention_mask =
        Tensor::from_array((shape.clone(), mask.into_boxed_slice())).ok()?;
    let token_type_ids =
        Tensor::from_array((shape, type_ids.into_boxed_slice())).ok()?;

    let inputs = ort::inputs! {
        "input_ids" => input_ids,
        "attention_mask" => attention_mask,
        "token_type_ids" => token_type_ids,
    };

    let mut session = st.session.lock().ok()?;
    let outputs = session.run(inputs).ok()?;
    let (_, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .ok()?;

    Some(data[0] as f64)
}
