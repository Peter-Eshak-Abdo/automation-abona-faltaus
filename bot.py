import os
import requests
from datetime import datetime

TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
NOTION_TOKEN = os.environ["NOTION_TOKEN"]
NOTION_DATABASE_ID = os.environ["NOTION_DATABASE_ID"]
OFFSET_FILE = "last_offset.txt"

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
        params={"offset": offset, "timeout": 5}
    )
    return r.json().get("result", [])

def add_to_notion(text):
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
    }
    data = {
        "parent": {"database_id": NOTION_DATABASE_ID},
        "properties": {
            "Task Name": {"title": [{"text": {"content": text[:200]}}]},
            "Status": {"select": {"name": "🆕 New"}},
            "Priority": {"select": {"name": "🟡 Medium"}},
            "Source": {"select": {"name": "📱 Telegram"}},
            "Notes": {"rich_text": [{"text": {"content": f"Received: {datetime.now().strftime('%d/%m/%Y %H:%M')}"}}]}
        }
    }
    r = requests.post("https://api.notion.com/v1/pages", headers=headers, json=data)
    return r.status_code == 200

def send_message(chat_id, text):
    requests.post(
        f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
        json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    )

def main():
    offset = get_offset()
    updates = get_updates(offset)
    new_offset = offset
    tasks_added = []
    tasks_failed = []
    last_chat_id = None

    for update in updates:
        update_id = update["update_id"]
        message = update.get("message", {})
        chat_id = message.get("chat", {}).get("id")
        text = message.get("text", "")
        last_chat_id = chat_id

        if text and chat_id:
            if text == "/start":
                send_message(chat_id,
                    "👋 <b>أهلاً!</b>\n\nابعت أي فكرة أو تاسك وهيتضاف في Notion ✅"
                )
            else:
                if add_to_notion(text):
                    tasks_added.append(text[:80])
                else:
                    tasks_failed.append(text[:80])

        new_offset = update_id + 1

    if tasks_added and last_chat_id:
        tasks_list = "\n".join([f"• {t}" for t in tasks_added])
        send_message(last_chat_id,
            f"✅ <b>تم إضافة {len(tasks_added)} تاسك في Notion!</b>\n\n"
            f"📝 <b>التاسكات:</b>\n{tasks_list}\n\n"
            f"⏰ <b>الوقت:</b> {datetime.now().strftime('%d/%m/%Y %H:%M')}"
        )

    if tasks_failed and last_chat_id:
        send_message(last_chat_id, f"❌ فشل إضافة {len(tasks_failed)} تاسك، جرب تاني.")

    if updates:
        save_offset(new_offset)

if __name__ == "__main__":
    main()
