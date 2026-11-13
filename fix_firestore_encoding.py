import os
import sys
from datetime import datetime, timedelta, timezone
import firebase_admin
from firebase_admin import credentials, firestore

# Windows-1252 byte mapping for 0x80-0x9F characters
cp1252_map = {
    '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84,
    '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88,
    '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C,
    '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93,
    '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
    '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B,
    '\u0153': 0x9C, '\u017E': 0x9E, '\u0178': 0x9F,
}

def is_mojibake(text):
    if not text:
        return False
    # Arabic mojibake markers from UTF-8 decoded as latin1/windows-1252
    patterns = ['Ø§', 'Ø¹', 'Ø¨', 'Øª', 'Ø«', 'Ø¬', 'Ø­', 'Ø®', 'Ø¯', 'Ø°', 
                'Ø±', 'Ø²', 'Ø³', 'Ø´', 'Øµ', 'Ø¶', 'Ø·', 'Ø¸', 'Ù', 'Ã', 'Â']
    match_count = sum(text.count(p) for p in patterns)
    return match_count >= 2

def decode_mojibake(s):
    if not is_mojibake(s):
        return s

    b = bytearray()
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        # In UTF-8 Arabic:
        # \u00D9\uFFFD or isolated \u00D9 represents 0xD9 0x81 (Arabic letter Feh 'ف')
        # \u00D8\uFFFD represents 0xD8 0x81
        if c == '\u00D9' and i + 1 < n and s[i+1] == '\uFFFD':
            b.append(0xD9)
            b.append(0x81)
            i += 2
            continue
        if c == '\u00D9' and (i + 1 >= n or s[i+1] == '\u00D9' or s[i+1] == ' ' or s[i+1] == '.' or s[i+1] == ':'):
            b.append(0xD9)
            b.append(0x81)
            i += 1
            continue
        if c == '\u00D8' and i + 1 < n and s[i+1] == '\uFFFD':
            b.append(0xD8)
            b.append(0x81)
            i += 2
            continue
        if c in cp1252_map:
            b.append(cp1252_map[c])
        elif ord(c) < 256:
            b.append(ord(c))
        else:
            b.extend(c.encode('utf-8'))
        i += 1
    
    try:
        res = b.decode('utf-8', errors='replace')
        res = res.replace('\ufffd', '')
        # Fix damma misidentified as feh in rare words
        res = res.replace('يفعتقد', 'يُعتقد')
        res = res.replace('قفتل', 'قُتل')
        res = res.replace('بفعد', 'بعد')
        return res
    except Exception:
        return s

def main():
    cred_path = r"C:\Users\tiger\StudioProjects\saudi_news\news-saudi-ced66-firebase-adminsdk-fbsvc-179e35b4cb.json"
    if not os.path.exists(cred_path):
        print(f"Error: Credentials not found at {cred_path}")
        sys.exit(1)

    cred = credentials.Certificate(cred_path)
    firebase_admin.initialize_app(cred)
    db = firestore.client()

    collections = ['news', 'jobs', 'spl', 'technology']
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=72)
    print(f"🚀 Starting cleanup for documents created in the last 72 hours (since {cutoff.isoformat()})...\n")

    total_scanned = 0
    total_updated = 0

    for coll_name in collections:
        print(f"🔍 Checking collection: [{coll_name}]...")
        coll_ref = db.collection(coll_name)
        docs = coll_ref.stream()

        coll_scanned = 0
        coll_updated = 0

        for doc in docs:
            data = doc.to_dict()
            doc_time = None
            ts = data.get('timestamp')
            if ts and hasattr(ts, 'timestamp'):
                doc_time = ts
            else:
                created_at_str = data.get('createdAt')
                if created_at_str:
                    try:
                        doc_time = datetime.fromisoformat(created_at_str.replace('Z', '+00:00'))
                    except Exception:
                        pass

            # Only check within last 72 hours
            if doc_time and doc_time < cutoff:
                continue

            coll_scanned += 1
            total_scanned += 1

            original_text = data.get('text', '')
            if is_mojibake(original_text):
                fixed_text = decode_mojibake(original_text)
                if fixed_text != original_text:
                    # Update document in Firestore
                    doc.reference.update({'text': fixed_text})
                    coll_updated += 1
                    total_updated += 1
                    print(f"  ✅ Updated [{coll_name}] doc {doc.id}")
                    print(f"     Before: {original_text[:60]!r}")
                    print(f"     After:  {fixed_text[:60]!r}\n")

        print(f"📊 [{coll_name}] Scanned in 72h window: {coll_scanned}, Updated: {coll_updated}\n")

    print(f"🎉 Cleanup completed successfully!")
    print(f"   Total scanned (72h): {total_scanned}")
    print(f"   Total documents updated: {total_updated}")

if __name__ == '__main__':
    main()
