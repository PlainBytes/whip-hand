//! `apps/desktop/src/shared/protocol.gen.ts` must be what the Rust types
//! generate. `WHIPHAND_UPDATE_PROTOCOL=1` rewrites it.

use std::path::PathBuf;

#[test]
fn the_generated_ts_is_current() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src/shared/protocol.gen.ts");
    let want = whiphand_protocol::codegen::generate();
    if std::env::var_os("WHIPHAND_UPDATE_PROTOCOL").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &want).unwrap();
        return;
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        have == want,
        "{} is stale: run `WHIPHAND_UPDATE_PROTOCOL=1 cargo test -p whiphand-protocol --test codegen`",
        path.display()
    );
}
