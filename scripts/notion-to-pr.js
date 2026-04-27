const { Octokit } = require("@octokit/rest");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ============================================================
// ⏱️  Rate Limit Helpers
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// بيحاول يبعت الـ request، ولو جاله 429 بيستنى ويحاول تاني
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429) return response;

    const waitMs = attempt * 15000; // 15s, 30s, 45s
    console.log(
      `   ⚠️ Rate limited (429). Waiting ${waitMs / 1000}s before retry ${attempt}/${maxRetries}...`,
    );
    await sleep(waitMs);
  }
  // آخر محاولة بدون catch
  return fetch(url, options);
}

// ============================================================
// 0️⃣  جلب File Tree من الـ Repo كامل
// ============================================================
async function getRepoFileTree() {
  console.log("🗂️  Fetching repository file tree...");
  try {
    const { data: ref } = await octokit.git.getRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: "heads/main",
    });
    const { data: commit } = await octokit.git.getCommit({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      commit_sha: ref.object.sha,
    });
    const { data: tree } = await octokit.git.getTree({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      tree_sha: commit.tree.sha,
      recursive: "true",
    });
    const ignored = /node_modules|\.next|\.git|dist|build|\.lock|\.log/;
    const files = tree.tree
      .filter((f) => f.type === "blob" && !ignored.test(f.path))
      .map((f) => f.path);
    console.log(`   ✓ Found ${files.length} files in repo`);
    return files;
  } catch (err) {
    console.warn("   ⚠️ Could not fetch file tree:", err.message);
    return [];
  }
}

// ============================================================
// 📄  جلب محتوى ملف معين
// ============================================================
async function getFileContent(filePath) {
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: filePath,
    });
    if (data.content)
      return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    /* new file */
  }
  return null;
}

// ============================================================
// 1️⃣  سحب المهام من Notion
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
        filter: { property: "Status", select: { equals: "🆕 New" } },
        sorts: [{ property: "Priority", direction: "descending" }],
        page_size: 10,
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      `Notion API Error: ${response.status} ${await response.text()}`,
    );
  const data = await response.json();

  return data.results.map((page) => {
    const notesText =
      page.properties["Notes"]?.rich_text?.[0]?.plain_text || "";
    const filesMatch = notesText.match(/Files: (.+)/);
    const dependsMatch = notesText.match(/Depends on: (.+)/);
    const descLines = notesText
      .split("\n")
      .filter(
        (l) =>
          !l.startsWith("Received:") &&
          !l.startsWith("Files:") &&
          !l.startsWith("Depends on:"),
      );
    return {
      id: page.id,
      title:
        page.properties["Task Name"]?.title?.[0]?.plain_text || "Untitled Task",
      description: descLines.join("\n").trim(),
      targetFiles: filesMatch
        ? filesMatch[1]
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean)
        : [],
      dependsOn: dependsMatch ? dependsMatch[1].trim() : null,
      priority: page.properties["Priority"]?.select?.name || "🟡 Medium",
    };
  });
}

// ============================================================
// 🔗  فحص الـ Dependencies
// ============================================================
async function checkDependencyReady(dependsOnTitle, allTasks) {
  if (!dependsOnTitle) return { ready: true };
  const depInQueue = allTasks.find((t) =>
    t.title.toLowerCase().includes(dependsOnTitle.toLowerCase()),
  );
  if (depInQueue) {
    return {
      ready: false,
      reason: `"${dependsOnTitle}" لسه Status = New في الـ queue`,
    };
  }
  // تأكد من Notion
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
          and: [
            {
              property: "Task Name",
              title: { contains: dependsOnTitle.slice(0, 50) },
            },
            { property: "Status", select: { equals: "🆕 New" } },
          ],
        },
      }),
    },
  );
  const data = await response.json();
  if (data.results?.length > 0) {
    return { ready: false, reason: `"${dependsOnTitle}" لسه New في Notion` };
  }
  return { ready: true };
}

