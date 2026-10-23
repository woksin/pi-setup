import importlib.machinery, importlib.util, json, os, subprocess, tempfile, time, unittest
from datetime import datetime, timezone

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "session-watchdog")
loader = importlib.machinery.SourceFileLoader("session_watchdog", P)
sw = importlib.util.module_from_spec(importlib.util.spec_from_loader("session_watchdog", loader))
loader.exec_module(sw)

NOW = 1_800_000_000.0


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")


def msg(i, t, role, content, **kw):
    m = {"role": role, "content": content}
    m.update(kw)
    return {"type": "message", "id": i, "timestamp": iso(t), "message": m}


def call(cid, name="bash", **args):
    return {"type": "toolCall", "id": cid, "name": name, "arguments": args}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sessions = os.path.join(self.tmp.name, "sessions")
        self.msgs = os.path.join(self.tmp.name, "msgs")
        os.makedirs(self.msgs)
        self.hb = os.path.join(self.tmp.name, "hb")
        sw.STATE_DIR = os.path.join(self.tmp.name, "state")
        sw.LOG = os.path.join(self.tmp.name, "log")
        self.cwd = "/work/repo"
        self.dir = sw.session_dir_for(self.cwd, self.sessions)
        os.makedirs(self.dir)

    def write(self, records, name="s1", mtime=NOW - 5, sid="sid-1", pid=100, hb=True):
        head = [{"type": "session", "id": sid, "cwd": self.cwd}, {"type": "session_info", "id": "x", "name": "worker#1"}]
        p = os.path.join(self.dir, f"2026-01-01T00-00-00Z_{sid}.jsonl")
        if hb:
            self.heartbeat(sid, pid)
        with open(p, "w") as f:
            for r in head + records:
                f.write(json.dumps(r) + "\n")
        os.utime(p, (mtime, mtime))
        return p

    def heartbeat(self, sid, pid, age=0):
        os.makedirs(self.hb, exist_ok=True)
        p = os.path.join(self.hb, f"p{pid}.json")
        with open(p, "w") as f:
            json.dump({"id": f"S-p{pid}", "pid": pid, "sessionId": sid}, f)
        os.utime(p, (NOW - age, NOW - age))

    def procs(self, *pids, start=NOW - 99999):
        return {pid: (self.cwd, start) for pid in pids}

    def run_wd(self, now=NOW, **kw):
        kw.setdefault("swap", (0, 9999))
        kw.setdefault("level", 80)
        kw.setdefault("fsevents_mb", 0)
        kw.setdefault('procs', self.procs(100))
        return sw.run(now=now, hb_dir=self.hb, messages_dir=self.msgs, sessions=self.sessions, **kw)

    def files(self):
        return sorted(os.listdir(self.msgs))

    def patch_notify(self):
        calls = []
        orig = sw.notify
        sw.notify = lambda *a, **k: calls.append(a)
        self.addCleanup(setattr, sw, "notify", orig)
        return calls


