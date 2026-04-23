# import os
# import requests
# from datetime import datetime

# TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
# NOTION_TOKEN = os.environ["NOTION_TOKEN"]
# NOTION_DATABASE_ID = os.environ["NOTION_DATABASE_ID"]
# OFFSET_FILE = "last_offset.txt"

# def get_offset():
#     try:
#         with open(OFFSET_FILE, "r") as f:
#             return int(f.read().strip())
#     except:
#         return 0

# def save_offset(offset):
#     with open(OFFSET_FILE, "w") as f:
#         f.write(str(offset))

# def get_updates(offset):
#     url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates"
#     response = requests.get(url, params={"offset": offset, "timeout": 5})
#     return response.json().get("result", [])

# def add_to_notion(text):
#     url = "https://api.notion.com/v1/pages"
#     headers = {
#         "Authorization": f"Bearer {NOTION_TOKEN}",
#         "Content-Type": "application/json",
#         "Notion-Version": "2022-06-28"
#     }
#     data = {
#         "parent": {"database_id": NOTION_DATABASE_ID},
#         "properties": {
#             "Task Name": {
#                 "title": [{"text": {"content": text[:200]}}]
#             },
#             "Status": {
#                 "select": {"name": "🆕 New"}
#             },
#             "Priority": {
#                 "select": {"name": "🟡 Medium"}
#             },
#             "Source": {
#                 "select": {"name": "📱 Telegram"}
#             },
#             "Notes": {
#                 "rich_text": [{"text": {"content": f"Received: {datetime.now().strftime('%d/%m/%Y %H:%M')}"}}]
#             }
#         }
#     }
#     r = requests.post(url, headers=headers, json=data)
#     return r.status_code == 200

# def send_reply(chat_id, text):
#     url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
#     requests.post(url, json={
#         "chat_id": chat_id,
#         "text": text,
#         "parse_mode": "HTML"
#     })

# def main():
#     offset = get_offset()
#     updates = get_updates(offset)
#     new_offset = offset

#     for update in updates:
#         update_id = update["update_id"]
#         message = update.get("message", {})
#         chat_id = message.get("chat", {}).get("id")
#         text = message.get("text", "")

#         if text and chat_id:
#             if text == "/start":
#                 send_reply(chat_id,
#                     "👋 <b>أهلاً!</b>\n\n"
#                     "ابعت أي فكرة أو تاسك وهيتضاف في Notion فوراً ✅"
#                 )
#             else:
#                 success = add_to_notion(text)
#                 if success:
#                     send_reply(chat_id,
#                         f"✅ <b>اتضاف في Notion!</b>\n\n"
#                         f"📝 <b>التاسك:</b> {text[:150]}\n"
#                         f"📊 <b>Status:</b> 🆕 New\n"
#                         f"⭐ <b>Priority:</b> 🟡 Medium\n"
#                         f"⏰ <b>الوقت:</b> {datetime.now().strftime('%d/%m/%Y %H:%M')}"
#                     )
#                 else:
#                     send_reply(chat_id, "❌ في مشكلة في Notion، جرب تاني.")

#         new_offset = update_id + 1

#     save_offset(new_offset)

# if __name__ == "__main__":
#     main()


import os
import requests
from datetime import datetime

print("=" * 50)
print("🔍 DEBUG: فحص كل حاجة خطوة بخطوة")
print("=" * 50)

# ==========================================
# ضع الـ Secrets هنا مباشرة للتجربة فقط
# ==========================================
TELEGRAM_TOKEN = "8627881769:AAEB3k2N0Sz-j9qZXhSvxZWipIQ66ByuGWQ"
NOTION_TOKEN = "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"
NOTION_DATABASE_ID = "348f6b54f81b808d84fff53f697a0af6"
# ==========================================

print("\n📋 STEP 1: فحص القيم المدخلة")
print(f"  Telegram Token: {TELEGRAM_TOKEN[:10]}..." if len(TELEGRAM_TOKEN) > 10 else "  ❌ Telegram Token فاضي!")
print(f"  Notion Token:   {NOTION_TOKEN[:10]}..." if len(NOTION_TOKEN) > 10 else "  ❌ Notion Token فاضي!")
print(f"  Database ID:    {NOTION_DATABASE_ID}")

