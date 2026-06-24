const { Octokit } = require("@octokit/rest");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// ⏱️  fetchWithRetry - للـ rate limits
// ============================================================
async function fetchWithRetry(url, options, maxRetries = 2) {
  for (let i = 1; i <= maxRetries; i++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    const wait = i * 20000;
    console.log(`   ⚠️ 429 → waiting ${wait / 1000}s...`);
    await sleep(wait);
  }
  return fetch(url, options);
}

// ============================================================
// 🌐  Google CodeWiki - يجيب فهم عميق للمشروع
// ============================================================
async function getCodeWikiContext() {
  console.log("🌐 Fetching CodeWiki project understanding...");
  try {
    // CodeWiki API - بنجيب الـ wiki اللي اتولد للـ repo
    const repoPath = `${REPO_OWNER}/${REPO_NAME}`.toLowerCase();
    const wikiUrl = `https://codewiki.google/api/v1/repos/${repoPath}/summary`;

    const res = await fetch(wikiUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "notion-pr-automation/4.0",
      },
    });

    if (res.ok) {
      const data = await res.json();
      const summary = data.summary || data.description || "";
      const architecture = data.architecture || data.overview || "";
      console.log(`   ✅ CodeWiki context fetched (${summary.length} chars)`);
      return `## Project Understanding (from Google CodeWiki):
${summary}
${architecture ? `\n### Architecture:\n${architecture}` : ""}`.slice(0, 3000);
    }

    // لو CodeWiki مش متاح، نجيب الـ README من GitHub
    console.log("   ℹ️ CodeWiki not available, fetching README...");
    const { data: readme } = await octokit.repos.getReadme({
      owner: REPO_OWNER,
      repo: REPO_NAME,
    });
    const content = Buffer.from(readme.content, "base64").toString("utf-8");
    console.log(`   ✅ README fetched (${content.length} chars)`);
    return `## Project README:\n${content.slice(0, 2000)}`;
  } catch (err) {
    console.warn(`   ⚠️ CodeWiki/README failed: ${err.message}`);
    return "";
  }
}

// ============================================================
// 🗂️  File Tree + Wildcard expansion
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
    console.log(`   ✓ ${files.length} files`);
    return files;
  } catch (err) {
    console.warn(`   ⚠️ ${err.message}`);
    return [];
  }
}

