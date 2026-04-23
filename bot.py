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
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates"
    response = requests.get(url, params={"offset": offset, "timeout": 5})
    return response.json().get("result", [])

def add_to_notion(text):
    url = "https://api.notion.com/v1/pages"
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
    }
    data = {
        "parent": {"database_id": NOTION_DATABASE_ID},
        "properties": {
            "Property": {
                "title": [{"text": {"content": text[:200]}}]
            }
        }
    }
    r = requests.post(url, headers=headers, json=data)
    return r.status_code == 200

def send_reply(chat_id, text):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    requests.post(url, json={
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML"
    })

def main():
    offset = get_offset()
    updates = get_updates(offset)
    new_offset = offset

    for update in updates:
        update_id = update["update_id"]
        message = update.get("message", {})
        chat_id = message.get("chat", {}).get("id")
        text = message.get("text", "")

        if text and chat_id:
            if text == "/start":
                send_reply(chat_id,
                    "👋 <b>أهلاً!</b>\n\n"
                    "ابعت أي فكرة أو تاسك وهيتضاف في Notion فوراً ✅"
                )
            else:
                success = add_to_notion(text)
                if success:
                    send_reply(chat_id,
                        f"✅ <b>اتضاف في Notion!</b>\n\n"
                        f"📝 <b>التاسك:</b> {text[:150]}\n"
                        f"📊 <b>Status:</b> 🆕 New\n"
                        f"⏰ <b>الوقت:</b> {datetime.now().strftime('%d/%m/%Y %H:%M')}"
                    )
                else:
                    send_reply(chat_id, "❌ في مشكلة في Notion، جرب تاني.")

        new_offset = update_id + 1

    save_offset(new_offset)

if __name__ == "__main__":
    main()