class Analyse(Base):
    def test_hanging_tool_call_notifies_once(self):
        calls = self.patch_notify()
        self.write([msg("a", NOW - 700, "assistant", [call("c1", command="sleep 9999")], stopReason="toolUse")])
        self.assertEqual(len(self.run_wd()), 1)
        self.assertEqual(len(self.run_wd(now=NOW + 120)), 0)   # same record: not re-notified
        self.assertEqual(len(calls), 1)
        self.assertIn("sleep 9999", calls[0][2])
        self.assertIn("sid-1", calls[0][2])
        self.assertIn("worker#1", calls[0][2])
        self.heartbeat('sid-1', 100, age=-3700)  # heartbeat stays fresh
        self.assertEqual(len(self.run_wd(now=NOW + 3700)), 1)  # re-notify after 60 min

    def test_message_file_and_name(self):
        self.write([msg("a", NOW - 700, "assistant", [call("c1", command="x")], stopReason="toolUse")])
        self.run_wd()
        (f,) = self.files()
        self.assertRegex(f, r"^ALL-session-watchdog-\d{4}-stuck\.md$")

    def test_young_tool_call_not_stuck(self):
        self.write([msg("a", NOW - 500, "assistant", [call("c1", command="x")], stopReason="toolUse")])
        self.assertEqual(self.run_wd(), [])

    def test_answered_tool_call_not_stuck(self):
        self.write([msg("a", NOW - 900, "assistant", [call("c1")], stopReason="toolUse"),
                    msg("b", NOW - 899, "toolResult", [{"type": "text", "text": "ok"}], toolCallId="c1")])
        # last record is a result with no reply but only 899 s old -> case (b) applies at >600
        self.assertEqual(len(self.run_wd()), 1)
        self.assertEqual(self.run_wd(now=NOW - 400), [])

    def test_idle_assistant_not_stuck(self):
        self.write([msg("a", NOW - 5000, "assistant", [{"type": "text", "text": "done"}], stopReason="stop")])
        self.assertEqual(self.run_wd(), [])

    def test_user_message_without_reply_stuck(self):
        self.write([msg("a", NOW - 700, "user", [{"type": "text", "text": "hi"}])])
        self.assertEqual(len(self.run_wd()), 1)

    def test_parallel_calls_one_pending(self):
        info = sw.analyse(self.write([msg("a", NOW - 800, "assistant", [call("c1"), call("c2", command="slow")], stopReason="toolUse"),
                                      msg("b", NOW - 799, "toolResult", [], toolCallId="c1")]))
        self.assertEqual((info["kind"], info["record_id"]), ("tool", "c2"))

    def test_bash_timeout_exceeded_is_stuck(self):
        self.write([msg("a", NOW - 1400, "assistant", [call("c1", command="x", timeout=1200)], stopReason="toolUse")])
        self.assertEqual(len(self.run_wd()), 1)  # 1400 > 1200 + 120

    def test_bash_timeout_not_yet(self):
        self.write([msg("a", NOW - 1300, "assistant", [call("c1", command="x", timeout=1200)], stopReason="toolUse")])
        self.assertEqual(self.run_wd(), [])
        self.assertEqual(len(self.run_wd(now=NOW + 100)), 1)

    def test_large_tail_record(self):
        big = "x" * 400_000
        self.write([msg("a", NOW - 900, "assistant", [call("c1", command="x")], stopReason="toolUse"),
                    msg("b", NOW - 800, "toolResult", [{"type": "text", "text": big}], toolCallId="c1")])
        self.assertEqual(len(self.run_wd()), 1)

    def test_dead_session_ignored(self):
        self.write([msg("a", NOW - 900, "assistant", [call("c1")], stopReason="toolUse")])
        self.assertEqual(sw.run(now=NOW, procs={}, hb_dir=self.hb, messages_dir=self.msgs, sessions=self.sessions, swap=(0, 9999), level=80, fsevents_mb=0), [])

    def test_old_file_ignored(self):
        self.write([msg("a", NOW - 900, "assistant", [call("c1")], stopReason="toolUse")], mtime=NOW - 90000, hb=False)
        self.assertEqual(self.run_wd(procs=self.procs(100, start=NOW - 99999)), [])

    def test_dry_run_does_not_notify_or_save(self):
        self.write([msg("a", NOW - 900, "assistant", [call("c1")], stopReason="toolUse")])
        self.run_wd(dry_run=True)
        self.assertEqual(self.files(), [])
        self.assertFalse(os.path.exists(os.path.join(sw.STATE_DIR, "state.json")))


