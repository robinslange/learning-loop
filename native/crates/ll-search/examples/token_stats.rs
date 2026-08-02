//! Exact token-length distribution for a vault, using the real bge-small
//! tokenizer rather than a bytes-per-token estimate.
//!
//! Answers the only question that sizes chunking work: after the byte cap is
//! fixed, how many notes still exceed the model's 512-token window, and by how
//! much? A note 10% over loses a paragraph; a note 5x over is mostly unseen.
//!
//! cargo run --release --example token_stats -- <vault> [tokenizer.json]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ll_search::preprocess::preprocess_file;
use tokenizers::Tokenizer;

const MAX_TOKENS: usize = 512;

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.starts_with('_') {
            continue;
        }
        if p.is_dir() {
            walk(&p, out);
        } else if name.ends_with(".md") {
            out.push(p);
        }
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let vault = args.next().expect("usage: token_stats <vault> [tokenizer.json]");
    let tok_path = args.next().unwrap_or_else(|| {
        format!(
            "{}/.learning-loop/models/bge-small-en-v1.5/tokenizer.json",
            std::env::var("HOME").unwrap()
        )
    });

    // No truncation configured here: we want the TRUE length, not what the
    // model would keep.
    let tokenizer = Tokenizer::from_file(&tok_path).expect("load tokenizer");

    let vault_path = PathBuf::from(&vault);
    let mut files = Vec::new();
    walk(&vault_path, &mut files);

    let mut per_folder: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for f in &files {
        let Ok(raw) = std::fs::read_to_string(f) else {
            continue;
        };
        let filename = f.file_name().unwrap().to_string_lossy().to_string();
        let Some(result) = preprocess_file(&raw, &filename) else {
            continue;
        };
        let Ok(enc) = tokenizer.encode(result.text.as_str(), false) else {
            continue;
        };
        let folder = f
            .strip_prefix(&vault_path)
            .ok()
            .and_then(|r| r.components().next().map(|c| c.as_os_str().to_string_lossy().to_string()))
            .unwrap_or_else(|| "?".into());
        per_folder.entry(folder).or_default().push(enc.len());
    }

    let all: Vec<usize> = per_folder.values().flatten().copied().collect();
    let pctl = |v: &mut Vec<usize>, p: f64| {
        v.sort_unstable();
        if v.is_empty() { 0 } else { v[((p * (v.len() - 1) as f64) as usize).min(v.len() - 1)] }
    };

    println!("Exact token lengths (bge-small tokenizer), window = {MAX_TOKENS}\n");
    println!(
        "{:<16} {:>6} {:>8} {:>7} {:>7} {:>7} {:>9}",
        "folder", "notes", "over512", "p50", "p90", "max", "seen%"
    );

    let mut rows: Vec<(String, Vec<usize>)> =
        per_folder.into_iter().map(|(k, v)| (k, v)).collect();
    rows.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));

    for (folder, mut lens) in rows {
        let n = lens.len();
        let over = lens.iter().filter(|&&t| t > MAX_TOKENS).count();
        let total: usize = lens.iter().sum();
        let seen: usize = lens.iter().map(|&t| t.min(MAX_TOKENS)).sum();
        let p50 = pctl(&mut lens.clone(), 0.5);
        let p90 = pctl(&mut lens.clone(), 0.9);
        let max = *lens.iter().max().unwrap_or(&0);
        println!(
            "{:<16} {:>6} {:>7.1}% {:>7} {:>7} {:>7} {:>8.1}%",
            folder,
            n,
            100.0 * over as f64 / n as f64,
            p50,
            p90,
            max,
            100.0 * seen as f64 / total as f64
        );
    }

    let n = all.len();
    let over = all.iter().filter(|&&t| t > MAX_TOKENS).count();
    let total: usize = all.iter().sum();
    let seen: usize = all.iter().map(|&t| t.min(MAX_TOKENS)).sum();
    println!(
        "\noverall: {n} notes, {:.1}% over the window, {:.1}% of tokens inside it",
        100.0 * over as f64 / n as f64,
        100.0 * seen as f64 / total as f64
    );
    // Chunking only pays where the tail is large enough to hold a distinct
    // idea. Notes just over the window lose a sentence, not a section.
    for mult in [1.5f64, 2.0, 4.0] {
        let c = all.iter().filter(|&&t| t as f64 > MAX_TOKENS as f64 * mult).count();
        println!(
            "  over {}x the window: {c} notes ({:.1}%)",
            mult,
            100.0 * c as f64 / n as f64
        );
    }
}