// بيحل الـ wildcards - مثلاً "app/exam/quiz/*" بيجيب كل الملفات جوا
function expandWildcards(targetFiles, allFiles) {
  const expanded = [];
  for (const pattern of targetFiles) {
    if (pattern.endsWith("/*") || pattern.endsWith("/**")) {
      const prefix = pattern.replace(/\/\*+$/, "/");
      const matches = allFiles.filter((f) => f.startsWith(prefix));
      if (matches.length > 0) {
        expanded.push(...matches);
        console.log(
          `   🔍 "${pattern}" → ${matches.length} files: ${matches.slice(0, 3).join(", ")}${matches.length > 3 ? "..." : ""}`,
        );
      } else {
        console.log(`   ⚠️ No files matched: "${pattern}"`);
      }
    } else {
      expanded.push(pattern);
    }
  }
  return [...new Set(expanded)]; // remove duplicates
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
// 1️⃣  جلب أول Task من Notion
// ============================================================
async function fetchOneTask() {
  console.log("📋 Fetching next task...");
  const res = await fetch(
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
        page_size: 1,
      }),
    },
  );
  if (!res.ok) throw new Error(`Notion: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.results.length) return null;

  const page = data.results[0];
  const notes = page.properties["Notes"]?.rich_text?.[0]?.plain_text || "";
  const filesMatch = notes.match(/Files: (.+)/);
  const depsMatch = notes.match(/Depends on: (.+)/);
  const descLines = notes
    .split("\n")
    .filter(
      (l) =>
        !l.startsWith("Received:") &&
        !l.startsWith("Files:") &&
        !l.startsWith("Depends on:"),
    );
  return {
    id: page.id,
    title: page.properties["Task Name"]?.title?.[0]?.plain_text || "Untitled",
    description: descLines.join("\n").trim(),
    targetFiles: filesMatch
      ? filesMatch[1]
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
      : [],
    dependsOn: depsMatch ? depsMatch[1].trim() : null,
    priority: page.properties["Priority"]?.select?.name || "🟡 Medium",
  };
}

// ============================================================
// 2️⃣  تغيير Status في Notion
// ============================================================
async function setNotionStatus(pageId, status) {
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: { Status: { select: { name: status } } },
    }),
  });
  console.log(`   ✅ Notion → ${status}`);
}

// ============================================================
// 🔗  فحص الـ Dependency
// ============================================================
async function checkDependencyReady(dependsOnTitle) {
  if (!dependsOnTitle) return { ready: true };
  const res = await fetch(
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
  const data = await res.json();
  if (data.results?.length > 0)
    return { ready: false, reason: `"${dependsOnTitle}" لسه New` };
  return { ready: true };
}

// ============================================================
// 3️⃣  Prompt Builder - مع تعليمات واضحة للتعديل مش الحذف
// ============================================================
function buildPrompt(task, fileTree, existingFiles, projectContext) {
  const treePreview = fileTree.slice(0, 80).join("\n");

  // بناء section الملفات الموجودة
  let filesContext = "";
  const fileEntries = Object.entries(existingFiles);
  if (fileEntries.length > 0) {
    filesContext =
      "\n## ⚠️ EXISTING FILES TO MODIFY (preserve all existing code, only ADD what's needed):\n";
    for (const [path, content] of fileEntries) {
      // بناخد أول 1200 حرف بس عشان نوفر tokens
      const preview = content.slice(0, 1200);
      const truncated =
        content.length > 1200
          ? `\n// ... (${content.length - 1200} more chars)`
          : "";
      filesContext += `\n### FILE: ${path}\n\`\`\`\n${preview}${truncated}\n\`\`\`\n`;
    }
  }

  return `You are a senior Next.js + TypeScript developer modifying an existing production app.

${projectContext}

## Repository Structure (${fileTree.length} total files, showing first 80):
\`\`\`
${treePreview}
\`\`\`
${filesContext}

## Task to implement:
- **Title**: ${task.title}
- **Description**: ${task.description || "No description"}
- **Target Files**: ${task.targetFiles.length > 0 ? task.targetFiles.join(", ") : "You decide based on task"}
- **Priority**: ${task.priority}

## ⚠️ CRITICAL RULES - follow these EXACTLY:

### Code Quality Rules:
1. If modifying existing files: PRESERVE ALL existing code/imports/exports. Only ADD new code.
2. NEVER delete metadata, layouts, exports, or imports that already exist in the file.
3. If adding a feature (dark mode, responsive, etc.) → ADD it alongside existing code, don't replace.
4. For responsive design: add Tailwind responsive classes (sm:, md:, lg:) to existing JSX. Don't rewrite.
5. When you see existing file content above, your output MUST include ALL of it + your additions.

### Task Type Guide:
- UI/Feature → modify files in app/ or components/
- Script/Scraping → create file in scripts/ folder (.js or .py)
- Config/Setup → modify config files

### Output Format Rules:
1. Output ONLY a JSON object - starts with {, ends with }, nothing else
2. Use \\n for newlines in file content, \\" for quotes
3. Max 2 files output, each under 4000 chars
4. If setup steps needed (RLS, env vars), put them in setupNotes

## OUTPUT FORMAT:
{"branchName":"feature/short-name","commitMessage":"feat: short description","prTitle":"Short descriptive title","prBody":"## Summary\\nClear explanation of changes made.","setupNotes":"Manual steps if any, or empty string","files":[{"path":"exact/path/file.tsx","content":"COMPLETE file content here - include ALL existing code plus your additions"}]}`;
}