class Mapping(Base):
    def stuck_rec(self):
        return [msg("a", NOW - 900, "assistant", [call("c1", command="hang")], stopReason="toolUse")]

    def test_live_idle_plus_newer_dead_stuck_gives_no_all_notice(self):
        calls = self.patch_notify()
        self.write([msg("a", NOW - 5000, "assistant", [{"type": "text", "text": "d"}], stopReason="stop")], sid="live", pid=100, mtime=NOW - 3000)
        self.write(self.stuck_rec(), sid="dead", pid=999, hb=False, mtime=NOW - 100)  # newer, no process, no heartbeat
        self.run_wd()
        self.assertEqual(calls, [])  # the live process is mapped, so nothing is ambiguous either

    def test_heartbeat_mapped_stuck_gives_all_notice(self):
        calls = self.patch_notify()
        self.write(self.stuck_rec())
        self.run_wd()
        self.assertEqual([c[0] for c in calls], ["stuck"])

    def test_heartbeat_older_than_the_process_is_not_a_mapping(self):
        calls = self.patch_notify()
        self.write([msg("a", NOW - 700, "assistant", [call("c1", command="sleep 9999")], stopReason="toolUse")], hb=False)
        self.heartbeat("sid-1", 100, age=200)                  # fresh, but written before pid 100 started
        self.run_wd(procs=self.procs(100, start=NOW - 60))
        self.assertFalse([f for f in self.files() if f.startswith("ALL-")])

    def test_stale_heartbeat_or_dead_pid_is_not_a_mapping(self):
        calls = self.patch_notify()
        self.write(self.stuck_rec(), hb=False)
        self.heartbeat("sid-1", 100, age=400)                 # stale heartbeat
        self.run_wd(procs=self.procs(100, start=NOW + 10))     # (process younger than the log: not a candidate)
        self.heartbeat("sid-1", 555)                           # fresh heartbeat, pid not alive
        self.run_wd(procs=self.procs(100, start=NOW + 10))
        self.assertEqual(calls, [])

    def test_unmapped_ambiguous_goes_to_l0_only(self):
        self.write(self.stuck_rec(), hb=False, mtime=NOW - 100)
        self.run_wd(procs=self.procs(100, start=NOW - 5000))
        (f,) = self.files()
        self.assertRegex(f, r"^PISETUP-to-L0-session-watchdog-\d{4}-possibly-stuck\.md$")
        with open(os.path.join(self.msgs, f)) as fh:
            self.assertIn("unconfirmed: session not positively mapped to a live process", fh.read())

    def test_unmapped_file_older_than_youngest_process_is_ignored(self):
        calls = self.patch_notify()
        self.write(self.stuck_rec(), hb=False, mtime=NOW - 100)
        self.run_wd(procs=self.procs(100, start=NOW - 50))
        self.assertEqual(calls, [])


class QueueWait(Base):
    def phase_state(self, pid, status="waiters"):
        d = os.path.join(self.tmp.name, "phase")
        if status == "waiters":
            os.makedirs(os.path.join(d, "waiters"), exist_ok=True)
            p = os.path.join(d, "waiters", "w1.json")
        else:
            os.makedirs(d, exist_ok=True)
            p = os.path.join(d, "heavy-0.json")
        with open(p, "w") as f:
            json.dump({"pid": pid, "label": "i42 gate", "cwd": self.cwd, "enqueued": NOW - 400, "started": NOW - 400, "rank": 2}, f)
        return d

    def batch(self):
        cmd = "~/.pi/agent/bin/pi-phase run --kind test --label 'i42 gate' -- make"
        return self.write([msg("a", NOW - 1400, "assistant", [call("c1"), call("c2", command=cmd)], stopReason="toolUse"),
                           msg("b", NOW - 1399, "toolResult", [], toolCallId="c1")])

    def dead_pid(self):
        p = subprocess.Popen(["true"])
        p.wait()
        return p.pid

    def test_live_queued_phase_is_waiting_not_stuck(self):
        self.batch()
        me = os.getpid()
        for kind in ("waiters", "heavy"):
            self.assertEqual(self.run_wd(phase_state=self.phase_state(me, kind), ppids={me: 99, 99: 100}, inject_ttys={}), [])
            self.assertEqual(self.files(), [])
            with open(os.path.join(sw.STATE_DIR, "board.json")) as f:
                row = json.load(f)["sessions"][0]
            self.assertEqual(row["state"], "waiting")
            self.assertIn("i42 gate", row["queue"])
            self.assertIn("rank 2", row["queue"])
            self.assertIn("6m40s", row["queue"])

    def test_label_cwd_fallback_without_ancestry(self):
        self.batch()
        self.assertEqual(self.run_wd(phase_state=self.phase_state(os.getpid()), ppids={}, inject_ttys={}), [])

    def test_dead_waiter_leaves_stuck_logic_unchanged(self):
        self.batch()
        self.assertEqual(len(self.run_wd(phase_state=self.phase_state(self.dead_pid()), ppids={}, inject_ttys={})), 1)

    def test_unrelated_live_waiter_does_not_hide_stuck(self):
        self.batch()
        d = self.phase_state(os.getpid())
        with open(os.path.join(d, "waiters", "w1.json"), "w") as f:
            json.dump({"pid": os.getpid(), "label": "other", "cwd": "/elsewhere", "enqueued": NOW - 5}, f)
        self.assertEqual(len(self.run_wd(phase_state=d, ppids={}, inject_ttys={})), 1)