// ============================================================
// 2️⃣  تعديل Status → In Progress
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
      properties: { Status: { select: { name: "🔄 In Progress" } } },
    }),
  });
  console.log(`   ✅ Notion → In Progress`);
}

// ============================================================
// 3️⃣  توليد الكود - Model Fallback Chain
//     Gemini 2.5 Flash → Gemini 2.0 Flash → Groq (Llama 3.3 70B)
// ============================================================

// بناء الـ prompt (مشترك بين كل الموديلات)
function buildPrompt(task, fileTree, targetFileContents) {
  let targetFilesContext = "";
  if (Object.keys(targetFileContents).length > 0) {
    targetFilesContext = "\n## Current Content of Target Files:\n";
    for (const [path, content] of Object.entries(targetFileContents)) {
      targetFilesContext += `\n### ${path}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\`\n`;
    }
  }
  const treePreview = fileTree.slice(0, 80).join("\n");
  return `You are an expert Next.js + TypeScript developer with full visibility into the project.

## Project File Tree:
\`\`\`
${treePreview}
${fileTree.length > 80 ? `... and ${fileTree.length - 80} more files` : ""}
\`\`\`
${targetFilesContext}

## Task:
- Title: ${task.title}
- Description: ${task.description || "No additional description."}
- Target Files: ${task.targetFiles.length > 0 ? task.targetFiles.join(", ") : "Infer from task"}
- Priority: ${task.priority}

Return ONLY a raw JSON object, NO markdown, NO backticks, NO text before or after:
{"branchName":"feature/name","commitMessage":"feat: desc","prTitle":"PR title","prBody":"## Summary\nDetails","files":[{"path":"path/file.tsx","content":"complete file content"}]}

Rules: branchName starts with feature/ or fix/ or chore/, 1-3 files max, complete TypeScript/Next.js code.`;
}

// استخرج JSON من الـ response
function parseJSON(rawText) {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON found in response`);
  return JSON.parse(jsonMatch[0]);
}

// Model 1: Gemini 2.5 Flash
async function callGemini25Flash(prompt) {
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
      }),
    },
  );
  if (!res.ok) throw new Error(`429_OR_ERROR:${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Model 2: Gemini 2.0 Flash
async function callGemini20Flash(prompt) {
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
      }),
    },
  );
  if (!res.ok) throw new Error(`429_OR_ERROR:${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Model 3: Groq (Llama 3.3 70B) - 14,400 req/day مجاناً
async function callGroq(prompt) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set - skipping Groq");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 8192,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq Error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// الـ Main function مع الـ Fallback Chain
async function generateCodeWithGemini(task, fileTree, targetFileContents) {
  const prompt = buildPrompt(task, fileTree, targetFileContents);
  const models = [
    { name: "Gemini 2.5 Flash", fn: callGemini25Flash },
    { name: "Gemini 2.0 Flash", fn: callGemini20Flash },
    { name: "Groq Llama 3.3 70B", fn: callGroq },
  ];

  for (const model of models) {
    console.log(`🤖 Trying ${model.name}...`);
    try {
      const rawText = await model.fn(prompt);
      const result = parseJSON(rawText);
      console.log(`   ✅ Success with ${model.name}`);
      return result;
    } catch (err) {
      const isRateLimit =
        err.message.includes("429") ||
        err.message.includes("RESOURCE_EXHAUSTED") ||
        err.message.includes("quota");
      if (isRateLimit) {
        console.log(`   ⚠️ ${model.name} rate limited → trying next model...`);
        continue;
      }
      // لو مش rate limit، ارمي الـ error
      throw err;
    }
  }
  throw new Error(
    "All AI models exhausted (rate limited). Try again tomorrow or add more API keys.",
  );
}

// ============================================================
// 4️⃣  جلب SHA الـ main
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
// 5️⃣  إنشاء Branch
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
    if (err.status === 422) {
      const uniqueBranch = `${branchName}-${Date.now()}`;
      console.log(`   ⚠️ Branch exists, using: ${uniqueBranch}`);
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
// 6️⃣  Commit الملفات
// ============================================================
async function commitFiles(branchName, files, commitMessage) {
  console.log(`💾 Committing ${files.length} file(s)...`);
  for (const file of files) {
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
      existingFileSHA = undefined;
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
    console.log(`   ✓ ${file.path}`);
  }
}

// ============================================================
// 7️⃣  فتح Pull Request
// ============================================================
async function createPullRequest(branchName, prTitle, prBody, task) {
  console.log(`🚀 Opening Pull Request...`);
  const fullBody = [
    prBody,
    "",
    "---",
    "### 📋 Task Details",
    `- **Task**: ${task.title}`,
    task.targetFiles.length > 0
      ? `- **Files**: \`${task.targetFiles.join("`, `")}\``
      : null,
    task.dependsOn ? `- **Depended on**: ${task.dependsOn}` : null,
    `- **Priority**: ${task.priority}`,
    "",
    "> 🤖 Auto-generated by Notion → Gemini → GitHub Actions",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const { data: pr } = await octokit.pulls.create({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: prTitle,
    body: fullBody,
    head: branchName,
    base: "main",
  });
  console.log(`   ✅ PR: ${pr.html_url}`);
  return pr.html_url;
}

