//! CloudLLM v2 — Rust 一体化 LLM 网关(hub + admin-ui)。

/// 当前 unix epoch 秒。全工程统一时间来源。
pub fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时钟早于 1970")
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_epoch_is_reasonable() {
        // 2026-01-01 之后、2100 年之前
        let t = now_epoch();
        assert!(t > 1_767_225_600 && t < 4_102_444_800);
    }
}