class Alarms(Base):
    def test_all_silent(self):
        calls = self.patch_notify()
        for i in range(3):
            self.write([msg("a", NOW - 2000, "assistant", [{"type": "text", "text": "d"}], stopReason="stop")],
                       mtime=NOW - 1000, sid=f"s{i}", pid=100 + i)
        sw.run(now=NOW, procs=self.procs(100, 101, 102), hb_dir=self.hb, messages_dir=self.msgs, sessions=self.sessions, swap=(0, 9999), level=80, fsevents_mb=0)
        sw.run(now=NOW + 120, procs=self.procs(100, 101, 102), hb_dir=self.hb, messages_dir=self.msgs, sessions=self.sessions, swap=(0, 9999), level=80, fsevents_mb=0)
        self.assertEqual([c[0] for c in calls], ["silent"])

    def test_not_silent_with_fresh_session_or_few_sessions(self):
        calls = self.patch_notify()
        for i in range(3):
            self.write([], mtime=NOW - (1000 if i else 10), sid=f"s{i}", pid=100 + i)
        sw.run(now=NOW, procs=self.procs(100, 101, 102), hb_dir=self.hb, messages_dir=self.msgs, sessions=self.sessions, swap=(0, 9999), level=80, fsevents_mb=0)
        sw.run(now=NOW, procs=self.procs(100, 101), hb_dir=self.hb, messages_dir=self.msgs, sessions=self.sessions, swap=(0, 9999), level=80, fsevents_mb=0)
        self.assertEqual(calls, [])

    def test_memory_notices(self):
        calls = self.patch_notify()
        self.run_wd(swap=(13000, 5000), level=14, fsevents_mb=5000)        # low level + swap used > 12 GB
        self.run_wd(swap=(8000, 1000), level=7, fsevents_mb=0, now=NOW + 4000)   # critical level alone
        self.run_wd(swap=(8000, 5000), level=50, fsevents_mb=100, now=NOW + 8000)  # healthy
        self.assertEqual([c[0] for c in calls], ["memory", "fseventsd", "memory"])
        self.assertIn("sudo killall fseventsd", calls[1][2])

    def test_low_free_swap_alone_is_not_pressure(self):
        calls = self.patch_notify()
        self.run_wd(swap=(8000, 1200), level=72)    # the 2026-10-22 21:10 false alarm
        self.run_wd(swap=(13000, 1200), level=40, now=NOW + 4000)
        self.run_wd(swap=(8000, 1200), level=10, now=NOW + 8000)  # low level but swap used <= 12 GB
        self.assertEqual(calls, [])
        self.assertFalse(sw.memory_pressure(None, 99999))

    def test_no_memory_flag_skips_memory_notices(self):
        calls = self.patch_notify()
        self.run_wd(no_memory=True, swap=(13000, 100), level=1, fsevents_mb=9000)
        self.assertEqual(calls, [])

    def test_message_prefixes(self):
        for suffix, prefix in (("stuck", "ALL"), ("memory", "PISETUP-to-L0"), ("silent", "PISETUP-to-L0"), ("fseventsd", "PISETUP-to-L0")):
            sw.notify(suffix, "t", "text", self.msgs, False)
            self.assertTrue(any(f.startswith(f"{prefix}-session-watchdog-") and f.endswith(f"-{suffix}.md") for f in self.files()), suffix)


