/**
 * Minimal connectivity test — validates @github/copilot-sdk works end-to-end.
 * Usage: tsx src/testLlm.ts
 */
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  console.log("🧪 Testing @github/copilot-sdk connectivity...\n");

  const githubToken =
    process.env.COPILOT_GITHUB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN;
  const openAiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!githubToken && !openAiKey && !anthropicKey) {
    console.error("❌ No auth credentials found. Set one of these in .env:");
    console.error("   GITHUB_TOKEN=ghp_...         GitHub PAT with Copilot access");
    console.error("   OPENAI_API_KEY=sk-...        BYOK — OpenAI");
    console.error("   ANTHROPIC_API_KEY=sk-ant-... BYOK — Anthropic");
    process.exit(1);
  }

  const { CopilotClient } = await import("@github/copilot-sdk");

  const clientOptions: Record<string, unknown> = {};
  if (githubToken) {
    clientOptions.githubToken = githubToken;
    console.log(`   Using GitHub token (${githubToken.slice(0, 8)}...)`);
  }

  console.log("1. Starting client...");
  const client = new CopilotClient(clientOptions as any);
  await client.start();
  console.log("   ✅ Client started");

  let modelName = process.env.COPILOT_MODEL ?? "gpt-5.2";
  const sessionConfig: Record<string, unknown> = {};

  if (!githubToken && openAiKey) {
    console.log("   Using BYOK — OpenAI");
    modelName = "gpt-4o";
    sessionConfig.provider = { type: "openai", baseUrl: "https://api.openai.com/v1", apiKey: openAiKey };
  } else if (!githubToken && anthropicKey) {
    console.log("   Using BYOK — Anthropic");
    modelName = "claude-sonnet-4-5";
    sessionConfig.provider = { type: "anthropic", apiKey: anthropicKey };
  }
  sessionConfig.model = modelName;

  console.log("2. Creating session...");
  const session = await client.createSession(sessionConfig as any);
  console.log("   ✅ Session created:", session.sessionId);

  console.log("3. Sending test prompt...");

  let fullResponse = "";
  const startTime = Date.now();

  const result = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout after 60s — no response from model")), 60000);

    session.on("assistant.message_delta", (event: any) => {
      const delta = event.data?.deltaContent ?? "";
      process.stdout.write(delta);
      fullResponse += delta;
    });

    session.on("assistant.message", (event: any) => {
      clearTimeout(timer);
      const content = event.data?.content ?? fullResponse;
      process.stdout.write("\n");
      resolve(content);
    });

    session.on("error" as any, (event: any) => {
      clearTimeout(timer);
      reject(new Error(`Session error: ${JSON.stringify(event)}`));
    });

    session.send({ prompt: 'Reply with exactly: {"status":"ok","model":"<your model name>"}' }).catch(reject);
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n   ✅ Got response in ${elapsed}s`);

  try {
    const parsed = JSON.parse(result.match(/\{[\s\S]*\}/)?.[0] ?? result);
    console.log("   ✅ Response is valid JSON:", parsed);
  } catch {
    console.log("   ℹ️  Response (not JSON):", result.slice(0, 200));
  }

  await session.destroy();
  await client.stop();
  console.log("\n✅ SDK connectivity confirmed — LLM integration is working.");
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err.message);
  process.exit(1);
});
