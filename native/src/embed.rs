use std::sync::{Mutex, OnceLock};

use ort::{
    ep,
    session::Session,
    value::Tensor,
};
use tokenizers::Tokenizer;

const MODEL_BYTES: &[u8] = include_bytes!("../model/model_quantized.onnx");
const TOKENIZER_BYTES: &[u8] = include_bytes!("../model/tokenizer.json");

pub const BGE_QUERY_PREFIX: &str =
    "Represent this sentence for searching relevant passages: ";
pub const EMBED_DIM: usize = 384;

struct EmbedState {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
}

static STATE: OnceLock<EmbedState> = OnceLock::new();

fn state() -> &'static EmbedState {
    STATE.get_or_init(|| {
        let session = Session::builder()
            .expect("failed to create session builder")
            .with_execution_providers([ep::CPU::default().build()])
            .expect("failed to set CPU execution provider")
            .commit_from_memory(MODEL_BYTES)
            .expect("failed to load ONNX model from memory");

        let mut tokenizer = Tokenizer::from_bytes(TOKENIZER_BYTES)
            .expect("failed to load tokenizer");
        tokenizer.with_truncation(Some(tokenizers::TruncationParams {
            max_length: 512,
            ..Default::default()
        })).expect("failed to set truncation");
        tokenizer.with_padding(None);

        EmbedState {
            session: Mutex::new(session),
            tokenizer,
        }
    })
}

pub fn embedding_dim() -> usize {
    EMBED_DIM
}

pub fn embed_query(text: &str) -> Vec<f32> {
    let prefixed = format!("{}{}", BGE_QUERY_PREFIX, text);
    embed_batch(&[prefixed]).into_iter().next().unwrap()
}

pub fn embed_documents(texts: &[String]) -> Vec<Vec<f32>> {
    if texts.is_empty() {
        return Vec::new();
    }
    embed_batch(texts)
}

fn embed_batch(texts: &[String]) -> Vec<Vec<f32>> {
    let st = state();
    let batch_size = texts.len();

    let encodings = st
        .tokenizer
        .encode_batch(texts.to_vec(), true)
        .expect("tokenization failed");

    let max_len = encodings.iter().map(|e| e.get_ids().len()).max().unwrap_or(0);

    let mut input_ids_flat: Vec<i64> = Vec::with_capacity(batch_size * max_len);
    let mut attention_mask_flat: Vec<i64> = Vec::with_capacity(batch_size * max_len);
    let mut token_type_ids_flat: Vec<i64> = Vec::with_capacity(batch_size * max_len);

    for enc in &encodings {
        let ids = enc.get_ids();
        let mask = enc.get_attention_mask();
        let type_ids = enc.get_type_ids();
        let seq_len = ids.len();

        for j in 0..max_len {
            if j < seq_len {
                input_ids_flat.push(ids[j] as i64);
                attention_mask_flat.push(mask[j] as i64);
                token_type_ids_flat.push(type_ids[j] as i64);
            } else {
                input_ids_flat.push(0);
                attention_mask_flat.push(0);
                token_type_ids_flat.push(0);
            }
        }
    }

    let shape = vec![batch_size as i64, max_len as i64];

    let input_ids_tensor =
        Tensor::from_array((shape.clone(), input_ids_flat.into_boxed_slice()))
            .expect("failed to create input_ids tensor");
    let attention_mask_tensor =
        Tensor::from_array((shape.clone(), attention_mask_flat.into_boxed_slice()))
            .expect("failed to create attention_mask tensor");
    let token_type_ids_tensor =
        Tensor::from_array((shape, token_type_ids_flat.into_boxed_slice()))
            .expect("failed to create token_type_ids tensor");

    let inputs = ort::inputs! {
        "input_ids" => input_ids_tensor,
        "attention_mask" => attention_mask_tensor,
        "token_type_ids" => token_type_ids_tensor,
    };

    let mut session = st.session.lock().expect("session lock poisoned");
    let outputs = session.run(inputs).expect("inference failed");

    let output = &outputs[0];
    let (out_shape, out_data) = output
        .try_extract_tensor::<f32>()
        .expect("failed to extract output tensor");

    let out_dims: Vec<usize> = out_shape.iter().map(|&d| d as usize).collect();
    let hidden_dim = out_dims[2];

    let mut results = Vec::with_capacity(batch_size);

    for i in 0..batch_size {
        let enc = &encodings[i];
        let seq_len = enc.get_attention_mask().iter().filter(|&&v| v == 1).count();

        let mut pooled = vec![0.0f32; hidden_dim];
        for j in 0..seq_len {
            let offset = i * max_len * hidden_dim + j * hidden_dim;
            for d in 0..hidden_dim {
                pooled[d] += out_data[offset + d];
            }
        }

        let denom = seq_len as f32;
        for d in 0..hidden_dim {
            pooled[d] /= denom;
        }

        let norm: f32 = pooled.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for d in 0..hidden_dim {
                pooled[d] /= norm;
            }
        }

        results.push(pooled);
    }

    results
}
