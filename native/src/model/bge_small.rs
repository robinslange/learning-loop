use std::path::Path;
use std::sync::Mutex;

use anyhow::Result;
use ort::{ep, session::Session, value::Tensor};
use tokenizers::Tokenizer;

use super::{EmbeddingProvider, ModelConfig};

const MODEL_ID: &str = "bge-small-en-v1.5";
const DIM: usize = 384;
const MAX_TOKENS: usize = 512;
const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";

pub fn config() -> ModelConfig {
    ModelConfig {
        model_id: MODEL_ID.to_string(),
        dim: DIM,
        max_tokens: MAX_TOKENS,
        query_prefix: Some(QUERY_PREFIX.to_string()),
        passage_prefix: None,
        needs_token_type_ids: true,
        needs_external_pooling: true,
        normalize_embeddings: true,
        output_tensor_name: None,
    }
}

pub struct BgeSmallProvider {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    config: ModelConfig,
}

impl BgeSmallProvider {
    pub fn from_files(model_path: &Path, tokenizer_path: &Path) -> Result<Self> {
        let session = Session::builder()
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .with_execution_providers([ep::CPU::default().build()])
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .commit_from_file(model_path)
            .map_err(|e| anyhow::anyhow!("{}", e))?;

        let mut tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| anyhow::anyhow!("{}", e))?;
        tokenizer
            .with_truncation(Some(tokenizers::TruncationParams {
                max_length: MAX_TOKENS,
                ..Default::default()
            }))
            .map_err(|e| anyhow::anyhow!("{}", e))?;
        tokenizer.with_padding(None);

        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
            config: config(),
        })
    }
}

impl EmbeddingProvider for BgeSmallProvider {
    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let batch_size = texts.len();

        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| anyhow::anyhow!("{}", e))?;

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
            Tensor::from_array((shape.clone(), input_ids_flat.into_boxed_slice()))?;
        let attention_mask_tensor =
            Tensor::from_array((shape.clone(), attention_mask_flat.into_boxed_slice()))?;
        let token_type_ids_tensor =
            Tensor::from_array((shape, token_type_ids_flat.into_boxed_slice()))?;

        let inputs = ort::inputs! {
            "input_ids" => input_ids_tensor,
            "attention_mask" => attention_mask_tensor,
            "token_type_ids" => token_type_ids_tensor,
        };

        let mut session = self.session.lock().expect("session lock poisoned");
        let outputs = session.run(inputs)?;

        let output = &outputs[0];
        let (out_shape, out_data) = output.try_extract_tensor::<f32>()?;

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

        Ok(results)
    }

    fn config(&self) -> &ModelConfig {
        &self.config
    }
}
