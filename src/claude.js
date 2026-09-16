// Claude integration: keeps conversation history and streams replies.
const Anthropic = require("@anthropic-ai/sdk").default;
const store = require("./store");

const MAX_TURNS = 40; // user+assistant messages kept in history

class ChatSession {
  constructor() {
    this.messages = [];
    this.client = null;
    this.clientKey = null;
    this.activeStream = null;
  }

  reset() {
    this.abort();
    this.messages = [];
  }

  abort() {
    if (this.activeStream) {
      try {
        this.activeStream.abort();
      } catch {
        /* already finished */
      }
      this.activeStream = null;
    }
  }

  getClient() {
    const key = store.get("apiKey") || process.env.ANTHROPIC_API_KEY || "";
    if (!key) {
      throw new Error("No API key. Open settings (gear icon) and paste your Anthropic API key.");
    }
    if (!this.client || this.clientKey !== key) {
      this.client = new Anthropic({ apiKey: key });
      this.clientKey = key;
    }
    return this.client;
  }

  /**
   * Send a user turn. `image` is optional {data: base64, mediaType}.
   * `onDelta(text)` receives streamed text; resolves with the full reply.
   */
  async send({ text, image }, onDelta) {
    const client = this.getClient();
    this.abort();

    const content = [];
    if (image) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.data },
      });
    }
    content.push({
      type: "text",
      text: text && text.trim() ? text : "Look at my screen and help me with what is shown.",
    });
    this.messages.push({ role: "user", content });

    // Trim history but always keep pairs intact and start on a user turn.
    while (this.messages.length > MAX_TURNS) this.messages.shift();
    while (this.messages.length && this.messages[0].role !== "user") this.messages.shift();

    const model = store.get("model");
    const effort = store.get("effort");
    const params = {
      model,
      max_tokens: 8000,
      system: [
        { type: "text", text: store.get("systemPrompt"), cache_control: { type: "ephemeral" } },
      ],
      messages: this.messages,
      thinking: { type: "adaptive" },
      output_config: { effort },
    };
    // Haiku 4.5 does not accept adaptive thinking or effort.
    if (model.startsWith("claude-haiku")) {
      delete params.thinking;
      delete params.output_config;
    }

    const stream = client.messages.stream(params);
    this.activeStream = stream;

    let reply = "";
    try {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          reply += event.delta.text;
          onDelta(event.delta.text);
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") {
        const why = final.stop_details?.explanation || "The model declined this request.";
        reply = reply || `[Declined] ${why}`;
        onDelta(reply);
      }
      // Keep the full content (incl. thinking blocks) so follow-ups stay coherent.
      this.messages.push({ role: "assistant", content: final.content });
      return reply;
    } catch (err) {
      // Drop the unanswered user turn so the history stays valid.
      if (this.messages.at(-1)?.role === "user") this.messages.pop();
      if (err?.name === "APIUserAbortError") return reply;
      throw err;
    } finally {
      if (this.activeStream === stream) this.activeStream = null;
    }
  }
}

/** Convert SDK errors into a short human message for the overlay. */
function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Invalid API key. Check settings.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited. Try again in a moment.";
  if (err instanceof Anthropic.NotFoundError) return `Model not found: ${store.get("model")}`;
  if (err instanceof Anthropic.BadRequestError) return `Bad request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Network error reaching the Claude API.";
  if (err instanceof Anthropic.APIError) return `API error (${err.status}): ${err.message}`;
  return err?.message || String(err);
}

module.exports = { ChatSession, describeError };
