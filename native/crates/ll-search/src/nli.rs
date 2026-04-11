use std::sync::{Mutex, OnceLock};

use ort::{ep, session::Session, value::Tensor};
use serde::Serialize;
use tokenizers::Tokenizer;

const NLI_MODEL: &[u8] = include_bytes!("../model/nli_model_quantized.onnx");
const NLI_TOKENIZER: &[u8] = include_bytes!("../model/nli_tokenizer.json");

#[derive(Serialize)]
pub struct NliResult {
    pub entailment: f64,
    pub neutral: f64,
    pub contradiction: f64,
    pub label: String,
}

struct NliState {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
}

static STATE: OnceLock<NliState> = OnceLock::new();

fn state() -> &'static NliState {
    STATE.get_or_init(|| {
        let session = Session::builder()
            .expect("session builder")
            .with_execution_providers([ep::CPU::default().build()])
            .expect("CPU EP")
            .commit_from_memory(NLI_MODEL)
            .expect("load NLI model");

        let mut tokenizer =
            Tokenizer::from_bytes(NLI_TOKENIZER).expect("load NLI tokenizer");
        tokenizer
            .with_truncation(Some(tokenizers::TruncationParams {
                max_length: 512,
                ..Default::default()
            }))
            .expect("set truncation");
        tokenizer.with_padding(None);

        NliState {
            session: Mutex::new(session),
            tokenizer,
        }
    })
}

fn softmax(logits: &[f64]) -> Vec<f64> {
    let max = logits.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let exps: Vec<f64> = logits.iter().map(|&x| (x - max).exp()).collect();
    let sum: f64 = exps.iter().sum();
    exps.iter().map(|&e| e / sum).collect()
}

pub fn nli_check(text_a: &str, text_b: &str) -> NliResult {
    let st = state();
    classify_pair(st, text_a, text_b)
}

pub fn nli_batch(text_a: &str, texts_b: &[String]) -> Vec<NliResult> {
    let st = state();
    texts_b
        .iter()
        .map(|text_b| classify_pair(st, text_a, text_b))
        .collect()
}

fn classify_pair(st: &NliState, text_a: &str, text_b: &str) -> NliResult {
    let encoding = st
        .tokenizer
        .encode((text_a, text_b), true)
        .expect("tokenize pair");

    let ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
    let mask: Vec<i64> = encoding
        .get_attention_mask()
        .iter()
        .map(|&m| m as i64)
        .collect();

    let len = ids.len() as i64;
    let shape = vec![1i64, len];

    let input_ids =
        Tensor::from_array((shape.clone(), ids.into_boxed_slice())).expect("input_ids tensor");
    let attention_mask =
        Tensor::from_array((shape, mask.into_boxed_slice())).expect("attention_mask tensor");

    let inputs = ort::inputs! {
        "input_ids" => input_ids,
        "attention_mask" => attention_mask,
    };

    let mut session = st.session.lock().expect("session lock");
    let outputs = session.run(inputs).expect("NLI inference");
    let (_, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .expect("extract NLI output");

    let logits: Vec<f64> = data.iter().map(|&x| x as f64).collect();
    let probs = softmax(&logits);

    // id2label: 0=contradiction, 1=entailment, 2=neutral
    let contradiction = probs[0];
    let entailment = probs[1];
    let neutral = probs[2];

    let label = if entailment >= contradiction && entailment >= neutral {
        "entailment"
    } else if contradiction >= neutral {
        "contradiction"
    } else {
        "neutral"
    };

    NliResult {
        entailment,
        neutral,
        contradiction,
        label: label.to_string(),
    }
}
