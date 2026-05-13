use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result};
use ort::{ep, session::Session, value::Tensor};
use serde::Serialize;
use tokenizers::Tokenizer;

const NLI_MODEL: &[u8] = include_bytes!("../model/nli_model_quantized.onnx");
const NLI_TOKENIZER: &[u8] = include_bytes!("../model/nli_tokenizer.json");

pub const NLI_SCHEMA_VERSION: u32 = 1;

#[derive(Serialize)]
pub struct NliResult {
    pub entailment: f64,
    pub neutral: f64,
    pub contradiction: f64,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct NliBatchResponse {
    pub schema_version: u32,
    pub results: Vec<NliResult>,
}

#[derive(Serialize)]
pub struct NliCheckResponse {
    pub schema_version: u32,
    pub result: NliResult,
}

struct NliState {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
}

static STATE: OnceLock<NliState> = OnceLock::new();

fn build_state() -> Result<NliState> {
    let session = Session::builder()
        .map_err(|e| anyhow::anyhow!("session builder: {e}"))?
        .with_execution_providers([ep::CPU::default().build()])
        .map_err(|e| anyhow::anyhow!("attach CPU execution provider: {e}"))?
        .commit_from_memory(NLI_MODEL)
        .map_err(|e| anyhow::anyhow!("load NLI model from embedded bytes: {e}"))?;

    let mut tokenizer = Tokenizer::from_bytes(NLI_TOKENIZER)
        .map_err(|e| anyhow::anyhow!("load NLI tokenizer: {e}"))?;
    tokenizer
        .with_truncation(Some(tokenizers::TruncationParams {
            max_length: 512,
            ..Default::default()
        }))
        .map_err(|e| anyhow::anyhow!("set tokenizer truncation: {e}"))?;
    tokenizer.with_padding(None);

    let st = NliState {
        session: Mutex::new(session),
        tokenizer,
    };

    // Startup sanity-check: known entailing pair. If the embedded model's
    // id2label ordering ever drifts from {0=entailment, 1=neutral, 2=contradiction},
    // this assertion fires before any inference reaches the hook. The pair is
    // a clean MNLI-style entailment — premise concretely supports hypothesis.
    let sanity = classify_pair_inner(&st, "A cat is sitting on a mat.", "An animal is on the mat.")
        .context("startup sanity-check inference failed")?;
    if sanity.label != "entailment" {
        anyhow::bail!(
            "NLI model id2label drift: expected entailment for sanity pair, got {} (e={:.3} n={:.3} c={:.3}). Check id2label ordering in nli.rs.",
            sanity.label, sanity.entailment, sanity.neutral, sanity.contradiction
        );
    }

    Ok(st)
}

fn state() -> &'static NliState {
    STATE.get_or_init(|| match build_state() {
        Ok(st) => st,
        Err(e) => panic!("NLI initialisation failed: {e:#}"),
    })
}

fn softmax(logits: &[f64]) -> Vec<f64> {
    let max = logits.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let exps: Vec<f64> = logits.iter().map(|&x| (x - max).exp()).collect();
    let sum: f64 = exps.iter().sum();
    exps.iter().map(|&e| e / sum).collect()
}

pub fn nli_check(text_a: &str, text_b: &str) -> NliCheckResponse {
    let st = state();
    NliCheckResponse {
        schema_version: NLI_SCHEMA_VERSION,
        result: classify_pair(st, text_a, text_b),
    }
}

pub fn nli_batch(text_a: &str, texts_b: &[String]) -> NliBatchResponse {
    let st = state();
    let results = texts_b
        .iter()
        .map(|text_b| classify_pair(st, text_a, text_b))
        .collect();
    NliBatchResponse {
        schema_version: NLI_SCHEMA_VERSION,
        results,
    }
}

fn classify_pair(st: &NliState, text_a: &str, text_b: &str) -> NliResult {
    match classify_pair_inner(st, text_a, text_b) {
        Ok(r) => r,
        Err(e) => NliResult {
            entailment: 0.0,
            neutral: 0.0,
            contradiction: 0.0,
            label: "error".to_string(),
            error: Some(format!("{e:#}")),
        },
    }
}

fn classify_pair_inner(st: &NliState, text_a: &str, text_b: &str) -> Result<NliResult> {
    let encoding = st
        .tokenizer
        .encode((text_a, text_b), true)
        .map_err(|e| anyhow::anyhow!("tokenize pair: {e}"))?;

    let ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
    let mask: Vec<i64> = encoding
        .get_attention_mask()
        .iter()
        .map(|&m| m as i64)
        .collect();

    let len = ids.len() as i64;
    let shape = vec![1i64, len];

    let input_ids = Tensor::from_array((shape.clone(), ids.into_boxed_slice()))
        .map_err(|e| anyhow::anyhow!("build input_ids tensor: {e}"))?;
    let attention_mask = Tensor::from_array((shape, mask.into_boxed_slice()))
        .map_err(|e| anyhow::anyhow!("build attention_mask tensor: {e}"))?;

    let inputs = ort::inputs! {
        "input_ids" => input_ids,
        "attention_mask" => attention_mask,
    };

    let mut session = st
        .session
        .lock()
        .map_err(|_| anyhow::anyhow!("NLI session lock poisoned"))?;
    let outputs = session
        .run(inputs)
        .map_err(|e| anyhow::anyhow!("NLI inference: {e}"))?;
    let logits_output = outputs
        .get("logits")
        .context("NLI model output 'logits' missing")?;
    let (_, data) = logits_output
        .try_extract_tensor::<f32>()
        .map_err(|e| anyhow::anyhow!("extract NLI logits tensor: {e}"))?;

    let logits: Vec<f64> = data.iter().map(|&x| x as f64).collect();
    if logits.len() != 3 {
        anyhow::bail!(
            "expected 3 NLI logits (entailment/neutral/contradiction), got {}",
            logits.len()
        );
    }
    let probs = softmax(&logits);

    // id2label for MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli: 0=entailment, 1=neutral, 2=contradiction
    // Verified at startup via build_state() sanity assertion.
    let entailment = probs[0];
    let neutral = probs[1];
    let contradiction = probs[2];

    let label = if entailment >= contradiction && entailment >= neutral {
        "entailment"
    } else if contradiction >= neutral {
        "contradiction"
    } else {
        "neutral"
    };

    Ok(NliResult {
        entailment,
        neutral,
        contradiction,
        label: label.to_string(),
        error: None,
    })
}