class Board(Base):
    def board(self, **kw):
        self.run_wd(inject_ttys={100: "ttys001", 200: "ttys002"}, **kw)
        with open(os.path.join(sw.STATE_DIR, "board.json")) as f:
            return {r["pid"]: r for r in json.load(f)["sessions"]}

    def test_idle_working_stuck_and_unmapped_rows(self):
        os.environ["LANE_STATUS_DIR"] = os.path.join(self.tmp.name, "lanes")
        self.addCleanup(os.environ.pop, "LANE_STATUS_DIR")
        os.makedirs(os.environ["LANE_STATUS_DIR"])
        with open(os.path.join(os.environ["LANE_STATUS_DIR"], "WORKER.status"), "w") as f:
            f.write('waiting-on "x" until 2999-01-01T00:00:00Z\n')
        sw_name = [{"type": "session_info", "id": "y", "name": "WORKER"}]
        self.write(sw_name + [msg("a", NOW - 100, "user", "hi"), msg("b", NOW - 90, "assistant", [{"type": "text", "text": "ok"}], stopReason="stop")])
        rows = self.board(procs={100: (self.cwd, NOW - 99999), 200: ("/other", NOW - 99999)})
        self.assertEqual(rows[100]["state"], "idle")
        self.assertEqual(rows[100]["tty"], "ttys001")
        self.assertEqual(rows[100]["session_id"], "sid-1")
        self.assertEqual(rows[100]["session_name"], "WORKER")
        self.assertEqual(rows[100]["last_turn_end"], sw.iso_or_dash(NOW - 90))
        self.assertEqual(rows[100]["last_record"], sw.iso_or_dash(NOW - 90))
        self.assertEqual(rows[100]["lane"], "WORKER")
        self.assertIn("waiting-on", rows[100]["lane_status"])
        self.assertEqual((rows[200]["state"], rows[200]["session_id"]), ("unmapped", "unmapped"))
        self.assertIn("| unmapped |", open(os.path.join(sw.STATE_DIR, "board.md")).read())
        self.assertEqual([f for f in os.listdir(sw.STATE_DIR) if ".tmp." in f], [])
        self.write([msg("a", NOW - 30, "assistant", [call("c1", command="sleep 1")], stopReason="toolUse")])
        self.assertEqual(self.board(procs=self.procs(100))[100]["state"], "working")
        self.write([msg("a", NOW - 3000, "assistant", [call("c1", command="sleep 1")], stopReason="toolUse")])
        r = self.board(procs=self.procs(100))[100]
        self.assertEqual((r["state"], r["lane"], r["last_turn_end"]), ("stuck", None, "-"))

    def test_dry_run_writes_no_board(self):
        self.write([msg("a", NOW - 90, "assistant", [{"type": "text", "text": "ok"}], stopReason="stop")])
        self.run_wd(dry_run=True, inject_ttys={})
        self.assertFalse(os.path.exists(os.path.join(sw.STATE_DIR, "board.json")))

    def test_lane_for_name_prefix(self):
        d = self.tmp.name
        with open(os.path.join(d, "AB-1.status"), "w") as f:
            f.write("working since x\n")
        self.assertEqual(sw.lane_for("AB-1 worker", d), ("AB-1", "working since x"))
        self.assertEqual(sw.lane_for("worker#1", d), (None, None))
        self.assertEqual(sw.lane_for(None, d), (None, None))

    def test_lane_for_bad_status_files_never_break_the_pass(self):
        d = self.tmp.name
        with open(os.path.join(d, "CD.status"), "wb") as f:
            f.write(b"\xff\xfe waiting" + b"x" * 100000)  # invalid UTF-8, no newline, oversized
        lane, line = sw.lane_for("CD", d)
        self.assertEqual(lane, "CD")
        self.assertLessEqual(len(line), 512)
        os.mkfifo(os.path.join(d, "EF.status"))
        self.assertEqual(sw.lane_for("EF", d), (None, None))  # FIFO is skipped, not opened


if __name__ == "__main__":
    unittest.main()
