import os
import json
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
    params = {"offset": offset, "timeout": 5}
    response = requests.get(url, params=params)
    return response.json().get("result", [])

def add_to_notion(text, source="Telegram"):
    url = "https://api.notion.com/v1/pages"
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
    }
    data = {
        "parent": {"database_id": NOTION_DATABASE_ID},
        "properties": {
            "Task Name": {
                "title": [{"text": {"content": text[:200]}}]
            },
            "Status": {
                "select": {"name": "🆕 New"}
            },
            "Priority": {
                "select": {"name": "🟡 Medium"}
            },
            "Source": {
                "select": {"name": f"📱 {source}"}
            },
            "Notes": {
                "rich_text": [{"text": {"content": f"Received: {datetime.now().strftime('%d/%m/%Y %H:%M')}"}}]
            }
        }
    }
    response = requests.post(url, headers=headers, json=data)
    return response.status_code == 200

def send_reply(chat_id, text):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    requests.post(url, json={"chat_id": chat_id, "text": text})

def main():
    offset = get_offset()
    updates = get_updates(offset)

    for update in updates:
        update_id = update["update_id"]
        message = update.get("message", {})
        chat_id = message.get("chat", {}).get("id")
        text = message.get("text", "")

        if text and chat_id:
            if text == "/start":
                send_reply(chat_id, "✅ البوت شغال! ابعت أي فكرة وهتتضاف في Notion.")
            else:
                success = add_to_notion(text)
                if success:
                    send_reply(chat_id, f"✅ اتضافت في Notion!\n\n📝 {text[:100]}")
                else:
                    send_reply(chat_id, "❌ في مشكلة، جرب تاني.")

        offset = update_id + 1

    if updates:
        save_offset(offset)

if __name__ == "__main__":
    main()