// ============================================================
// 🚀 Main
// ============================================================
async function main() {
  console.log("=".repeat(50));
  console.log("🔄 Starting Notion → PR Automation v2.0");
  console.log("=".repeat(50));

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
  if (missing.length)
    throw new Error(`❌ Missing env vars: ${missing.join(", ")}`);

  // جلب file tree مرة واحدة لكل الـ tasks
  const fileTree = await getRepoFileTree();
  const tasks = await fetchNotionTasks();

  if (tasks.length === 0) {
    console.log("✨ No New tasks found. Nothing to do!");
    return;
  }
  console.log(`\n📌 Found ${tasks.length} task(s)\n`);

  for (const task of tasks) {
    console.log(`\n${"─".repeat(40)}`);
    console.log(`📝 "${task.title}"`);
    try {
      // 1. فحص الـ Dependencies
      if (task.dependsOn) {
        console.log(`🔗 Checking dependency: "${task.dependsOn}"...`);
        const depCheck = await checkDependencyReady(task.dependsOn, tasks);
        if (!depCheck.ready) {
          console.log(`   ⏸️  Skipping: ${depCheck.reason}`);
          continue;
        }
        console.log(`   ✅ Dependency cleared!`);
      }

      // 2. جلب محتوى الملفات المستهدفة
      const targetFileContents = {};
      if (task.targetFiles.length > 0) {
        console.log(`📁 Fetching ${task.targetFiles.length} target file(s)...`);
        for (const filePath of task.targetFiles) {
          const content = await getFileContent(filePath);
          if (content) {
            targetFileContents[filePath] = content;
            console.log(`   ✓ ${filePath} (${content.length} chars)`);
          } else {
            console.log(`   ○ ${filePath} (will be created)`);
          }
        }
      }

      // 3. Gemini
      const generated = await generateCodeWithGemini(
        task,
        fileTree,
        targetFileContents,
      );

      // 4. GitHub
      const baseSHA = await getMainBranchSHA();
      const finalBranch = await createBranch(generated.branchName, baseSHA);
      await commitFiles(finalBranch, generated.files, generated.commitMessage);
      const prUrl = await createPullRequest(
        finalBranch,
        generated.prTitle,
        generated.prBody,
        task,
      );

      // 5. Notion
      await markTaskInProgress(task.id);

      console.log(`\n🎉 Done! → ${prUrl}`);

      // انتظر 12 ثانية بين كل task عشان ما نتجاوزش الـ 5 RPM
      if (tasks.indexOf(task) < tasks.length - 1) {
        console.log(
          "⏳ Waiting 12s before next task (rate limit protection)...",
        );
        await sleep(12000);
      }
    } catch (err) {
      console.error(`\n❌ Failed: "${task.title}"\n   ${err.message}`);
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log("✅ Automation complete!");
}

main().catch((err) => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});
