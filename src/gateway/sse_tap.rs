//! SSE 流用量旁路解析器。原样转发的同时把字节喂进 tap;流结束(正常 flush 或中断 cancel)
//! 后取已解析用量结算。容忍跨 chunk 断行与断字符。

use crate::billing::{extract_usage_from_json, Protocol, Usage};
use serde_json::Value;

pub struct UsageTap {
    protocol: Protocol,
    buffer: Vec<u8>,
    usage: Usage,
}

impl UsageTap {
    pub fn new(protocol: Protocol) -> Self {
        Self {
            protocol,
            buffer: Vec::new(),
            usage: Usage::default(),
        }
    }

    /// 喂入一段字节。按 \n 切出整行解析;未完行留缓冲。
    pub fn feed(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
        // 逐个完整行(以 \n 结尾)切出处理;未完行留缓冲
        while let Some(pos) = self.buffer.iter().position(|&b| b == b'\n') {
            // 取出 [0, pos) 行;丢弃 \n
            let line_bytes: Vec<u8> = self.buffer.drain(..=pos).take(pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            self.consume_line(line.trim());
        }
    }

    /// 流结束:处理缓冲里残留的最后一行(若无尾随 \n)。
    pub fn finish(&mut self) -> Usage {
        if !self.buffer.is_empty() {
            let tail: Vec<u8> = std::mem::take(&mut self.buffer);
            let line = String::from_utf8_lossy(&tail);
            self.consume_line(line.trim());
        }
        self.usage
    }

    fn consume_line(&mut self, line: &str) {
        let Some(rest) = line.strip_prefix("data:") else {
            return;
        };
        let payload = rest.trim();
        if payload.is_empty() || payload == "[DONE]" {
            return;
        }
        if let Ok(evt) = serde_json::from_str::<Value>(payload) {
            self.consume_event(&evt);
        }
        // 非 JSON 行忽略
    }

    fn consume_event(&mut self, evt: &Value) {
        match self.protocol {
            Protocol::Openai => {
                if evt.get("usage").map(Value::is_object).unwrap_or(false) {
                    self.usage = extract_usage_from_json(Protocol::Openai, evt);
                }
            }
            Protocol::Anthropic => match evt.get("type").and_then(Value::as_str) {
                Some("message_start") => {
                    if let Some(msg) = evt.get("message") {
                        let partial = extract_usage_from_json(Protocol::Anthropic, msg);
                        // input/cache 取 message_start;output 保留已累计值(中断时为 0)
                        self.usage = Usage {
                            output_tokens: self.usage.output_tokens,
                            ..partial
                        };
                    }
                }
                Some("message_delta") => {
                    if let Some(ot) = evt
                        .get("usage")
                        .and_then(|u| u.get("output_tokens"))
                        .and_then(Value::as_i64)
                    {
                        self.usage.output_tokens = ot;
                    }
                }
                _ => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tap(p: Protocol) -> UsageTap {
        UsageTap::new(p)
    }

    #[test]
    fn openai_extracts_final_usage_across_split_lines() {
        let mut t = tap(Protocol::Openai);
        t.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
        // 同一行拆成两个网络包
        t.feed(b"data: {\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":3,");
        t.feed(
            b"\"prompt_tokens_details\":{\"cached_tokens\":2}},\"choices\":[]}\n\ndata: [DONE]\n\n",
        );
        assert_eq!(
            t.finish(),
            Usage {
                input_tokens: 10,
                output_tokens: 3,
                cache_read_tokens: 2,
                cache_write_tokens: 0
            }
        );
    }

    #[test]
    fn openai_no_usage_is_zero() {
        let mut t = tap(Protocol::Openai);
        t.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\ndata: [DONE]\n\n");
        assert_eq!(t.finish(), Usage::default());
    }

    #[test]
    fn anthropic_start_then_delta_overrides_output() {
        let mut t = tap(Protocol::Anthropic);
        t.feed(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":25,\"cache_read_input_tokens\":5,\"cache_creation_input_tokens\":1,\"output_tokens\":1}}}\n\n");
        t.feed(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":42}}\n\n");
        t.feed(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":77}}\n\n");
        assert_eq!(
            t.finish(),
            Usage {
                input_tokens: 25,
                output_tokens: 77,
                cache_read_tokens: 5,
                cache_write_tokens: 1
            }
        );
    }

    #[test]
    fn anthropic_ignores_heartbeat_and_non_json() {
        let mut t = tap(Protocol::Anthropic);
        t.feed(b": ping\n\n");
        t.feed(b"data: not-json\n\n");
        assert_eq!(t.finish(), Usage::default());
    }

    #[test]
    fn openai_crlf_line_endings() {
        let mut t = tap(Protocol::Openai);
        t.feed(b"data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5},\"choices\":[]}\r\ndata: [DONE]\r\n");
        assert_eq!(
            t.finish(),
            Usage {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_tokens: 0,
                cache_write_tokens: 0
            }
        );
    }

    #[test]
    fn anthropic_interrupted_no_delta_output_zero() {
        // 只有 message_start(output_tokens=1),无 message_delta → output 记 0
        let mut t = tap(Protocol::Anthropic);
        t.feed(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":25,\"output_tokens\":1}}}\n\n");
        assert_eq!(
            t.finish(),
            Usage {
                input_tokens: 25,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0
            }
        );
    }

    #[test]
    fn utf8_split_across_chunks() {
        // "你"(E4 BD A0)被拆成两个 feed:断字符不应破坏后续行解析
        let mut t = tap(Protocol::Openai);
        // 一行 content 含中文,跨包断在中文字节中间
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n"
            .as_bytes()
            .to_vec();
        let (a, b) = line.split_at(line.len() - 5);
        t.feed(a);
        t.feed(b);
        // 再喂含 usage 的完整行
        t.feed(b"data: {\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4},\"choices\":[]}\n");
        assert_eq!(t.finish().output_tokens, 4);
    }

    #[test]
    fn finish_flushes_trailing_line_without_newline() {
        // 最后一行没有尾随 \n,finish 必须处理
        let mut t = tap(Protocol::Openai);
        t.feed(b"data: {\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":2},\"choices\":[]}");
        assert_eq!(t.finish().input_tokens, 8);
    }
}
