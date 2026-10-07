//! RECOVERED (2026-08-04): this emitter was authored during @ergots/avltree
//! Phase B (prover engine) but was never committed to the ergots repo — it
//! existed only as an untracked file in the ergo_avltree_rust fork checkout
//! (~/projects/ergo_avltree_rust/tests/prover_fixtures.rs). It was recovered
//! 2026-08-04 from that fork checkout, where it existed only untracked, via a
//! one-time user-sanctioned working-tree read, and is preserved here verbatim
//! as the origin of the committed fixtures in
//! packages/avltree/test/fixtures/prover/*.json — everything below this
//! header is byte-identical to the recovered file.
//!
//! REGENERATION (this file is preserved in-repo for exactly this):
//!   1. git -C ~/projects/ergo_avltree_rust worktree add --detach <scratch>/avltree-e-emitter 568e7c3
//!   2. cp this file to <worktree>/tests/prover_fixtures.rs
//!   3. cd <worktree> && ERGOTS_FIXTURE_DIR=<ergots-repo>/packages/avltree/test/fixtures/prover \
//!        cargo test --test prover_fixtures -- --nocapture
//!   4. Run a second time into a scratch dir and diff against committed — must be EMPTY.
//!   5. git -C ~/projects/ergo_avltree_rust worktree remove --force <worktree>
//!   Reference: ergo_avltree_rust @568e7c3 (canonical main at generation time).
//!
//!   Reproduction result: reproduces the committed fixtures byte-identically
//!   at 568e7c3 (verified 2026-08-04) — all 10 committed JSON fixtures in
//!   packages/avltree/test/fixtures/prover/ matched sha256-for-sha256 across
//!   two independent runs of this emitter in a fresh --detach worktree.
//!
//! Generate prover fixtures for the TS @ergots/avltree package.
//!
//! Each test case writes a JSON fixture to
//!   ~/projects/ergots/packages/avltree/test/fixtures/prover/
//!
//! Fixture format:
//! {
//!   "name": "...",
//!   "config": { "keyLength": N, "valueLengthOpt": null | M },
//!   "operations": [ { "tag": "...", "keyHex": "...", "valueHex": "..."? } ],
//!   "genProofAfter": [idx, ...],
//!   "expectedProofs": ["hex...", ...],
//!   "expectedDigests": ["hex...", ...]
//! }
//!
//! The TS prover test: creates a BatchAVLProver, applies operations,
//! calls generateProof() at each genProofAfter index, and asserts the
//! proof bytes and digest match byte-for-byte.

use ergo_avltree_rust::authenticated_tree_ops::AuthenticatedTreeOps;
use ergo_avltree_rust::batch_avl_prover::BatchAVLProver;
use ergo_avltree_rust::batch_node::*;
use ergo_avltree_rust::operation::*;
use bytes::Bytes;
use std::fs;
use std::path::PathBuf;

fn fixture_dir() -> PathBuf {
    let dir = PathBuf::from(
        std::env::var("ERGOTS_FIXTURE_DIR")
            .unwrap_or_else(|_| "../packages/avltree/test/fixtures/prover".to_string()),
    );
    fs::create_dir_all(&dir).ok();
    dir
}

fn make_prover(key_length: usize, value_length_opt: Option<usize>) -> BatchAVLProver {
    let tree = AVLTree::new(
        |digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)),
        key_length,
        value_length_opt,
    );
    BatchAVLProver::new(tree, false)
}

fn key(v: u8) -> ADKey {
    Bytes::from(vec![v; 32])
}
fn val(v: &[u8]) -> ADValue {
    Bytes::from(v.to_vec())
}
fn val8(v: &[u8]) -> ADValue {
    let mut b = vec![0u8; 8];
    let n = v.len().min(8);
    b[..n].copy_from_slice(&v[..n]);
    Bytes::from(b)
}

fn insert_op(key: &ADKey, value: &ADValue) -> Operation {
    Operation::Insert(KeyValue { key: key.clone(), value: value.clone() })
}
fn remove_op(key: &ADKey) -> Operation {
    Operation::Remove(key.clone())
}
fn update_op(key: &ADKey, value: &ADValue) -> Operation {
    Operation::Update(KeyValue { key: key.clone(), value: value.clone() })
}

