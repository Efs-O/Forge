import re, sys, pathlib, glob
sys.stdout.reconfigure(encoding='utf-8')
R = pathlib.Path(__file__).resolve().parents[2]  # the repo this script lives in
RATIO = 4.62  # chars/token measured 2026-09-30, llama.cpp b11243 + Qwen3.8-27B Q6_K (ToolSchemaBudget.test.ts)

def report(name, text):
    b = len(text.encode('utf-8'))
    c = len(text)
    print(f'{name:34s} bytes={b:7d} chars={c:7d} ~tokens={int(c / RATIO):5d}')

# 1. the three injected files
exec_njk = (R / 'config/templates/builtin/execute.njk').read_text(encoding='utf-8')
report('execute.njk (shipped prompt)', exec_njk)

tips = (R / 'docs/CODING_TIPS.md').read_text(encoding='utf-8')
report('CODING_TIPS.md (will ship)', tips)

forge = (R / 'FORGE.md').read_text(encoding='utf-8')
i = forge.find('TIPS-INJECT-START')
own = forge[:i] if i > 0 else forge
report('FORGE.md own content', own)
report('FORGE.md whole file', forge)

# 2. the starter instruction text the code writes for new users
loader = (R / 'src/llm/ForgeInstructionsLoader.ts').read_text(encoding='utf-8')
m = re.search(r'const STARTER_CONTENT = `(.*?)\n`;', loader, re.S)
report('starter FORGE.md text in code', m.group(1) if m else 'NOT FOUND')

# 3. the skills block: template plus what it renders from on this machine
tmpl = (R / 'config/templates/builtin/skills.njk').read_text(encoding='utf-8')
report('skills.njk template', tmpl)
roots = [pathlib.Path.home() / '.forge/skills', R / 'skills', R / 'config/skills']
found, total = [], 0
for root in roots:
    for sk in sorted(glob.glob(str(root / '*/SKILL.md'))) if root.exists() else []:
        text = pathlib.Path(sk).read_text(encoding='utf-8', errors='replace')
        fm = re.match(r'^---\n(.*?)\n---', text, re.S)
        desc = ''
        if fm:
            d = re.search(r'^description:\s*(.+)$', fm.group(1), re.M)
            desc = d.group(1).strip().strip('"') if d else ''
        found.append((str(sk), len(desc)))
        total += len(desc)
print(f'skills installed={len(found)} description_chars={total} ~tokens={int(total / RATIO)}')
for sk, n in found:
    print(f'  skill {n:5d} {sk}')
