#!/usr/bin/python3
"""web-guard: blocks single IPs that hammer the web server.

Covers every site on the Lightsail box (borrowedtime, clarknavidad, cnavidad, cloudhopr...),
since they all log to /var/log/httpd/access_log. Run by /etc/cron.d/web-guard every minute,
as root. Installed at /usr/local/bin/web-guard (see DEVELOPER_NOTES.md "Web Guard").

An IP is blocked from ports 80 and 443 (never SSH) when it makes more than
MAX_REQUESTS requests in REQUEST_WINDOW, or downloads more than MAX_BYTES in BYTE_WINDOW.
The first block lasts an hour; another within a day lasts a day. Blocks live in an
nftables set with timeouts, so they expire by themselves.

    web-guard            check the log and block (what cron runs)
    web-guard report     top IPs in the last hour, and what's blocked now
    web-guard unblock IP lift a block

Python 3.9+, standard library only.
"""
import fcntl
import ipaddress
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime

LOG = os.environ.get("WEB_GUARD_LOG", "/var/log/httpd/access_log")
STATE = os.environ.get("WEB_GUARD_STATE", "/var/lib/web-guard/state.json")
ALLOW_FILE = os.environ.get("WEB_GUARD_ALLOW", "/etc/web-guard/allow")  # extra never-block IPs or ranges, one per line
FIRST_READ = 20 * 1024 ** 2  # the very first run only looks at the end of the log

MAX_REQUESTS = 600           # requests from one IP...
REQUEST_WINDOW = 5 * 60      # ...in 5 minutes. A person scrolling a whole gallery makes ~130.
MAX_BYTES = 300 * 1024 ** 2  # bytes sent to one IP...
BYTE_WINDOW = 60 * 60        # ...in an hour. A full gallery visit is ~10 MB.
FIRST_BLOCK = 60 * 60
REPEAT_BLOCK = 24 * 60 * 60
REPEAT_WITHIN = 24 * 60 * 60

NFT = os.environ.get("WEB_GUARD_NFT", "/usr/sbin/nft")
TABLE = "webguard"

# Never blocked: this machine, private networks, and Cloudflare (if a site is ever put behind
# it, all its visitors arrive from these, so blocking one would block everyone).
NEVER = [
    "127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fe80::/10",
    # https://www.cloudflare.com/ips-v4 and ips-v6
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
    "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
    "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
    "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
    "2a06:98c0::/29", "2c0f:f248::/32",
]

LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(?:[^"\\]|\\.)*" \d{3} (\d+|-)(?: "(?:[^"\\]|\\.)*" "((?:[^"\\]|\\.)*)")?')


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def never_block():
    nets = list(NEVER)
    try:
        with open(ALLOW_FILE) as f:
            nets += [l.split("#")[0].strip() for l in f if l.split("#")[0].strip()]
    except FileNotFoundError:
        pass
    out = []
    for n in nets:
        try:
            out.append(ipaddress.ip_network(n, strict=False))
        except ValueError:
            log(f"ignoring bad allow entry {n!r}")
    return out


def exempt(ip, nets):
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True  # not an IP; nothing to block
    return any(addr in n for n in nets if n.version == addr.version)


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {"inode": None, "offset": 0, "minutes": {}, "blocks": {}}


def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE)


def parse_time(stamp):
    # 24/Nov/2026:14:03:11 +0000
    return int(datetime.strptime(stamp, "%d/%b/%Y:%H:%M:%S %z").timestamp())


def read_new_lines(state, path=LOG):
    """Lines added since the last run. Starts over when logrotate replaces the file."""
    st = os.stat(path)
    if state["inode"] is None:
        state["inode"], state["offset"] = st.st_ino, max(0, st.st_size - FIRST_READ)
    elif state["inode"] != st.st_ino or st.st_size < state["offset"]:
        state["inode"], state["offset"] = st.st_ino, 0
    with open(path, "rb") as f:
        f.seek(state["offset"])
        data = f.read()
    end = data.rfind(b"\n") + 1  # leave a half-written last line for next time
    state["offset"] += end
    return data[:end].decode("utf-8", "replace").splitlines()


def tally(state, lines, now):
    """Adds lines to per-minute counts: minutes[minute][ip] = [requests, bytes, last user agent]."""
    minutes = state["minutes"]
    oldest = now - max(REQUEST_WINDOW, BYTE_WINDOW)
    for line in lines:
        m = LINE.match(line)
        if not m:
            continue
        ip, stamp, size, agent = m.groups()
        try:
            t = parse_time(stamp)
        except ValueError:
            continue
        if t < oldest:
            continue
        slot = minutes.setdefault(str(t // 60 * 60), {})
        entry = slot.setdefault(ip, [0, 0, ""])
        entry[0] += 1
        entry[1] += 0 if size == "-" else int(size)
        if agent:
            entry[2] = agent[:120]
    for key in [k for k in minutes if int(k) < oldest - 60]:
        del minutes[key]


def totals(state, now, window):
    out = {}
    for key, slot in state["minutes"].items():
        if int(key) >= now - window:
            for ip, (n, size, agent) in slot.items():
                t = out.setdefault(ip, [0, 0, ""])
                t[0] += n
                t[1] += size
                t[2] = agent or t[2]
    return out


def nft(*args, check=True):
    return subprocess.run([NFT, *args], capture_output=True, text=True, check=check)


def ensure_table(blocks, now):
    """Creates the firewall table if it's missing (first run, or after a reboot wiped it),
    putting back any blocks that hadn't run out yet."""
    if nft("list", "table", "inet", TABLE, check=False).returncode == 0:
        return
    rules = f"""
table inet {TABLE} {{
    set block4 {{ type ipv4_addr; flags timeout; }}
    set block6 {{ type ipv6_addr; flags timeout; }}
    chain input {{
        type filter hook input priority -10; policy accept;
        tcp dport {{ 80, 443 }} ip saddr @block4 drop
        tcp dport {{ 80, 443 }} ip6 saddr @block6 drop
    }}
}}
"""
    subprocess.run([NFT, "-f", "-"], input=rules, text=True, check=True, capture_output=True)
    restored = [ip for ip, b in blocks.items() if b["until"] > now and block(ip, b["until"] - now)]
    log(f"created nftables table inet {TABLE}" + (f", restored {len(restored)} blocks" if restored else ""))


def block(ip, seconds):
    s = "block6" if ":" in ip else "block4"
    r = nft("add", "element", "inet", TABLE, s, f"{{ {ip} timeout {seconds}s }}", check=False)
    return r.returncode == 0


def blocked_now():
    out = []
    for s in ("block4", "block6"):
        r = nft("list", "set", "inet", TABLE, s, check=False)
        out += re.findall(r"([0-9a-fA-F.:]+) timeout \S+ expires (\S+)", r.stdout)
    return out


def run():
    now = int(time.time())
    state = load_state()
    tally(state, read_new_lines(state), now)
    blocks = state["blocks"]
    ensure_table(blocks, now)
    nets = never_block()
    for ip in [ip for ip, t in blocks.items() if now - t["at"] > REPEAT_WITHIN + REPEAT_BLOCK]:
        del blocks[ip]

    by_requests = totals(state, now, REQUEST_WINDOW)
    by_bytes = totals(state, now, BYTE_WINDOW)
    for ip in set(by_requests) | set(by_bytes):
        n = by_requests.get(ip, [0, 0, ""])[0]
        size, agent = by_bytes.get(ip, [0, 0, ""])[1:]
        if n <= MAX_REQUESTS and size <= MAX_BYTES:
            continue
        prev = blocks.get(ip)
        if prev and now < prev["until"]:
            continue  # already blocked; its last lines are still being counted
        if exempt(ip, nets):
            continue
        repeat = prev is not None and now - prev["at"] < REPEAT_WITHIN + FIRST_BLOCK
        seconds = REPEAT_BLOCK if repeat else FIRST_BLOCK
        why = f"{n} requests in {REQUEST_WINDOW // 60} min" if n > MAX_REQUESTS else f"{size / 1024 ** 2:.0f} MB in {BYTE_WINDOW // 60} min"
        if block(ip, seconds):
            blocks[ip] = {"at": now, "until": now + seconds}
            msg = f"blocked {ip} for {seconds // 3600} h: {why} ({agent or 'no user agent'})"
            log(msg)
            subprocess.run(["logger", "-t", "web-guard", msg], check=False)
        else:
            log(f"could not block {ip}")
    save_state(state)


def report():
    now = int(time.time())
    state = load_state()
    tally(state, read_new_lines(state), now)
    save_state(state)
    hour = totals(state, now, BYTE_WINDOW)
    five = totals(state, now, REQUEST_WINDOW)
    print(f"Busiest IPs, last hour (blocks at {MAX_REQUESTS} requests in {REQUEST_WINDOW // 60} min or {MAX_BYTES // 1024 ** 2} MB in an hour):")
    print(f"  {'IP':<40} {'req/hr':>7} {'req/5m':>7} {'MB/hr':>7}  user agent")
    for ip, (n, size, agent) in sorted(hour.items(), key=lambda kv: -kv[1][1])[:15]:
        print(f"  {ip:<40} {n:>7} {five.get(ip, [0])[0]:>7} {size / 1024 ** 2:>7.1f}  {agent[:60]}")
    now_blocked = blocked_now()
    print(f"\nBlocked now: {len(now_blocked)}")
    for ip, expires in now_blocked:
        print(f"  {ip}  (lifts in {expires})")


def unblock(ip):
    s = "block6" if ":" in ip else "block4"
    r = nft("delete", "element", "inet", TABLE, s, f"{{ {ip} }}", check=False)
    state = load_state()
    state["blocks"].pop(ip, None)
    save_state(state)
    print(f"unblocked {ip}" if r.returncode == 0 else f"{ip} wasn't blocked")


if __name__ == "__main__":
    args = sys.argv[1:]
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    lock = open(STATE + ".lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX)  # one run at a time: cron and a manual report share the state
    if args == ["report"]:
        report()
    elif len(args) == 2 and args[0] == "unblock":
        unblock(args[1])
    elif not args:
        run()
    else:
        sys.exit(__doc__)