struct Fixture {
    name: String,
    config_key_length: usize,
    config_value_length_opt: Option<usize>,
    operations: Vec<Operation>,
    gen_proof_after: Vec<usize>,
    expected_proofs: Vec<Vec<u8>>,
    expected_digests: Vec<Vec<u8>>,
}

impl Fixture {
    fn write_json(&self) {
        let mut ops_json = String::from("[\n");
        for (i, op) in self.operations.iter().enumerate() {
            if i > 0 { ops_json.push_str(",\n"); }
            ops_json.push_str("    ");
            ops_json.push_str(&op_to_json(op, self.config_value_length_opt));
        }
        ops_json.push_str("\n  ]");

        let proofs_json: Vec<String> = self.expected_proofs.iter()
            .map(|p| format!("\"{}\"", base16::encode_lower(p)))
            .collect();
        let digests_json: Vec<String> = self.expected_digests.iter()
            .map(|d| format!("\"{}\"", base16::encode_lower(d)))
            .collect();
        let gen_after_json: Vec<String> = self.gen_proof_after.iter()
            .map(|i| i.to_string())
            .collect();

        let vlo = match self.config_value_length_opt {
            Some(n) => n.to_string(),
            None => "null".to_string(),
        };

        let json = format!(
            r#"{{
  "name": "{}",
  "config": {{
    "keyLength": {},
    "valueLengthOpt": {}
  }},
  "operations": {},
  "genProofAfter": [{}],
  "expectedProofs": [{}],
  "expectedDigests": [{}]
}}"#,
            self.name,
            self.config_key_length,
            vlo,
            ops_json,
            gen_after_json.join(", "),
            proofs_json.join(",\n    "),
            digests_json.join(",\n    "),
        );

        let path = fixture_dir().join(format!("{}.json", self.name));
        fs::write(&path, json).unwrap();
        println!("Wrote {}", path.display());
    }
}

fn op_to_json(op: &Operation, value_length_opt: Option<usize>) -> String {
    match op {
        Operation::Insert(kv) => format!(
            r#"{{ "tag": "Insert", "keyHex": "{}", "valueHex": "{}" }}"#,
            base16::encode_lower(&kv.key),
            base16::encode_lower(&kv.value),
        ),
        Operation::Update(kv) => format!(
            r#"{{ "tag": "Update", "keyHex": "{}", "valueHex": "{}" }}"#,
            base16::encode_lower(&kv.key),
            base16::encode_lower(&kv.value),
        ),
        Operation::Remove(key) => format!(
            r#"{{ "tag": "Remove", "keyHex": "{}" }}"#,
            base16::encode_lower(key),
        ),
        Operation::Lookup(key) => format!(
            r#"{{ "tag": "Lookup", "keyHex": "{}" }}"#,
            base16::encode_lower(key),
        ),
        Operation::InsertOrUpdate(kv) => format!(
            r#"{{ "tag": "InsertOrUpdate", "keyHex": "{}", "valueHex": "{}" }}"#,
            base16::encode_lower(&kv.key),
            base16::encode_lower(&kv.value),
        ),
        Operation::RemoveIfExists(key) => format!(
            r#"{{ "tag": "RemoveIfExists", "keyHex": "{}" }}"#,
            base16::encode_lower(key),
        ),
        Operation::UpdateLongBy(kd) => {
            format!(
                r#"{{ "tag": "UpdateLongBy", "keyHex": "{}", "delta": {} }}"#,
                base16::encode_lower(&kd.key),
                kd.delta,
            )
        },
        Operation::UnknownModification(key) => format!(
            r#"{{ "tag": "UnknownModification", "keyHex": "{}" }}"#,
            base16::encode_lower(key),
        ),
    }
}

/// Helper: apply ops, call genProof at specified indices, capture proofs + digests.
fn run_fixture(
    name: &str,
    key_length: usize,
    value_length_opt: Option<usize>,
    operations: Vec<Operation>,
    gen_proof_after: Vec<usize>,
) {
    let mut prover = make_prover(key_length, value_length_opt);
    let mut proofs: Vec<Vec<u8>> = Vec::new();
    let mut digests: Vec<Vec<u8>> = Vec::new();
    let mut gen_idx = 0;

    for (i, op) in operations.iter().enumerate() {
        prover.perform_one_operation(op).unwrap();
        if gen_idx < gen_proof_after.len() && gen_proof_after[gen_idx] == i {
            proofs.push(prover.generate_proof().to_vec());
            digests.push(prover.digest().unwrap().to_vec());
            gen_idx += 1;
        }
    }

    Fixture {
        name: name.to_string(),
        config_key_length: key_length,
        config_value_length_opt: value_length_opt,
        operations,
        gen_proof_after,
        expected_proofs: proofs,
        expected_digests: digests,
    }
    .write_json();
}

