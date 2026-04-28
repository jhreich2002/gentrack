"""Inject checkInternalAuth() into every edge function index.ts."""
import os, re

root = 'supabase/functions'
fns = sorted([d for d in os.listdir(root)
              if os.path.isdir(f'{root}/{d}')
              and not d.startswith('_')
              and os.path.exists(f'{root}/{d}/index.ts')])

import_line = "import { checkInternalAuth } from '../_shared/auth.ts';"
auth_snippet = '  const __authDenied = checkInternalAuth(req);\n  if (__authDenied) return __authDenied;\n'

# Normalize _req → req in the Deno.serve signature so we can reference req in auth check
normalizations = [
    (re.compile(r'Deno\.serve\(async \(_req\) => \{'),         'Deno.serve(async (req: Request) => {'),
    (re.compile(r'Deno\.serve\(async \(_req: Request\) => \{'), 'Deno.serve(async (req: Request) => {'),
]

modified, skipped = [], []
for fn in fns:
    path = f'{root}/{fn}/index.ts'
    src = open(path, 'r', encoding='utf-8').read()
    if 'checkInternalAuth' in src:
        skipped.append(f'{fn} (already patched)')
        continue

    for pat, repl in normalizations:
        src = pat.sub(repl, src)

    # Inject import after the last top-of-file import statement
    imports = list(re.finditer(r'^import .+?;', src, flags=re.MULTILINE))
    if not imports:
        skipped.append(f'{fn} (no import block)')
        continue
    last = imports[-1]
    src = src[:last.end()] + '\n' + import_line + src[last.end():]

    # Inject auth check right after Deno.serve(async (req...) => {
    serve_re = re.compile(r'(Deno\.serve\(async \(req[^)]*\)[^{]*\{\s*\n)')
    m = serve_re.search(src)
    if not m:
        skipped.append(f'{fn} (Deno.serve signature not matched)')
        continue
    src = src[:m.end()] + auth_snippet + src[m.end():]

    open(path, 'w', encoding='utf-8').write(src)
    modified.append(fn)

print(f'Modified {len(modified)} functions:')
for f in modified:
    print('  ', f)
if skipped:
    print(f'\nSkipped {len(skipped)}:')
    for f in skipped:
        print('  ', f)
