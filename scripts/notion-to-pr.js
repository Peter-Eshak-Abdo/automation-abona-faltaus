const { Octokit } = require("@octokit/rest");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ============================================================
// ⏱️  Helpers
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, options, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429) return response;
    const waitMs = attempt * 20000;
    console.log(
      `   ⚠️ 429 - waiting ${waitMs / 1000}s (attempt ${attempt}/${maxRetries})...`,
    );
    await sleep(waitMs);
  }
  return fetch(url, options);
}

// ============================================================
// 🗄️  جلب Supabase Schema (الجداول والأعمدة)
// ============================================================
async function getSupabaseSchema() {
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_KEY) {
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_KEY) {
    console.log(
      "   ⚠️ NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set - skipping schema",
      "   ⚠️ NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set - skipping schema",
    );
    return null;
  }
  console.log("🗄️  Fetching Supabase schema...");
  try {
    // information_schema.columns بيديك كل الجداول والأعمدة
    const res = await fetch(`${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/get_schema_info`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
    });

    // لو مفيش RPC function، نقدر نعمل query مباشرة على information_schema
    if (!res.ok) {
      const res2 = await fetch(`${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      });
      // جيب أسماء الـ tables من الـ OpenAPI spec
      if (res2.ok) {
        const spec = await res2.json();
        const tables = Object.keys(spec.definitions || spec.paths || {}).filter(
          (k) => !k.startsWith("rpc"),
        );
        console.log(`   ✓ Found ${tables.length} tables: ${tables.join(", ")}`);
        return { tables, columns: {} };
      }
      return null;
    }

    const schema = await res.json();
    console.log(`   ✓ Schema fetched`);
    return schema;
  } catch (err) {
    console.warn(`   ⚠️ Could not fetch Supabase schema: ${err.message}`);
    return null;
  }
}

// جلب أعمدة جدول معين
async function getTableColumns(tableName) {
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(`${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${tableName}?limit=0`, {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "count=exact",
      },
    });
    // الـ headers بتحتوي على الـ columns info في بعض الأحيان
    // لكن الأسهل هو جلب صف واحد وشوف الـ keys
    const res2 = await fetch(
      `${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${tableName}?limit=1&select=*`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      },
    );
    if (res2.ok) {
      const data = await res2.json();
      if (data.length > 0) return Object.keys(data[0]);
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// 🗂️  جلب File Tree من الـ Repo
// ============================================================
async function getRepoFileTree() {
  console.log("🗂️  Fetching file tree...");
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
    console.log(`   ✓ ${files.length} files found`);
    return files;
  } catch (err) {
    console.warn(`   ⚠️ File tree error: ${err.message}`);
    return [];
  }
}

async function getFileContent(filePath) {
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: filePath,
    });
    if (data.content)
      return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {}
  return null;
}

// ============================================================
// 1️⃣  سحب أول Task فقط من Notion (بالأولوية)
// ============================================================
async function fetchOneTask() {
  console.log("📋 Fetching next task from Notion...");
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
        page_size: 1, // ← task واحدة بس!
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      `Notion API Error: ${response.status} ${await response.text()}`,
    );
  const data = await response.json();
  if (data.results.length === 0) return null;

  const page = data.results[0];
  const notesText = page.properties["Notes"]?.rich_text?.[0]?.plain_text || "";
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
}

// ============================================================
// 🔗  فحص الـ Dependency - لو التاسك دي مترتبة على تانية
// ============================================================
async function checkDependencyReady(dependsOnTitle) {
  if (!dependsOnTitle) return { ready: true };
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
    return {
      ready: false,
      reason: `"${dependsOnTitle}" لسه New في Notion - لازم تخلص الأول`,
    };
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
// 3️⃣  بناء الـ Prompt الذكي
// ============================================================
function buildPrompt(task, fileTree, targetFileContents, supabaseContext) {
  const treePreview = fileTree.slice(0, 60).join("\n");

  let filesContext = "";
  if (Object.keys(targetFileContents).length > 0) {
    filesContext = "\n## Existing File Contents (to modify):\n";
    for (const [path, content] of Object.entries(targetFileContents)) {
      // خلي المحتوى صغير عشان JSON ما يتقطعش
      filesContext += `\n### ${path}\n\`\`\`tsx\n${content.slice(0, 1500)}\n\`\`\`\n`;
    }
  }

  let dbContext = "";
  if (supabaseContext) {
    dbContext = `\n## Supabase Database Schema:\n${supabaseContext}\n`;
  }

  // CRITICAL: الـ prompt بيطلب JSON مصغر عشان ما يتقطعش
  return `You are a Next.js + TypeScript expert. Implement the task below.

## Project Structure (first 60 files):
${treePreview}
${fileTree.length > 60 ? `... +${fileTree.length - 60} more` : ""}
${filesContext}${dbContext}
## Task:
Title: ${task.title}
Description: ${task.description || "No description"}
Target Files: ${task.targetFiles.length > 0 ? task.targetFiles.join(", ") : "Decide based on task"}

## TASK TYPE GUIDE:
- UI/Feature task → create files in app/ or components/
- Script/Scraping task → create file in scripts/ folder (Node.js .js or Python .py)
- Config/Setup task → create or modify config files
- ANY task type → ALWAYS produce at least 1 file

## ⚠️ ABSOLUTE RULES - your response MUST follow these or it will be rejected:
1. ENTIRE response = ONE JSON object, nothing before {, nothing after }
2. NO markdown fences, NO explanation text, NO comments outside JSON
3. Escape newlines in content as \\n, escape quotes as \\"
4. Max 2 files, content under 3000 chars each
5. setupNotes: manual steps needed (RLS policies, env vars, Supabase config) or ""

## COPY THIS FORMAT exactly:
{"branchName":"feature/short-name","commitMessage":"feat: short desc","prTitle":"Short title","prBody":"## Summary\\nWhat was done.","setupNotes":"","files":[{"path":"scripts/example.js","content":"// content\\nconsole.log(\\"hello\\")"}]}`;
}

// ============================================================
// 🧠  Parse JSON بذكاء - يصلح المشاكل الشائعة
// ============================================================
function smartParseJSON(rawText) {
  // محاولة 1: مباشر
  const directMatch = rawText.match(/\{[\s\S]*\}/);
  if (!directMatch) throw new Error("No JSON found in response");

  let jsonStr = directMatch[0];

  try {
    return JSON.parse(jsonStr);
  } catch (e1) {
    // محاولة 2: استخرج الـ fields الرئيسية بـ regex لو JSON فيه مشاكل
    console.log("   ⚠️ Direct JSON parse failed, trying field extraction...");
    try {
      const extract = (key) => {
        const m = rawText.match(
          new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`),
        );
        return m ? m[1] : "";
      };
      const extractArray = (key) => {
        const m = rawText.match(
          new RegExp(`"${key}"\\s*:\\s*(\\[.*?\\])`, "s"),
        );
        if (!m) return [];
        try {
          return JSON.parse(m[1]);
        } catch {
          return [];
        }
      };

      return {
        branchName: extract("branchName") || "feature/auto-task",
        commitMessage: extract("commitMessage") || "feat: auto implementation",
        prTitle: extract("prTitle") || "Auto PR",
        prBody: extract("prBody") || "Auto-generated",
        setupNotes: extract("setupNotes") || "",
        files: extractArray("files"),
      };
    } catch (e2) {
      throw new Error(`JSON parse failed: ${e1.message}`);
    }
  }
}

// ============================================================
// 🤖  AI Models
// ============================================================
async function callGemini(model, prompt) {
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 6000 },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    const isLimit =
      res.status === 429 ||
      body.includes("quota") ||
      body.includes("RESOURCE_EXHAUSTED");
    throw new Error(
      isLimit
        ? `RATE_LIMIT:${model}`
        : `Gemini Error ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callGroq(prompt) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) throw new Error("NO_GROQ_KEY");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "You are a code generator. Return ONLY raw JSON, no markdown, no explanation.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 6000,
    }),
  });
  if (!res.ok) throw new Error(`Groq Error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function generateCode(
  task,
  fileTree,
  targetFileContents,
  supabaseContext,
) {
  const prompt = buildPrompt(
    task,
    fileTree,
    targetFileContents,
    supabaseContext,
  );

  const modelChain = [
    {
      name: "Gemini 2.5 Flash",
      fn: () => callGemini("gemini-2.5-flash", prompt),
    },
    {
      name: "Gemini 2.0 Flash",
      fn: () => callGemini("gemini-2.0-flash", prompt),
    },
    { name: "Groq Llama 3.3", fn: () => callGroq(prompt) },
  ];

  for (const model of modelChain) {
    console.log(`🤖 Trying ${model.name}...`);
    try {
      const rawText = await model.fn();
      const result = smartParseJSON(rawText);
      if (!result.files || result.files.length === 0)
        throw new Error("No files in response");
      console.log(`   ✅ ${model.name} succeeded`);
      return result;
    } catch (err) {
      const isLimit =
        err.message.startsWith("RATE_LIMIT") || err.message.includes("quota");
      const isBadJSON =
        err.message.includes("No files") ||
        err.message.includes("JSON") ||
        err.message.includes("No JSON");
      if (isLimit) {
        console.log(`   ⚠️ Rate limited → next model...`);
        continue;
      }
      if (isBadJSON) {
        // الموديل رجع رد غلط (شرح بدل JSON) → جرب الموديل التاني
        console.log(
          `   ⚠️ Bad response (${err.message.slice(0, 60)}) → next model...`,
        );
        continue;
      }
      if (err.message === "NO_GROQ_KEY") {
        console.log(`   ⚠️ No Groq key configured`);
        break;
      }
      throw err; // error حقيقي (مش rate limit ومش JSON مشكلة)
    }
  }
  throw new Error("All models rate limited. Try again later.");
}

// ============================================================
// 4️⃣  GitHub Operations
// ============================================================
async function getMainBranchSHA() {
  const { data } = await octokit.repos.getBranch({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    branch: "main",
  });
  return data.commit.sha;
}

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
      const unique = `${branchName}-${Date.now()}`;
      await octokit.git.createRef({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        ref: `refs/heads/${unique}`,
        sha: baseSHA,
      });
      return unique;
    }
    throw err;
  }
  return branchName;
}

async function commitFiles(branchName, files, commitMessage) {
  console.log(`💾 Committing ${files.length} file(s)...`);
  for (const file of files) {
    let sha;
    try {
      const { data } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: file.path,
        ref: branchName,
      });
      sha = data.sha;
    } catch {
      sha = undefined;
    }
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: file.path,
      message: commitMessage,
      content: Buffer.from(file.content, "utf-8").toString("base64"),
      branch: branchName,
      sha,
    });
    console.log(`   ✓ ${file.path}`);
  }
}

async function createPullRequest(branchName, generated, task) {
  console.log(`🚀 Opening Pull Request...`);

  // بناء الـ PR body مع Setup Notes لو موجودة
  const setupSection = generated.setupNotes
    ? `\n\n---\n## ⚠️ Manual Setup Required\n\`\`\`\n${generated.setupNotes}\n\`\`\``
    : "";

  const taskSection = [
    "\n\n---",
    "### 📋 Task Details",
    `- **Task**: ${task.title}`,
    task.targetFiles.length > 0
      ? `- **Files**: \`${task.targetFiles.join("`, `")}\``
      : "",
    task.dependsOn ? `- **Depended on**: ${task.dependsOn}` : "",
    `- **Priority**: ${task.priority}`,
    "",
    "> 🤖 Auto-generated by Notion → AI → GitHub Actions",
  ]
    .filter(Boolean)
    .join("\n");

  const { data: pr } = await octokit.pulls.create({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: generated.prTitle,
    body: generated.prBody + setupSection + taskSection,
    head: branchName,
    base: "main",
  });

  console.log(`   ✅ PR: ${pr.html_url}`);
  if (generated.setupNotes) {
    console.log(`   📋 Setup notes added to PR description`);
  }
  return pr.html_url;
}

// ============================================================
// 🚀 Main - task واحدة بس
// ============================================================
async function main() {
  console.log("=".repeat(50));
  console.log("🔄 Notion → PR Automation v3.0");
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
    throw new Error(`Missing env vars: ${missing.join(", ")}`);

  // 1. جيب الـ task الأولى بالأولوية
  const task = await fetchOneTask();
  if (!task) {
    console.log("✨ No New tasks in Notion. Done!");
    return;
  }
  console.log(`\n📝 Next task: "${task.title}"`);
  console.log(`   Priority: ${task.priority}`);

  // 2. فحص الـ Dependency
  if (task.dependsOn) {
    console.log(`🔗 Checking dependency: "${task.dependsOn}"...`);
    const dep = await checkDependencyReady(task.dependsOn);
    if (!dep.ready) {
      console.log(`⏸️  SKIPPED: ${dep.reason}`);
      console.log("💡 Process the dependency task first, then re-run.");
      return;
    }
    console.log(`   ✅ Dependency is done!`);
  }

  // 3. جيب file tree
  const fileTree = await getRepoFileTree();

  // 4. جيب محتوى الملفات المستهدفة
  const targetFileContents = {};
  if (task.targetFiles.length > 0) {
    console.log(`📁 Reading ${task.targetFiles.length} target file(s)...`);
    for (const fp of task.targetFiles) {
      const content = await getFileContent(fp);
      if (content) {
        targetFileContents[fp] = content;
        console.log(`   ✓ ${fp}`);
      } else {
        console.log(`   ○ ${fp} (new file)`);
      }
    }
  }

  // 5. جيب الـ Supabase schema
  let supabaseContext = null;
  const needsDB =
    task.title.toLowerCase().includes("قاعدة") ||
    task.title.toLowerCase().includes("supabase") ||
    task.description?.toLowerCase().includes("supabase") ||
    task.description?.toLowerCase().includes("database") ||
    task.title.includes("بيانات");

  if (needsDB || NEXT_PUBLIC_SUPABASE_URL) {
    const schema = await getSupabaseSchema();
    if (schema) {
      supabaseContext =
        typeof schema === "string"
          ? schema
          : JSON.stringify(schema, null, 2).slice(0, 2000);
    }
  }

  // 6. توليد الكود
  const generated = await generateCode(
    task,
    fileTree,
    targetFileContents,
    supabaseContext,
  );

  // 7. GitHub: Branch → Commit → PR
  const baseSHA = await getMainBranchSHA();
  const branch = await createBranch(generated.branchName, baseSHA);
  await commitFiles(branch, generated.files, generated.commitMessage);
  const prUrl = await createPullRequest(branch, generated, task);

  // 8. تحديث Notion
  await markTaskInProgress(task.id);

  console.log(`\n${"=".repeat(50)}`);
  console.log(`🎉 Done! PR: ${prUrl}`);
  if (generated.setupNotes) {
    console.log(`\n⚠️  Manual setup needed - check PR description!`);
  }
  console.log("=".repeat(50));
}

main().catch((err) => {
  console.error("💥 Fatal:", err.message);
  process.exit(1);
});
