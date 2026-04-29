import os
import re
import requests
from datetime import datetime

TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
NOTION_TOKEN = os.environ["NOTION_TOKEN"]
NOTION_DATABASE_ID = os.environ["NOTION_DATABASE_ID"]
OFFSET_FILE = "last_offset.txt"

HELP_TEXT = """👋 <b>أهلاً! إزاي تبعت تاسك صح:</b>

<b>الـ Format المطلوب:</b>
<code>
📋 [عنوان التاسك]
📝 [وصف التفصيلي]
📁 [الملفات المتأثرة - اختياري]
🔗 [يعتمد على تاسك اسمه كذا - اختياري]
⚡ [أولوية: عالية/متوسطة/منخفضة - اختياري]
</code>

<b>مثال:</b>
<code>
📋 إضافة صفحة Login
📝 صفحة login بـ email و password مع validation وربطها بـ NextAuth
📁 app/login/page.tsx, components/auth/LoginForm.tsx
⚡ عالية
</code>

<b>مثال بـ dependency:</b>
<code>
📋 ربط Login بـ Dashboard
📝 بعد الـ login يروح على dashboard مع حفظ الـ session
📁 app/dashboard/page.tsx, middleware.ts
🔗 إضافة صفحة Login
⚡ متوسطة
</code>

<b>أو ابعت رسالة عادية</b> وهيتضاف كتاسك عادي ✅"""


# ============================================================
# Parse الرسالة - structured أو free text
# ============================================================
def parse_message(text: str) -> dict:
    """
    بيحاول يقرأ الـ format المنظم، لو مش موجود بيعامله كـ free text
    """
    result = {
        "title": "",
        "description": "",
        "files": "",
        "depends_on": "",
        "priority": "🟡 Medium",
    }

    # لو الرسالة فيها الـ emoji markers
    if "📋" in text:
        def extract(emoji, txt):
            pattern = rf"{re.escape(emoji)}\s*(.+?)(?=📋|📝|📁|🔗|⚡|$)"
            m = re.search(pattern, txt, re.DOTALL)
            return m.group(1).strip() if m else ""

        result["title"]       = extract("📋", text)
        result["description"] = extract("📝", text)
        result["files"]       = extract("📁", text)
        result["depends_on"]  = extract("🔗", text)

        priority_raw = extract("⚡", text).strip()
        if "عالي" in priority_raw or "high" in priority_raw.lower():
            result["priority"] = "🔴 High"
        elif "منخفض" in priority_raw or "low" in priority_raw.lower():
            result["priority"] = "🟢 Low"
        else:
            result["priority"] = "🟡 Medium"
    else:
        # Free text - العنوان هو أول سطر والباقي description
        lines = text.strip().split("\n")
        result["title"] = lines[0][:200]
        result["description"] = "\n".join(lines[1:]).strip() if len(lines) > 1 else ""

    return result


# ============================================================
# إضافة Task في Notion
# ============================================================
def add_to_notion(parsed: dict) -> tuple[bool, str]:
    """
    بيضيف الـ task في Notion مع كل الـ fields
    بيرجع (نجح؟, page_url)
    """
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
    }

    # بناء الـ Notes field
    notes_parts = []
    notes_parts.append(f"Received: {datetime.now().strftime('%d/%m/%Y %H:%M')}")
    if parsed["files"]:
        notes_parts.append(f"Files: {parsed['files']}")
    if parsed["depends_on"]:
        notes_parts.append(f"Depends on: {parsed['depends_on']}")
    if parsed["description"]:
        notes_parts.append(f"\n{parsed['description']}")

    notes_text = "\n".join(notes_parts)

    data = {
        "parent": {"database_id": NOTION_DATABASE_ID},
        "properties": {
            "Task Name": {
                "title": [{"text": {"content": parsed["title"][:200]}}]
            },
            "Status": {"select": {"name": "🆕 New"}},
            "Priority": {"select": {"name": parsed["priority"]}},
            "Source": {"select": {"name": "📱 Telegram"}},
            "Notes": {
                "rich_text": [{"text": {"content": notes_text[:2000]}}]
            },
        },
    }

    r = requests.post("https://api.notion.com/v1/pages", headers=headers, json=data)

    if r.status_code == 200:
        page_url = r.json().get("url", "")
        return True, page_url
    else:
        return False, ""


# ============================================================
# إرسال رسالة Telegram
# ============================================================
def send_message(chat_id, text):
    requests.post(
        f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
        json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
    )


# ============================================================
# بناء رسالة التأكيد المنظمة
# ============================================================
def build_confirmation(parsed: dict, page_url: str) -> str:
    lines = [
        f"✅ <b>تم إضافة التاسك في Notion!</b>",
        f"",
        f"📋 <b>العنوان:</b> {parsed['title'][:80]}",
    ]

    if parsed["description"]:
        desc_preview = parsed["description"][:120]
        if len(parsed["description"]) > 120:
            desc_preview += "..."
        lines.append(f"📝 <b>الوصف:</b> {desc_preview}")

    if parsed["files"]:
        lines.append(f"📁 <b>الملفات:</b> <code>{parsed['files'][:150]}</code>")

    if parsed["depends_on"]:
        lines.append(f"🔗 <b>يعتمد على:</b> {parsed['depends_on'][:80]}")

    lines.append(f"⚡ <b>الأولوية:</b> {parsed['priority']}")
    lines.append(f"⏰ <b>الوقت:</b> {datetime.now().strftime('%d/%m/%Y %H:%M')}")

    if page_url:
        lines.append(f"")
        lines.append(f"🔗 <a href='{page_url}'>افتح في Notion</a>")

    return "\n".join(lines)


# ============================================================
# Main
# ============================================================
def get_offset():
    try:
        with open(OFFSET_FILE, "r") as f:
            return int(f.read().strip())
    except:
        return 0

def save_offset(offset):
    with open(OFFSET_FILE, "w") as f:
        f.write(str(offset))

def get_updates(offset):
    r = requests.get(
        f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates",
        params={"offset": offset, "timeout": 5},
    )
    return r.json().get("result", [])


def main():
    offset = get_offset()
    updates = get_updates(offset)
    new_offset = offset

    for update in updates:
        update_id = update["update_id"]
        message = update.get("message", {})
        chat_id = message.get("chat", {}).get("id")
        text = message.get("text", "").strip()

        if text and chat_id:
            if text in ("/start", "/help"):
                send_message(chat_id, HELP_TEXT)

            else:
                parsed = parse_message(text)

                if not parsed["title"]:
                    send_message(chat_id, "⚠️ مش قادر أقرأ عنوان التاسك. ابعت /help لتشوف الـ format.")
                else:
                    success, page_url = add_to_notion(parsed)

                    if success:
                        confirmation = build_confirmation(parsed, page_url)
                        send_message(chat_id, confirmation)
                    else:
                        send_message(
                            chat_id,
                            f"❌ <b>فشل إضافة التاسك!</b>\n"
                            f"التاسك: {parsed['title'][:60]}\n"
                            f"جرب تاني أو تأكد من الـ Notion connection."
                        )

        new_offset = update_id + 1

    if updates:
        save_offset(new_offset)


if __name__ == "__main__":
    main()