# ==========================================
print("\n📋 STEP 2: فحص Telegram Bot")
# ==========================================
try:
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getMe"
    r = requests.get(url, timeout=10)
    data = r.json()
    if data.get("ok"):
        bot = data["result"]
        print(f"  ✅ البوت شغال!")
        print(f"  اسمه: {bot['first_name']}")
        print(f"  Username: @{bot['username']}")
    else:
        print(f"  ❌ خطأ في Telegram Token!")
        print(f"  السبب: {data.get('description')}")
except Exception as e:
    print(f"  ❌ مش قادر يتصل بـ Telegram: {e}")

# ==========================================
print("\n📋 STEP 3: فحص الرسايل الجديدة")
# ==========================================
try:
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates"
    r = requests.get(url, params={"limit": 5}, timeout=10)
    data = r.json()
    updates = data.get("result", [])
    if updates:
        print(f"  ✅ فيه {len(updates)} رسالة")
        for u in updates:
            msg = u.get("message", {})
            text = msg.get("text", "[مش نص]")
            chat_id = msg.get("chat", {}).get("id", "؟")
            print(f"  - Chat ID: {chat_id} | الرسالة: {text[:50]}")
    else:
        print("  ⚠️  مفيش رسايل جديدة — ابعت رسالة للبوت الأول!")
except Exception as e:
    print(f"  ❌ خطأ: {e}")

# ==========================================
print("\n📋 STEP 4: فحص Notion Connection")
# ==========================================
try:
    url = "https://api.notion.com/v1/users/me"
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": "2022-06-28"
    }
    r = requests.get(url, headers=headers, timeout=10)
    data = r.json()
    if r.status_code == 200:
        print(f"  ✅ Notion Token صح!")
        print(f"  الاسم: {data.get('name', 'غير معروف')}")
    else:
        print(f"  ❌ Notion Token غلط!")
        print(f"  السبب: {data.get('message')}")
except Exception as e:
    print(f"  ❌ مش قادر يتصل بـ Notion: {e}")

# ==========================================
print("\n📋 STEP 5: فحص الـ Database")
# ==========================================
try:
    url = f"https://api.notion.com/v1/databases/{NOTION_DATABASE_ID}"
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": "2022-06-28"
    }
    r = requests.get(url, headers=headers, timeout=10)
    data = r.json()
    if r.status_code == 200:
        print(f"  ✅ Database موجودة ومتصلة!")
        print(f"  الاسم: {data['title'][0]['plain_text']}")
        props = list(data['properties'].keys())
        print(f"  الـ Properties: {props}")
    else:
        print(f"  ❌ مشكلة في الـ Database!")
        print(f"  السبب: {data.get('message')}")
        print(f"  تأكد إن الـ Integration اتضاف للـ Database (خطوة 5 في الشرح)")
except Exception as e:
    print(f"  ❌ خطأ: {e}")

# ==========================================
print("\n📋 STEP 6: تجربة إضافة Task في Notion")
# ==========================================
try:
    url = "https://api.notion.com/v1/pages"
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
    }
    data = {
        "parent": {"database_id": NOTION_DATABASE_ID},
        "properties": {
            "Property": { # Changed from "Task Name" to "Property"
                "title": [{"text": {"content": f"🧪 تجربة Debug - {datetime.now().strftime('%H:%M:%S')}"}}]
            }
        }
    }
    r = requests.post(url, headers=headers, json=data, timeout=10)
    if r.status_code == 200:
        print(f"  ✅ Task اتضافت في Notion بنجاح!")
        print(f"  روح شوف الـ Database دلوقتي ✨")
    else:
        result = r.json()
        print(f"  ❌ فشل الإضافة!")
        print(f"  السبب: {result.get('message')}")
        print(f"  الـ Code: {result.get('code')}")
        print(f"  Full response: {result}")
except Exception as e:
    print(f"  ❌ خطأ: {e}")

print("\n" + "=" * 50)
print("✅ انتهى الفحص")
print("=" * 50)
