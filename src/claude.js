// Claude integration: keeps conversation history and streams replies.
const Anthropic = require("@anthropic-ai/sdk").default;
const store = require("./store");

const MAX_TURNS = 40; // user+assistant messages kept in history
const MAX_STREAM_ATTEMPTS = 3;

function isTransient(err) {
  if (err?.name === "APIUserAbortError") return false;
  if (err instanceof Anthropic.APIConnectionError) return true;
  // Mid-stream errors (e.g. overloaded) arrive as APIError; status may be absent.
  if (err instanceof Anthropic.APIError) return !err.status || err.status === 429 || err.status >= 500;
  // A socket reset mid-stream can surface as a plain TypeError from fetch.
  return err instanceof TypeError && /terminated|network|fetch failed/i.test(err.message);
}

// The low-level reason behind a connection failure (ECONNRESET, ENOTFOUND, ...).
function rootCause(err) {
  let e = err;
  while (e?.cause) e = e.cause;
  return e && e !== err ? e.code || e.message : "";
}

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

  // Remove a user turn that never got a reply, even if a newer request has
  // already been appended after it, so history keeps alternating roles.
  dropUnanswered(userTurn) {
    const i = this.messages.indexOf(userTurn);
    if (i !== -1 && this.messages[i + 1]?.role !== "assistant") this.messages.splice(i, 1);
  }

  getClient() {
    const key = store.get("apiKey") || process.env.ANTHROPIC_API_KEY || "";
    if (!key) {
      throw new Error("No API key. Open settings (gear icon) and paste your Anthropic API key.");
    }
    if (!this.client || this.clientKey !== key) {
      // A long-running overlay outlives sleep/wake and Wi-Fi changes, so the first
      // request after one often lands on a dead connection. Retry more than the
      // default 2, and fail a silent connection in 2 minutes instead of 10.
      this.client = new Anthropic({ apiKey: key, maxRetries: 4, timeout: 120_000 });
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
    const userTurn = { role: "user", content };
    this.messages.push(userTurn);

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

    let stream;
    let reply = "";
    try {
      // The SDK retries only until the response starts. A stream that drops
      // before any text arrived is safe to start over, since nothing is on screen.
      for (let attempt = 1; ; attempt++) {
        stream = client.messages.stream(params);
        this.activeStream = stream;
        try {
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              reply += event.delta.text;
              onDelta(event.delta.text);
            }
          }
          break;
        } catch (err) {
          if (reply || attempt >= MAX_STREAM_ATTEMPTS || !isTransient(err)) throw err;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          if (this.activeStream !== stream) {
            // Stopped or superseded while waiting: end quietly, like an abort.
            this.dropUnanswered(userTurn);
            return reply;
          }
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
      this.dropUnanswered(userTurn);
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
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "Timed out reaching the Claude API. Try again.";
  if (err instanceof Anthropic.APIConnectionError) {
    const cause = rootCause(err);
    return `Network error reaching the Claude API${cause ? ` (${cause})` : ""}. Try again.`;
  }
  if (err instanceof Anthropic.APIError && (err.status === 529 || /overloaded/i.test(err.message))) {
    return "Claude is overloaded right now. Try again in a moment.";
  }
  if (err instanceof Anthropic.APIError) return `API error (${err.status ?? "stream"}): ${err.message}`;
  return err?.message || String(err);
}

module.exports = { ChatSession, describeError };