// ============================================================
// 🧠  Smart JSON Parser
// ============================================================
function smartParseJSON(rawText) {
  // احاول تجيب أول { لـ آخر }
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON found");

  const jsonStr = rawText.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (e1) {
    // محاولة إصلاح common issues
    try {
      // إصلاح unescaped newlines داخل strings
      const fixed = jsonStr.replace(/(?<=":"\s*)([\s\S]*?)(?="\s*[,}])/g, (s) =>
        s.replace(/\n/g, "\\n").replace(/\r/g, ""),
      );
      return JSON.parse(fixed);
    } catch {
      throw new Error(`JSON parse failed: ${e1.message.slice(0, 100)}`);
    }
  }
}

// ============================================================
// 🤖  AI Model Calls
// ============================================================
async function callGemini(model, prompt) {
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    const shouldFallback =
      res.status === 429 ||
      res.status === 503 ||
      body.includes("quota") ||
      body.includes("UNAVAILABLE") ||
      body.includes("RESOURCE_EXHAUSTED");
    throw new Error(
      shouldFallback
        ? `FALLBACK:${res.status}`
        : `Gemini ${res.status}: ${body.slice(0, 150)}`,
    );
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callGroq(prompt) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("NO_GROQ_KEY");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "You are a code generator. Output ONLY raw JSON, no markdown, no explanation, no text before or after the JSON object.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 8192,
    }),
  });
  if (!res.ok)
    throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function generateCode(task, fileTree, existingFiles, projectContext) {
  const prompt = buildPrompt(task, fileTree, existingFiles, projectContext);

  const models = [
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

  for (const model of models) {
    console.log(`🤖 Trying ${model.name}...`);
    try {
      const raw = await model.fn();
      const result = smartParseJSON(raw);
      if (!result.files?.length) throw new Error("No files in response");
      console.log(`   ✅ ${model.name} → ${result.files.length} file(s)`);
      return result;
    } catch (err) {
      const fallback =
        err.message.startsWith("FALLBACK") ||
        err.message.includes("No JSON") ||
        err.message.includes("JSON parse") ||
        err.message.includes("No files") ||
        err.message.includes("quota");
      if (fallback) {
        console.log(
          `   ⚠️ ${model.name}: ${err.message.slice(0, 80)} → trying next...`,
        );
        continue;
      }
      if (err.message === "NO_GROQ_KEY") {
        console.log("   ⚠️ No Groq key");
        break;
      }
      throw err;
    }
  }
  throw new Error("All AI models failed. Try again later.");
}

// ============================================================
// 4️⃣  GitHub Operations
// ============================================================
async function getMainSHA() {
  const { data } = await octokit.repos.getBranch({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    branch: "main",
  });
  return data.commit.sha;
}

async function createBranch(name, sha) {
  console.log(`🌿 Branch: ${name}`);
  try {
    await octokit.git.createRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `refs/heads/${name}`,
      sha,
    });
  } catch (err) {
    if (err.status === 422) {
      const unique = `${name}-${Date.now()}`;
      await octokit.git.createRef({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        ref: `refs/heads/${unique}`,
        sha,
      });
      return unique;
    }
    throw err;
  }
  return name;
}

async function commitFiles(branch, files, msg) {
  console.log(`💾 Committing ${files.length} file(s)...`);
  for (const f of files) {
    let existingSha;
    try {
      const { data } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: f.path,
        ref: branch,
      });
      existingSha = data.sha;
    } catch {
      existingSha = undefined;
    }
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: f.path,
      message: msg,
      content: Buffer.from(f.content, "utf-8").toString("base64"),
      branch,
      sha: existingSha,
    });
    console.log(`   ✓ ${f.path}`);
  }
}

