import json
from collections import Counter

d = json.load(open('.artifacts/mutation/mutation.json'))
print("top keys:", list(d.keys()))
print("schemaVersion:", d.get('schemaVersion'))
print("thresholds:", d.get('thresholds'))
print("scores:", d.get('scores'))
print("stats:", d.get('stats'))
files = d.get('files', {})
print("file count:", len(files))

c = Counter()
survivors = []
for path, f in files.items():
    for m in f.get('mutants', []):
        c[m['status']] += 1
        if m['status'] == 'Survived':
            loc = m['location']
            survivors.append({
                'path': path,
                'line': loc['start']['line'],
                'col': loc['start'].get('column'),
                'id': m.get('id'),
                'mutator': m.get('mutatorName'),
                'replacement': m.get('replacement'),
                'statusReason': m.get('statusReason'),
            })

total = sum(c.values())
det = c['Killed'] + c['Timeout']
print("status counts:", dict(c))
print(f"total={total} killed={c['Killed']} timeout={c['Timeout']} survived={c['Survived']} noCoverage={c['NoCoverage']}")
print(f"detected={det} score={det/total*100:.4f}")
print("--- survivors (sorted by path,line) ---")
for s in sorted(survivors, key=lambda x: (x['path'], x['line'], x['col'] or 0)):
    print(f"{s['path']}:{s['line']}:{s['col']} id={s['id']} mutator={s['mutator']} replacement={s['replacement']!r}")
