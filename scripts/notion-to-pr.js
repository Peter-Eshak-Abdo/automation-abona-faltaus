const { Octokit } = require("@octokit/rest");

// ── ENV Variables (مجيبينها من GitHub Secrets) ──────────────
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // تلقائي في Actions
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;

// ── Clients ──────────────────────────────────────────────────
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ============================================================
// 1️⃣  سحب المهام من Notion اللي Status = "To Do"
// ============================================================
async function fetchNotionTasks() {
  console.log("📋 Fetching tasks from Notion...");

  const response = await fetch(
    `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          property: "Status", // ← اسم الـ Property في Notion
          select: { equals: "🆕 New" }, // ← القيمة اللي بتفلتر بيها
        },
        page_size: 5, // بنشتغل على 5 tasks في كل run عشان منكملش الـ rate limit
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Notion API Error: ${response.status} ${await response.text()}`,
    );
  }

  const data = await response.json();

  // استخراج العنوان من كل Task
  return data.results.map((page) => ({
    id: page.id,
    title:
      page.properties["Task Name"]?.title?.[0]?.plain_text || "Untitled Task",
    description: page.properties["Notes"]?.rich_text?.[0]?.plain_text || "",
  }));
}

// ============================================================
// 2️⃣  تعديل Status المهمة في Notion → "In Progress"
//     (عشان ما يتعمل PR مكررة لنفس الـ Task)
// ============================================================
async function markTaskInProgress(pageId) {
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        Status: { select: { name: "🔄 In Progress" } },
      },
    }),
  });
  console.log(`✅ Notion task marked as In Progress: ${pageId}`);
}

// ============================================================
// 3️⃣  بعت الـ Task لـ Gemini وبيرجع Code Snippet
// ============================================================
async function generateCodeWithGemini(task) {
  console.log(`🤖 Asking Gemini for: "${task.title}"...`);

  const prompt = `
You are an expert Next.js developer working with TypeScript.
A task has been assigned to you from a project management system.

Task Title: ${task.title}
Task Description: ${task.description || "No description provided."}

Your job:
1. Analyze this task and determine what code changes or new files are needed.
2. Generate a realistic, production-quality code implementation for a Next.js + TypeScript project.
3. Return ONLY a JSON object (no markdown, no explanation) with this exact structure:

{
  "branchName": "feature/short-kebab-case-name",
  "commitMessage": "feat: short description of what was implemented",
  "prTitle": "PR title describing the feature",
  "prBody": "## Summary\\nWhat was done and why.\\n\\n## Changes\\n- List of changes",
  "files": [
    {
      "path": "relative/path/to/file.tsx",
      "content": "full file content here"
    }
  ]
}

Rules:
- branchName must start with "feature/" or "fix/" or "chore/"
- Generate 1-3 files maximum
- Use TypeScript and Next.js App Router conventions
- Keep code clean, typed, and production-ready
`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Gemini API Error: ${response.status} ${await response.text()}`,
    );
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Gemini returned no JSON:\n${rawText.slice(0, 300)}`);
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(`Gemini JSON truncated. Raw:\n${rawText.slice(0, 300)}`);
  }
}

// ============================================================
// 4️⃣  جلب الـ SHA الحالي لـ main branch
// ============================================================
async function getMainBranchSHA() {
  const { data } = await octokit.repos.getBranch({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    branch: "main",
  });
  return data.commit.sha;
}

// ============================================================
// 5️⃣  إنشاء Branch جديد على GitHub
// ============================================================
async function createBranch(branchName, baseSHA) {
  console.log(`🌿 Creating branch: ${branchName}`);
  try {
    await octokit.git.createRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `refs/heads/${branchName}`,
      sha: baseSHA,
    });
  } catch (err) {
    // لو الـ Branch موجود أصلاً، أضف timestamp عليه
    if (err.status === 422) {
      const uniqueBranch = `${branchName}-${Date.now()}`;
      console.log(`⚠️ Branch exists, using: ${uniqueBranch}`);
      await octokit.git.createRef({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        ref: `refs/heads/${uniqueBranch}`,
        sha: baseSHA,
      });
      return uniqueBranch;
    }
    throw err;
  }
  return branchName;
}

// ============================================================
// 6️⃣  Commit الملفات على الـ Branch
// ============================================================
async function commitFiles(branchName, files, commitMessage) {
  console.log(`💾 Committing ${files.length} file(s)...`);

  for (const file of files) {
    // تحقق لو الملف موجود (عشان نجيب SHA بتاعه للـ update)
    let existingFileSHA;
    try {
      const { data } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: file.path,
        ref: branchName,
      });
      existingFileSHA = data.sha;
    } catch {
      existingFileSHA = undefined; // الملف جديد
    }

    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: file.path,
      message: commitMessage,
      content: Buffer.from(file.content, "utf-8").toString("base64"),
      branch: branchName,
      sha: existingFileSHA,
    });

    console.log(`  ✓ ${file.path}`);
  }
}

// ============================================================
// 7️⃣  فتح Pull Request تلقائياً
// ============================================================
async function createPullRequest(branchName, prTitle, prBody) {
  console.log(`🚀 Opening Pull Request...`);

  const { data: pr } = await octokit.pulls.create({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: prTitle,
    body: `${prBody}\n\n---\n> 🤖 Auto-generated by Notion → Gemini → GitHub Actions`,
    head: branchName,
    base: "main",
  });

  console.log(`✅ PR created: ${pr.html_url}`);
  return pr.html_url;
}

// ============================================================
// 🚀 Main Runner
// ============================================================
async function main() {
  console.log("=".repeat(50));
  console.log("🔄 Starting Notion → PR Automation");
  console.log("=".repeat(50));

  // التحقق من الـ ENV Variables
  const required = {
    NOTION_TOKEN,
    NOTION_DB_ID,
    GEMINI_API_KEY,
    GITHUB_TOKEN,
    REPO_OWNER,
    REPO_NAME,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`❌ Missing environment variables: ${missing.join(", ")}`);
  }

  // 1. جلب المهام
  const tasks = await fetchNotionTasks();

  if (tasks.length === 0) {
    console.log("✨ No 'To Do' tasks found. Nothing to do!");
    return;
  }

  console.log(`📌 Found ${tasks.length} task(s) to process\n`);

  // 2. معالجة كل مهمة
  for (const task of tasks) {
    console.log(`\n${"─".repeat(40)}`);
    console.log(`📝 Processing: "${task.title}"`);

    try {
      // a. اطلب الكود من Gemini
      const generated = await generateCodeWithGemini(task);

      // b. اجيب SHA بتاع main
      const baseSHA = await getMainBranchSHA();

      // c. إنشاء Branch
      const finalBranch = await createBranch(generated.branchName, baseSHA);

      // d. Commit الملفات
      await commitFiles(finalBranch, generated.files, generated.commitMessage);

      // e. افتح PR
      const prUrl = await createPullRequest(
        finalBranch,
        generated.prTitle,
        generated.prBody,
      );

      // f. تحديث Status في Notion
      await markTaskInProgress(task.id);

      console.log(`\n🎉 Done! PR: ${prUrl}`);
    } catch (err) {
      // لو فيه error في task معينة، متوقفش - كمل على الباقي
      console.error(`\n❌ Failed for task "${task.title}":`, err.message);
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log("✅ Automation complete!");
}

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