async function createPR(branch, generated, task) {
  const setupSection = generated.setupNotes?.trim()
    ? `\n\n---\n## ⚠️ Manual Setup Required\n\`\`\`\n${generated.setupNotes}\n\`\`\``
    : "";

  const body = `${generated.prBody}${setupSection}

---
### 📋 Task Info
- **Task**: ${task.title}
${task.targetFiles.length ? `- **Files**: \`${task.targetFiles.join("`, `")}\`` : ""}
${task.dependsOn ? `- **Depends on**: ${task.dependsOn}` : ""}
- **Priority**: ${task.priority}

> 🤖 Auto-generated by Notion → AI → GitHub Actions`;

  const { data: pr } = await octokit.pulls.create({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: generated.prTitle,
    body,
    head: branch,
    base: "main",
  });
  console.log(`   ✅ PR: ${pr.html_url}`);
  return pr.html_url;
}

// ============================================================
// 🚀  Main
// ============================================================
async function main() {
  console.log("=".repeat(50));
  console.log("🔄 Notion → PR Automation v4.0");
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
  if (missing.length) throw new Error(`Missing: ${missing.join(", ")}`);

  // 1. جيب التاسك
  const task = await fetchOneTask();
  if (!task) {
    console.log("✨ No New tasks. Done!");
    return;
  }

  console.log(`\n📝 Task: "${task.title}"`);
  console.log(`   Priority: ${task.priority}`);

  // 2. فحص الـ Dependency
  if (task.dependsOn) {
    console.log(`🔗 Dependency: "${task.dependsOn}"...`);
    const dep = await checkDependencyReady(task.dependsOn);
    if (!dep.ready) {
      console.log(`⏸️  SKIP: ${dep.reason}`);
      return;
    }
    console.log(`   ✅ Clear!`);
  }

  // 3. حوّل لـ In Progress فوراً
  await setNotionStatus(task.id, "🔄 In Progress");

  try {
    // 4. جيب context المشروع (CodeWiki + file tree)
    const [projectContext, fileTree] = await Promise.all([
      getCodeWikiContext(),
      getRepoFileTree(),
    ]);

    // 5. expand الـ wildcards وجيب محتوى الملفات
    const expandedFiles = expandWildcards(task.targetFiles, fileTree);
    const existingFiles = {};

    if (expandedFiles.length > 0) {
      console.log(`📁 Reading ${expandedFiles.length} file(s)...`);
      // خلينا ناخد أول 5 ملفات بس عشان منكثفش الـ prompt
      const filesToRead = expandedFiles.slice(0, 5);
      if (expandedFiles.length > 5)
        console.log(`   ⚠️ Too many files - reading first 5 only`);

      for (const fp of filesToRead) {
        const content = await getFileContent(fp);
        if (content) {
          existingFiles[fp] = content;
          console.log(`   ✓ ${fp} (${content.length} chars)`);
        } else {
          console.log(`   ○ ${fp} (new)`);
        }
      }
    }

    // 6. Generate كود
    const generated = await generateCode(
      task,
      fileTree,
      existingFiles,
      projectContext,
    );

    // 7. GitHub: Branch → Commit → PR
    const sha = await getMainSHA();
    const branch = await createBranch(generated.branchName, sha);
    await commitFiles(branch, generated.files, generated.commitMessage);
    const prUrl = await createPR(branch, generated, task);

    // 8. ✅ Done!
    await setNotionStatus(task.id, "✅ Done");

    console.log(`\n${"=".repeat(50)}`);
    console.log(`🎉 Success! PR: ${prUrl}`);
    if (generated.setupNotes?.trim())
      console.log(`⚠️  Check PR for manual setup steps!`);
    console.log("=".repeat(50));
  } catch (err) {
    // لو فيه error → رجّع لـ New عشان يتعالج تاني
    console.error(`\n❌ Failed: ${err.message}`);
    await setNotionStatus(task.id, "🆕 New");
    console.log("   ↩️  Notion status reset to New");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("💥 Fatal:", err.message);
  process.exit(1);
});
