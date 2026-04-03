use std::path::Path;
use std::sync::Mutex;

use anyhow::Result;
use ort::{ep, session::Session, value::Tensor};
use tokenizers::Tokenizer;

use super::{EmbeddingProvider, ModelConfig};

const MODEL_ID: &str = "onnx-community/embeddinggemma-300m-ONNX";
const DIM: usize = 768;
const MAX_TOKENS: usize = 2048;
const QUERY_PREFIX: &str = "task: search result | query: ";
const PASSAGE_PREFIX: &str = "title: none | text: ";

pub fn config() -> ModelConfig {
    ModelConfig {
        model_id: MODEL_ID.to_string(),
        dim: DIM,
        max_tokens: MAX_TOKENS,
        query_prefix: Some(QUERY_PREFIX.to_string()),
        passage_prefix: Some(PASSAGE_PREFIX.to_string()),
        needs_token_type_ids: false,
        needs_external_pooling: false,
        normalize_embeddings: true,
        output_tensor_name: Some("sentence_embedding".to_string()),
    }
}

pub struct EmbeddingGemmaProvider {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    config: ModelConfig,
}

impl EmbeddingGemmaProvider {
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

impl EmbeddingProvider for EmbeddingGemmaProvider {
    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let batch_size = texts.len();

        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| anyhow::anyhow!("{}", e))?;

        let max_len = encodings.iter().map(|e| e.get_ids().len()).max().unwrap_or(0);

        let mut input_ids_flat: Vec<i64> = Vec::with_capacity(batch_size * max_len);
        let mut attention_mask_flat: Vec<i64> = Vec::with_capacity(batch_size * max_len);

        for enc in &encodings {
            let ids = enc.get_ids();
            let mask = enc.get_attention_mask();
            let seq_len = ids.len();

            for j in 0..max_len {
                if j < seq_len {
                    input_ids_flat.push(ids[j] as i64);
                    attention_mask_flat.push(mask[j] as i64);
                } else {
                    input_ids_flat.push(0);
                    attention_mask_flat.push(0);
                }
            }
        }

        let shape = vec![batch_size as i64, max_len as i64];

        let input_ids_tensor =
            Tensor::from_array((shape.clone(), input_ids_flat.into_boxed_slice()))?;
        let attention_mask_tensor =
            Tensor::from_array((shape, attention_mask_flat.into_boxed_slice()))?;

        let inputs = ort::inputs! {
            "input_ids" => input_ids_tensor,
            "attention_mask" => attention_mask_tensor,
        };

        let mut session = self.session.lock().expect("session lock poisoned");
        let outputs = session.run(inputs)?;

        let output = &outputs[1];
        let (_out_shape, out_data) = output.try_extract_tensor::<f32>()?;

        let mut results = Vec::with_capacity(batch_size);

        for i in 0..batch_size {
            let offset = i * DIM;
            let mut embedding = out_data[offset..offset + DIM].to_vec();

            let norm: f32 = embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 0.0 {
                for d in 0..DIM {
                    embedding[d] /= norm;
                }
            }

            results.push(embedding);
        }

        Ok(results)
    }

    fn config(&self) -> &ModelConfig {
        &self.config
    }
}
