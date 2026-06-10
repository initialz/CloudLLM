// 假上游:9100 端口,/v1/chat/completions(OpenAI)与 /v1/messages(Anthropic),支持流式
import { createServer } from "node:http";

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    const isOpenAI = req.url.includes("chat/completions");
    if (body.stream && isOpenAI) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"流式OK"}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":20,"completion_tokens":4},"choices":[]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        isOpenAI
          ? { id: "fake-openai", model: body.model, usage: { prompt_tokens: 100, completion_tokens: 50 } }
          : { id: "fake-anthropic", model: body.model, usage: { input_tokens: 80, output_tokens: 40 } },
      ),
    );
  });
});

server.listen(9100, () => console.log("fake upstream on :9100"));
