//! 保证 `admin-ui/dist/` 在 rust-embed 读取前存在。
//! dist 不进 git(根 .gitignore 的 dist/ 规则);首次 cargo build 时生成占位页,
//! 运行 `cd admin-ui && npm ci && npm run build` 后真实产物覆盖占位,
//! 下次 cargo build 即嵌入真实 UI。

use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    ensure_placeholder(&manifest_dir.join("admin-ui/dist"));
    println!("cargo:rerun-if-changed=admin-ui/dist");
}

fn ensure_placeholder(dist: &Path) {
    // 恒存的微型探针资产:让 immutable 缓存分支可被确定性测试(真实构建产物存在时也保留)
    let probe = dist.join("assets/cloudllm-probe-cafebabe.js");
    if !probe.exists() {
        std::fs::create_dir_all(dist.join("assets")).expect("创建 dist/assets");
        std::fs::write(&probe, "// cloudllm probe\n").expect("写探针资产");
    }

    let index = dist.join("index.html");
    // 存在但 0 字节(被中断的 npm build 残留)视同缺失,重写占位
    if index.exists()
        && std::fs::metadata(&index)
            .map(|m| m.len() > 0)
            .unwrap_or(false)
    {
        return;
    }
    std::fs::create_dir_all(dist.join("assets")).expect("创建 admin-ui/dist/assets");
    let html = r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>CloudLLM Console</title>
<style>body{background:#06080f;color:#e2e8f0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center;height:100vh;margin:0}code{color:#22d3ee}</style>
</head><body><div>
<p>admin-ui 尚未构建。在仓库根目录执行:</p>
<pre><code>cd admin-ui &amp;&amp; npm ci &amp;&amp; npm run build</code></pre>
<p>然后重新 <code>cargo build</code>。JSON API(<code>/admin/api/*</code>)不受影响。</p>
</div></body></html>"#;
    std::fs::write(&index, html).expect("写占位 index.html");
}
