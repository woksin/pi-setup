#!/usr/bin/env python3
"""Check a staged copy of the published tree before sync.sh writes it into the checkout.

usage: publish-check.py STAGE [SECRET_MASK_TS]

Checks, each failing the run with the offending relative path:
  1. file-type allowlist (unknown types, odd extensionless files, symlinks out of the tree);
  2. field names that look like credentials in the named JSON configs;
  3. generic PASSWORD=/connection-string shapes in text files;
  4. the live secret-mask scanner (lib/secret-mask.ts), (required).
Fixtures (files under a test/ directory and *.test.ts) are skipped for 3 and 4 only.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

EXTENSIONS = {".ts", ".mts", ".js", ".mjs", ".cjs", ".md", ".py", ".sh", ".json", ".jsonc",
              ".toml", ".yaml", ".yml", ".txt", ".plist"}
NAMED_FILES = {"LICENSE", "README"}
CONFIGS = {"models.json", "provider-fallback.json", "mcp-adapter.json", "efficiency.json",
           "subagents.json", "context-budget.json", "settings.json", "npm-package.json"}
SECRET_KEY = re.compile(r"api[-_]?key|token|secret|password|authorization|bearer|credential", re.I)
REFERENCE = re.compile(r"^(\$|env:|\$\{)")
GENERIC = [
    ("password-assignment", re.compile(r"""\b[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|API_?KEY)[A-Z0-9_]*["']?\s*[=:]\s*["']?(?![\s"'$<{(\[%*])([^\s"'`;,)}\]]{6,})""")),
    ("connection-string", re.compile(r"(?i)\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqps?|sqlserver)://[^\s/:@]+:[^\s@/]{3,}@")),
]
PLACEHOLDER = re.compile(r"(?i)^(?:x+|\*+|changeme|example|placeholder|your[-_a-z]*|<.*>|redacted|\[redacted.*|none|null|true|false|\d+|(?-i:[A-Z][A-Z_]+))$")
# secret-mask matches that are masks or masking code, not credentials. Narrow on purpose:
# applied as secret-mask scan() allowlist patterns, so a real value in the same file still fails.
MASK_ALLOW = [r"^\*{3}$"]  # the value of chronicle://client:***@host (an already masked password)
MASK_ALLOW_FILE = {  # exact stage path -> patterns, matched against the flagged value
    # the shell tokenizer regex literal `/(<<-?|1?>>?)|('...` reads as a connection string
    "agent/extensions/cratis-cli-guard.ts": [r"^/\(<<-\?\|1\?>>\?\)\|\($"],
}
FIXTURE = re.compile(r"(^|/)test/|\.test\.ts$")


def fixture(rel):
    return bool(FIXTURE.search(rel))


def allowed_type(path, rel):
    name = path.name
    if path.is_symlink():
        return False
    if path.suffix in EXTENSIONS or name in NAMED_FILES or name.endswith(".d.ts"):
        return True
    if path.suffix == "" and os.access(path, os.X_OK):
        with open(path, "rb") as handle:
            return handle.read(2) == b"#!"
    return False


def key_findings(node, trail="", credential=False):
    # A literal string at or below a credential-like key is a finding (containers included);
    # numbers are budgets (maxContextTokens); "$VAR"/"env:" values are references.
    if isinstance(node, dict):
        for key, value in node.items():
            yield from key_findings(value, f"{trail}.{key}" if trail else key, credential or bool(SECRET_KEY.search(key)))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from key_findings(value, f"{trail}[{index}]", credential)
    elif credential and isinstance(node, str) and not REFERENCE.match(node):
        yield trail


def config_key_findings(filename, node):
    for field in key_findings(node):
        # Only this root budget field has a string enum; credential strings elsewhere still fail.
        if (filename, field) == ("provider-fallback.json", "maxContextTokensForFallback"):
            if node[field] == "auto":
                continue
        yield field


def text_of(path):
    data = path.read_bytes()
    return None if b"\0" in data else data.decode("utf-8", "replace")


def secret_mask(stage, library, texts):
    # The scanner ships with the setup: missing, unloadable, or skipping a file is a failure.
    if not library or not Path(library).is_file():
        return ["secret-mask scanner missing or unloadable (lib/secret-mask.ts); sync refused"]
    script = ("import{readFileSync}from'node:fs';const m=await import(process.argv[1]);"
              "if(typeof m.scan!=='function')process.exit(3);"
              "const a=JSON.parse(process.argv[2]);for(const [f,x] of JSON.parse(readFileSync(0,'utf8'))){const r=m.scan(readFileSync(f,'utf8'),[...a,...x]);"
              "if(r.skipped)console.log(f+'\\tSKIPPED');else if(r.count)console.log(f+'\\t'+r.kinds.join(','))}")
    run = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script,
                          str(Path(library).resolve()), json.dumps(MASK_ALLOW)],
                         input=json.dumps([[str(stage / rel), MASK_ALLOW_FILE.get(rel, [])] for rel in texts]), capture_output=True, text=True)
    if run.returncode:  # never echo scanner output: it may contain the secret it choked on
        return [f"secret-mask scanner failed (exit {run.returncode}); output suppressed"]
    findings = []
    for line in run.stdout.splitlines():
        name, _, kinds = line.partition("\t")
        try:
            rel = Path(name).relative_to(stage)
        except ValueError:
            return ["secret-mask scanner produced unexpected output; suppressed"]
        findings.append(f"{rel}: secret-mask scan skipped (file too large)" if kinds == "SKIPPED"
                        else f"{rel}: secret-mask ({kinds})")
    return findings


def main():
    stage = Path(sys.argv[1]).resolve()
    library = sys.argv[2] if len(sys.argv) > 2 else None
    problems, texts = [], []
    for path in sorted(stage.rglob("*")):
        rel = path.relative_to(stage).as_posix()
        if path.is_dir() and not path.is_symlink():
            continue
        if not allowed_type(path, rel):
            problems.append(f"{rel}: file type not allowed")
            continue
        content = text_of(path)
        if content is None:
            problems.append(f"{rel}: binary content")
            continue
        if path.name in CONFIGS:
            try:
                problems += [f"{rel}: secret-like field {key}" for key in config_key_findings(path.name, json.loads(content))]
            except ValueError as error:
                problems.append(f"{rel}: invalid JSON ({error})")
        if fixture(rel):
            continue
        texts.append(rel)
        for number, line in enumerate(content.splitlines(), 1):
            for kind, pattern in GENERIC:
                match = pattern.search(line)
                if match and not PLACEHOLDER.match(match.group(match.lastindex) if match.lastindex else ""):
                    problems.append(f"{rel}:{number}: {kind}")
    problems += secret_mask(stage, library, texts)
    for problem in problems:
        print(f"publish-check: {problem}", file=sys.stderr)
    if problems:
        sys.exit(f"publish-check: {len(problems)} finding(s); nothing was written to the checkout")
    print(f"publish-check: {len(texts)} text files checked, no findings")


if __name__ == "__main__":
    main()
