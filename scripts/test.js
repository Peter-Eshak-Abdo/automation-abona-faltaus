// ============================================================
// test.js - اختبار كل الـ APIs قبل التشغيل الكامل
// Run: node scripts/test.js
// ============================================================

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function testNotion() {
  console.log("\n📋 [1/3] Testing Notion API...");

  const response = await fetch(
    `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 1 }),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("❌ Notion Error:", data);
    return;
  }

  const firstPage = data.results[0];
  if (!firstPage) {
    console.log("⚠️  No pages found in DB");
    return;
  }

  // ← الأهم: نشوف أسماء الـ Properties الحقيقية
  console.log("✅ Notion connected!");
  console.log("📌 Available Properties:");
  Object.entries(firstPage.properties).forEach(([key, val]) => {
    console.log(`   - "${key}" (type: ${val.type})`);
  });

  // نشوف الـ Title الحقيقي
  const titleProp = Object.entries(firstPage.properties).find(
    ([, v]) => v.type === "title",
  );
  if (titleProp) {
    const titleValue = titleProp[1].title?.[0]?.plain_text || "(empty)";
    console.log(
      `\n📝 Title property name: "${titleProp[0]}" → value: "${titleValue}"`,
    );
  }
}

async function testGeminiModels() {
  console.log("\n🤖 [2/3] Finding available Gemini models...");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`,
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("❌ Gemini Error:", data);
    return;
  }

  const flashModels = data.models
    ?.filter(
      (m) =>
        m.name.includes("flash") &&
        m.supportedGenerationMethods?.includes("generateContent"),
    )
    .map((m) => m.name);

  console.log("✅ Available Flash models:");
  flashModels?.forEach((m) => console.log(`   - ${m}`));
}

async function testGeminiGenerate() {
  console.log("\n⚡ [3/3] Testing Gemini generate...");

  // جرب الموديلات دي بالترتيب
  const modelsToTry = [
    "gemini-2.0-flash",
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash-002",
    "gemini-pro",
  ];

  for (const model of modelsToTry) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Say "hello" in one word only.' }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
      },
    );

    if (response.ok) {
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      console.log(`✅ Working model: "${model}" → response: "${text?.trim()}"`);
      console.log(
        `\n💡 Use this in notion-to-pr.js:\n   models/${model}:generateContent`,
      );
      return model;
    } else {
      console.log(`   ❌ ${model} → not available`);
    }
  }

  console.error("❌ No working Gemini model found!");
}

async function main() {
  console.log("=".repeat(50));
  console.log("🧪 Running API Tests");
  console.log("=".repeat(50));

  const missing = [];
  if (!NOTION_TOKEN) missing.push("NOTION_TOKEN");
  if (!NOTION_DB_ID) missing.push("NOTION_DATABASE_ID");
  if (!GEMINI_API_KEY) missing.push("GEMINI_API_KEY");

  if (missing.length) {
    console.error(`\n❌ Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  await testNotion();
  await testGeminiModels();
  await testGeminiGenerate();

  console.log("\n" + "=".repeat(50));
  console.log("✅ Tests complete!");
}

main().catch((err) => {
  console.error("💥 Fatal:", err.message);
  process.exit(1);
});
