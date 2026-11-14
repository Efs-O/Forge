import re, sys, pathlib
sys.stdout.reconfigure(encoding='utf-8')

tips = pathlib.Path('docs/CODING_TIPS.md').read_text(encoding='utf-8').splitlines()
entries = [l for l in tips if re.match(r'^\d+\.\s', l)]

# Distinctive tokens per entry: backticked code spans, first three only.
def tokens(line):
    out = []
    for m in re.findall(r'`([^`]{3,40})`', line):
        t = m.strip()
        if len(t) < 3:
            continue
        out.append(t)
    return out[:3]

targets = [
    'FORGE.md',
    'config/templates/builtin/execute.njk',
    'docs/AGENT_TOOL_TRAPS.md',
    'src/llm/ForgeInstructionsLoader.ts',
    'CLAUDE.md',
    'AGENTS.md',
    'AI_SETUP.md',
]
blobs = {}
for f in targets:
    p = pathlib.Path(f)
    if not p.exists():
        print(f'MISSING: {f}')
        continue
    text = p.read_text(encoding='utf-8', errors='replace')
    # FORGE.md: only the part ABOVE the injected tips copy counts as its own text.
    if f == 'FORGE.md':
        i = text.find('TIPS-INJECT-START')
        if i > 0:
            text = text[:i]
    blobs[f] = [(n, l) for n, l in enumerate(text.splitlines(), 1)]

for line in entries:
    tks = tokens(line)
    if not tks:
        continue
    hits = []
    for f, lines in blobs.items():
        for n, l in lines:
            low = l.lower()
            for t in tks:
                if t.lower() in low:
                    hits.append((f, n, t, l.strip()[:150]))
                    break
    if hits:
        print('\nTIP:', line[:110])
        seen = set()
        for f, n, t, l in hits:
            k = (f, n)
            if k in seen:
                continue
            seen.add(k)
            print(f'   {f}:{n} [{t}] {l}')
