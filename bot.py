import os
import requests
from datetime import datetime

TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
NOTION_TOKEN = os.environ["NOTION_TOKEN"]
NOTION_DATABASE_ID = os.environ["NOTION_DATABASE_ID"]
OFFSET_FILE = "last_offset.txt"

print("=" * 55)
print("🔍 اختبار شامل للنظام")
print("=" * 55)

# STEP 1: Telegram
print("\n✅ STEP 1: Telegram Bot")
r = requests.get(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getMe").json()
if r.get("ok"):
    print(f"   البوت: @{r['result']['username']} ✅")
else:
    print(f"   ❌ Token غلط: {r.get('description')}")
    exit()

# STEP 2: آخر رسايل
print("\n✅ STEP 2: آخر 5 رسايل في Telegram")
r = requests.get(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates",
                 params={"limit": 5}).json()
updates = r.get("result", [])
if updates:
    for u in updates:
        msg = u.get("message", {})
        print(f"   [{u['update_id']}] {msg.get('text','')[:60]}")
    print(f"\n   ⚠️  آخر offset = {updates[-1]['update_id'] + 1}")
    print(f"   تأكد إن last_offset.txt على GitHub فيه: 0")
    print(f"   أو فيه رقم أقل من {updates[0]['update_id']}")
else:
    print("   ⚠️  مفيش رسايل — ابعت رسالة للبوت الأول!")

# STEP 3: Notion Database الجديدة
print("\n✅ STEP 3: Notion Database")
headers = {
    "Authorization": f"Bearer {NOTION_TOKEN}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json"
}
r = requests.get(f"https://api.notion.com/v1/databases/{NOTION_DATABASE_ID}",
                 headers=headers).json()
if "properties" in r:
    props = list(r["properties"].keys())
    print(f"   Database: {r['title'][0]['plain_text']} ✅")
    print(f"   Properties: {props}")
    if "Task Name" in props:
        print("   'Task Name' موجود ✅")
    else:
        print(f"   ❌ 'Task Name' مش موجود! الموجود: {props}")
        exit()
else:
    print(f"   ❌ مشكلة: {r.get('message')}")
    exit()

# STEP 4: تجربة إضافة Task حقيقية
print("\n✅ STEP 4: إضافة Task تجريبية")
data = {
    "parent": {"database_id": NOTION_DATABASE_ID},
    "properties": {
        "Task Name": {"title": [{"text": {"content": f"✅ Test {datetime.now().strftime('%H:%M:%S')}"}}]},
        "Status": {"select": {"name": "🆕 New"}},
        "Priority": {"select": {"name": "🟡 Medium"}},
        "Source": {"select": {"name": "📱 Telegram"}},
        "Notes": {"rich_text": [{"text": {"content": "Test من debug script"}}]}
    }
}
r = requests.post("https://api.notion.com/v1/pages", headers=headers, json=data)
if r.status_code == 200:
    print("   ✅ Task اتضافت في Notion — روح شوفها!")
else:
    print(f"   ❌ فشل: {r.json().get('message')}")

# STEP 5: تحقق من Integration
print("\n✅ STEP 5: Integration متصل بالـ Database؟")
r = requests.post("https://api.notion.com/v1/databases/query",
                  headers=headers,
                  json={"database_id": NOTION_DATABASE_ID})
if r.status_code == 200:
    results = r.json().get("results", [])
    print(f"   ✅ Integration شغال — عدد الصفوف: {len(results)}")
else:
    print(f"   ❌ Integration مش متصل! روح Notion > ... > Add connections")

print("\n" + "=" * 55)
print("🏁 انتهى الاختبار")
print("=" * 55)
