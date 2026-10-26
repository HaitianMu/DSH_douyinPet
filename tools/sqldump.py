import sqlite3, sys, os, json

def dump(path, out):
    lines = []
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        cur = con.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [r[0] for r in cur.fetchall()]
        lines.append(f"# DB: {path}\n# tables: {tables}\n")
        for t in tables:
            try:
                cur.execute(f"PRAGMA table_info('{t}')")
                cols = [r[1] for r in cur.fetchall()]
                cur.execute(f"SELECT COUNT(*) FROM '{t}'")
                n = cur.fetchone()[0]
                lines.append(f"\n## table {t} ({n} rows) cols={cols}\n")
                if t in ("cookies",):
                    cur.execute(f"SELECT host_key, name, path, is_secure, is_httponly, expires_utc, length(value), length(encrypted_value) FROM '{t}' ORDER BY host_key")
                    for r in cur.fetchall():
                        lines.append("\t".join(str(x) for x in r) + "\n")
                else:
                    cur.execute(f"SELECT * FROM '{t}' LIMIT 25")
                    for r in cur.fetchall():
                        s = str(r)
                        lines.append(s[:800] + "\n")
            except Exception as e:
                lines.append(f"!! {t}: {e}\n")
        con.close()
    except Exception as e:
        lines.append(f"ERROR {e}\n")
    with open(out, "w", encoding="utf-8", errors="replace") as f:
        f.writelines(lines)
    print(f"{path} -> {out} ({len(lines)} lines)")

dump(sys.argv[1], sys.argv[2])
