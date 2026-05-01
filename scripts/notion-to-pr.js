// ============================================================
// notion-to-pr.js  v2.0
// Notion → Gemini (مع file tree + dependency awareness) → GitHub PR
// ============================================================

const { Octokit } = require("@octokit/rest");

const NOTION_TOKEN   = process.env.NOTION_TOKEN;
const NOTION_DB_ID   = process.env.NOTION_DATABASE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const REPO_OWNER     = process.env.REPO_OWNER;
const REPO_NAME      = process.env.REPO_NAME;

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ============================================================
// 🗂️  جلب File Tree من الـ Repo (عشان Gemini يشوف المشروع)
// ============================================================
async function getRepoFileTree() {
  console.log("🗂️  Fetching repository file tree...");
  try {
    // جيب الـ SHA الخاص بالـ tree بتاع main
    const { data: ref } = await octokit.git.getRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: "heads/main",
    });
    const commitSHA = ref.object.sha;

    const { data: commit } = await octokit.git.getCommit({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      commit_sha: commitSHA,
    });

    // recursive: true → كل الملفات في الـ repo
    const { data: tree } = await octokit.git.getTree({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      tree_sha: commit.tree.sha,
      recursive: "true",
    });

    // فلتر: بس الملفات المهمة، تجاهل node_modules وغيره
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
// 📋  جلب محتوى ملف معين من الـ Repo (للـ context)
// ============================================================
async function getFileContent(filePath) {
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: filePath,
    });
    if (data.content) {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
  } catch {
    // الملف مش موجود أو مش readable
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
        filter: {
          and: [
            { property: "Status", select: { equals: "🆕 New" } },
            // فقط Tasks مفيش حاجة "تعتمد عليها" لسه In Progress
            // (الـ dependency check بيتعمل في الكود تحت)
          ],
        },
        sorts: [{ property: "Priority", direction: "descending" }],
        page_size: 10,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Notion API Error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();

  return data.results.map((page) => {
    const notesText = page.properties["Notes"]?.rich_text?.[0]?.plain_text || "";

    // استخراج الـ metadata من الـ Notes اللي بعتها bot.py
    const filesMatch    = notesText.match(/Files: (.+)/);
    const dependsMatch  = notesText.match(/Depends on: (.+)/);
    // الـ description هي كل حاجة بعد السطر الأول
    const descLines = notesText.split("\n").filter(l =>
      !l.startsWith("Received:") &&
      !l.startsWith("Files:") &&
      !l.startsWith("Depends on:")
    );

    return {
      id:          page.id,
      title:       page.properties["Task Name"]?.title?.[0]?.plain_text || "Untitled Task",
      description: descLines.join("\n").trim(),
      targetFiles: filesMatch  ? filesMatch[1].split(",").map(f => f.trim()) : [],
      dependsOn:   dependsMatch ? dependsMatch[1].trim() : null,
      priority:    page.properties["Priority"]?.select?.name || "🟡 Medium",
    };
  });
}

// ============================================================
// 🔍  التحقق إن الـ Dependencies اتخلصت (مش "🆕 New")
// ============================================================
async function checkDependencyReady(dependsOnTitle, allTasks) {
  if (!dependsOnTitle) return { ready: true };

  // هل الـ dependency task موجودة في الـ "New" tasks دلوقتي؟
  const depInQueue = allTasks.find(t =>
    t.title.toLowerCase().includes(dependsOnTitle.toLowerCase())
  );

  if (depInQueue) {
    return {
      ready: false,
      reason: `تعتمد على "${dependsOnTitle}" اللي لسه Status = New`,
    };
  }

  // نتأكد من Notion إن الـ dependency مش لسه "New"
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
    }
  );

  const data = await response.json();
  if (data.results?.length > 0) {
    return {
      ready: false,
      reason: `تعتمد على "${dependsOnTitle}" اللي لسه Status = New في Notion`,
    };
  }

  return { ready: true };
}

// ============================================================
// 2️⃣  تعديل Status → "In Progress"
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
  console.log(`   ✅ Notion → In Progress`);
}