// ── Fixture cases ────────────────────────────────────────────────────────────

#[test]
fn gen_fixtures() {
    // Case 1: Single Insert, variable-length values, 32-byte keys
    run_fixture(
        "insert-single",
        32,
        None,
        vec![insert_op(&key(0x42), &val(&[1, 2, 3, 4]))],
        vec![0],
    );

    // Case 2: Insert → genProof → Remove → genProof (THE BUG SCENARIO)
    run_fixture(
        "insert-genproof-remove-genproof",
        32,
        None,
        vec![
            insert_op(&key(0x42), &val(&[1, 2, 3, 4])),
            remove_op(&key(0x42)),
        ],
        vec![0, 1],
    );

    // Case 3: Multi-batch: Insert → genProof → Insert → genProof → Update → genProof
    run_fixture(
        "multi-batch-insert-insert-update",
        32,
        None,
        vec![
            insert_op(&key(0x01), &val(&[10, 20])),
            insert_op(&key(0x02), &val(&[30, 40])),
            update_op(&key(0x02), &val(&[50, 60])),
        ],
        vec![0, 1, 2],
    );

    // Case 4: Insert+Remove in single batch (no intermediate genProof)
    run_fixture(
        "batch-insert-remove",
        32,
        None,
        vec![
            insert_op(&key(0x42), &val(&[1, 2, 3, 4])),
            remove_op(&key(0x42)),
        ],
        vec![1],
    );

    // Case 5: Lookup across genProof boundary
    run_fixture(
        "insert-genproof-lookup-genproof",
        32,
        None,
        vec![
            insert_op(&key(0x07), &val(&[9, 9])),
            Operation::Lookup(key(0x07)),
        ],
        vec![0, 1],
    );

    // Case 6: Fixed-length values (8 bytes)
    run_fixture(
        "fixed-value-insert-genproof-remove",
        32,
        Some(8),
        vec![
            insert_op(&key(0x42), &val8(&[1, 2, 3, 4, 5, 6, 7, 8])),
            remove_op(&key(0x42)),
        ],
        vec![0, 1],
    );

    // Case 7: 3 inserts, single genProof (multi-op batch)
    run_fixture(
        "batch-3-inserts",
        32,
        None,
        vec![
            insert_op(&key(0xAA), &val(&[1, 2])),
            insert_op(&key(0xBB), &val(&[3, 4])),
            insert_op(&key(0xCC), &val(&[5, 6])),
        ],
        vec![2],
    );

    // Case 8: UpdateLongBy across genProof
    run_fixture(
        "insert-genproof-updatelongby-genproof",
        32,
        Some(8),
        vec![
            insert_op(&key(0x42), &val8(&[100, 0, 0, 0, 0, 0, 0, 0])),
            Operation::UpdateLongBy(KeyDelta {
                key: key(0x42),
                delta: 50,
            }),
        ],
        vec![0, 1],
    );

    // Case 9: InsertOrUpdate + Remove across genProof
    run_fixture(
        "insertorupdate-genproof-remove-genproof",
        32,
        None,
        vec![
            Operation::InsertOrUpdate(KeyValue { key: key(0x55), value: val(&[7, 7, 7]) }),
            remove_op(&key(0x55)),
        ],
        vec![0, 1],
    );

    // Case 10: Multiple keys, structural variety (triggers internal node rebalancing)
    run_fixture(
        "multi-key-structural",
        32,
        None,
        vec![
            insert_op(&key(0x10), &val(&[1])),
            insert_op(&key(0x20), &val(&[2])),
            insert_op(&key(0x30), &val(&[3])),
            insert_op(&key(0x40), &val(&[4])),
            insert_op(&key(0x50), &val(&[5])),
        ],
        vec![2, 4],
    );
}