// ============================================================
// 3️⃣  توليد الكود من Gemini (مع file tree + محتوى الملفات المستهدفة)
// ============================================================
async function generateCodeWithGemini(task, fileTree, targetFileContents) {
  console.log(`🤖 Asking Gemini...`);

  // بناء الـ context عن الملفات المستهدفة
  let targetFilesContext = "";
  if (Object.keys(targetFileContents).length > 0) {
    targetFilesContext = "\n## Current Content of Target Files:\n";
    for (const [path, content] of Object.entries(targetFileContents)) {
      targetFilesContext += `\n### ${path}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\`\n`;
    }
  }

  // أهم 80 ملف من الـ tree عشان نوفر tokens
  const treePreview = fileTree.slice(0, 80).join("\n");

  const prompt = `You are an expert Next.js + TypeScript developer.
You have full visibility into the project structure.

## Project File Tree (top 80 files):
\`\`\`
${treePreview}
${fileTree.length > 80 ? `... and ${fileTree.length - 80} more files` : ""}
\`\`\`
${targetFilesContext}

## Task to implement:
- **Title**: ${task.title}
- **Description**: ${task.description || "No additional description."}
- **Target Files (user specified)**: ${task.targetFiles.length > 0 ? task.targetFiles.join(", ") : "Infer from task context"}
- **Priority**: ${task.priority}

## Your Instructions:
1. Study the project structure above carefully.
2. Implement exactly what the task describes.
3. If target files are specified, modify/create those exact files.
4. Match the existing code style and conventions you see in the file tree.
5. Return ONLY a raw JSON object - NO markdown, NO backticks, NO explanation before or after.

## Required JSON format:
{
  "branchName": "feature/short-kebab-case-name",
  "commitMessage": "feat: short description",
  "prTitle": "PR: what this implements",
  "prBody": "## Summary\\nWhat was done.\\n\\n## Files Changed\\n- list",
  "files": [
    {
      "path": "exact/path/from/project/structure.tsx",
      "content": "complete file content - not truncated"
    }
  ]
}

Rules:
- branchName: start with feature/, fix/, or chore/
- files: 1-3 files maximum
- paths: must match actual project structure
- content: complete, production-ready TypeScript/Next.js code
- Return ONLY the JSON - nothing else`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,  // زودنا عشان الكود ميتقطعش
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini API Error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  // استخرج أول JSON object كاملة - حتى لو فيه markdown حواليها
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
// 4️⃣  جلب SHA الـ main branch
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

  // بناء PR body محتوى تفصيلي
  const fullBody = [
    prBody,
    "",
    "---",
    "### 📋 Task Details",
    `- **Notion Task**: ${task.title}`,
    task.targetFiles.length > 0 ? `- **Target Files**: \`${task.targetFiles.join("`, `")}\`` : "",
    task.dependsOn ? `- **Depended on**: ${task.dependsOn}` : "",
    `- **Priority**: ${task.priority}`,
    "",
    "> 🤖 Auto-generated by Notion → Gemini → GitHub Actions",
  ].filter(l => l !== null).join("\n");

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

  const required = { NOTION_TOKEN, NOTION_DB_ID, GEMINI_API_KEY, GITHUB_TOKEN, REPO_OWNER, REPO_NAME };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`❌ Missing env vars: ${missing.join(", ")}`);

  // ── جلب file tree مرة واحدة لكل الـ tasks ────────────────
  const fileTree = await getRepoFileTree();

  // ── جلب الـ tasks ─────────────────────────────────────────
  const tasks = await fetchNotionTasks();

  if (tasks.length === 0) {
    console.log("✨ No New tasks found. Nothing to do!");
    return;
  }

  console.log(`\n📌 Found ${tasks.length} task(s)\n`);

  // ── معالجة كل task ────────────────────────────────────────
  for (const task of tasks) {
    console.log(`\n${"─".repeat(40)}`);
    console.log(`📝 "${task.title}"`);

    try {
      // ── 1. فحص الـ Dependencies ──────────────────────────
      if (task.dependsOn) {
        console.log(`🔗 Checking dependency: "${task.dependsOn}"...`);
        const depCheck = await checkDependencyReady(task.dependsOn, tasks);
        if (!depCheck.ready) {
          console.log(`   ⏸️  Skipping: ${depCheck.reason}`);
          continue; // skip هذه المهمة - اشتغل على الباقي
        }
        console.log(`   ✅ Dependency ready!`);
      }

      // ── 2. جلب محتوى الملفات المستهدفة ──────────────────
      const targetFileContents = {};
      if (task.targetFiles.length > 0) {
        console.log(`📁 Fetching ${task.targetFiles.length} target file(s)...`);
        for (const filePath of task.targetFiles) {
          const content = await getFileContent(filePath);
          if (content) {
            targetFileContents[filePath] = content;
            console.log(`   ✓ ${filePath} (${content.length} chars)`);
          } else {
            console.log(`   ○ ${filePath} (new file - doesn't exist yet)`);
          }
        }
      }

      // ── 3. توليد الكود من Gemini ─────────────────────────
      const generated = await generateCodeWithGemini(task, fileTree, targetFileContents);

      // ── 4. إنشاء Branch + Commit + PR ───────────────────
      const baseSHA = await getMainBranchSHA();
      const finalBranch = await createBranch(generated.branchName, baseSHA);
      await commitFiles(finalBranch, generated.files, generated.commitMessage);
      const prUrl = await createPullRequest(finalBranch, generated.prTitle, generated.prBody, task);

      // ── 5. تحديث Notion ───────────────────────────────────
      await markTaskInProgress(task.id);

      console.log(`\n🎉 Done! → ${prUrl}`);

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