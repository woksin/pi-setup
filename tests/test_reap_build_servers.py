import importlib.machinery
import importlib.util
import json
import signal
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader("reap_build_servers", str(ROOT / "agent" / "bin" / "reap-build-servers"))
spec = importlib.util.spec_from_loader("reap_build_servers", loader)
rb = importlib.util.module_from_spec(spec)
loader.exec_module(rb)

SDK = "/usr/local/share/dotnet/sdk/10.0.401/Roslyn/bincore/VBCSCompiler"
SETTINGS = dict(mode="enforce", idle_s=600, min_age_s=900, max_cpu_ms_per_min=200)
START = time.mktime(time.strptime("Mon Oct 26 08:00:00 2026", "%a %b %d %H:%M:%S %Y"))
LSTART = "Mon Oct 26 08:00:00 2026"
UID = 501


def row(pid=100, ppid=1, uid=UID, cpu="0:10.00", rss=204800, command=SDK + " -pipename:abc", lstart=LSTART):
    return f"{pid} {ppid} {uid} {lstart} {cpu} {rss} {command}"


class Harness:
    def __init__(self, test, listing, settings=SETTINGS):
        self.listing, self.settings, self.kills, self.now = listing, settings, [], START + 1000
        self.dir = tempfile.TemporaryDirectory()
        test.addCleanup(self.dir.cleanup)
        self.calls = []

    def run(self, command, **_):
        self.calls.append(command)
        text = self.listing if "-p" not in command else "\n".join(
            line for line in self.listing.splitlines() if line.split()[0] == command[command.index("-p") + 1])
        return SimpleNamespace(stdout=text)

    def pass_(self, at=None):
        if at is not None:
            self.now = START + at
        import io
        from contextlib import redirect_stdout
        out = io.StringIO()
        with redirect_stdout(out):
            rb.main(run=self.run, kill=lambda pid, sig: self.kills.append((pid, sig)), clock=lambda: self.now,
                    settings=self.settings, state_dir=self.dir.name, uid=UID)
        return out.getvalue()


class ReapBuildServersTests(unittest.TestCase):
    def idle_for_window(self, listing, settings=SETTINGS):
        h = Harness(self, listing, settings)
        self.assertEqual(h.pass_(1000), "")           # first sight starts the idle timer
        out = h.pass_(1000 + 300)
        self.assertEqual(out, "")
        return h, h.pass_(1000 + 700)

    def test_idle_server_is_sigtermed_only_in_enforce(self):
        h, out = self.idle_for_window(row())
        self.assertIn("reaped pid=100 rss=200MB idle=700s", out)
        self.assertEqual(h.kills, [(100, signal.SIGTERM)])
        h, out = self.idle_for_window(row(), dict(SETTINGS, mode="observe"))
        self.assertIn("would reap pid=100", out)
        self.assertEqual(h.kills, [])
        h, out = self.idle_for_window(row(), dict(mode="off"))
        self.assertEqual((out, h.kills), ("", []))

    def never(self, listing):
        h, out = self.idle_for_window(listing)
        self.assertEqual((out, h.kills), ("", []))

    def test_never_cases(self):
        self.never(row(uid=502))
        self.never(row(ppid=4242))
        self.never(row(command="/opt/other/VBCSCompiler -pipename:abc"))
        self.never(row(command=SDK + " -pipename:pi-phase-abcdef"))
        self.never(row(command="/usr/local/share/dotnet/sdk/10/MSBuild.dll /nodemode:1 /nodeReuse:false"))
        self.never(row(command="dotnet run --project App.csproj"))

    def test_too_young_is_never_reaped(self):
        h = Harness(self, row(lstart="Mon Oct 26 08:14:00 2026"))
        for at in (1000, 1300, 1700):
            h.pass_(at)
        self.assertEqual(h.kills, [])

    def test_cpu_activity_resets_the_idle_timer(self):
        h = Harness(self, row(cpu="0:10.00"))
        h.pass_(1000)
        h.listing = row(cpu="0:30.00")                   # a compile burnt 20 s
        h.pass_(1500)
        h.listing = row(cpu="0:30.01")
        self.assertEqual(h.pass_(1700), "")              # only 200 s idle since the busy pass
        self.assertEqual(h.kills, [])
        h.listing = row(cpu="0:30.02")
        self.assertIn("reaped", h.pass_(1500 + 650))

    def test_pid_reuse_resets(self):
        h = Harness(self, row())
        h.pass_(1000)
        h.pass_(1300)
        h.listing = row(lstart="Mon Oct 26 08:16:00 2026")  # same pid, new process
        self.assertEqual(h.pass_(1800), "")
        self.assertEqual(h.kills, [])

    def test_busy_at_recheck_is_never_signalled(self):
        h = Harness(self, row())
        h.pass_(1000)
        h.pass_(1300)
        original = h.run

        def busy_on_recheck(command, **kw):
            if "-p" in command:
                return SimpleNamespace(stdout=row(cpu="0:40.00"))
            return original(command, **kw)
        h.run = busy_on_recheck
        self.assertEqual(h.pass_(1700), "")
        self.assertEqual(h.kills, [])

    def test_recheck_with_changed_start_time_is_not_signalled(self):
        h = Harness(self, row())
        h.pass_(1000)
        h.pass_(1300)
        original = h.run
        h.run = lambda command, **kw: (SimpleNamespace(stdout=row(lstart="Mon Oct 26 09:00:00 2026"))
                                       if "-p" in command else original(command, **kw))
        self.assertEqual(h.pass_(1700), "")
        self.assertEqual(h.kills, [])

    def test_corrupt_state_is_reset(self):
        h = Harness(self, row())
        (Path(h.dir.name) / "reaper.json").write_text("{not json")
        self.assertEqual(h.pass_(1000), "")
        self.assertIn("100", json.loads((Path(h.dir.name) / "reaper.json").read_text()))

    def last(self, h):
        return json.loads((Path(h.dir.name) / "reaper-last.json").read_text())

    def test_reaper_last_records_each_pass_for_attribution(self):
        h = Harness(self, row(), dict(SETTINGS, mode="observe"))
        h.pass_(1000)
        h.pass_(1300)
        self.assertEqual(self.last(h), dict(v=1, at=int(START + 1300), mode="observe", candidates=1, due=0, acted=0))
        h.pass_(1700)
        self.assertEqual(self.last(h), dict(v=1, at=int(START + 1700), mode="observe", candidates=1, due=1, acted=0))
        h = Harness(self, row())
        for at in (1000, 1300, 1700):
            h.pass_(at)
        self.assertEqual(self.last(h)["acted"], 1)
        self.assertEqual((self.last(h)["mode"], self.last(h)["due"]), ("enforce", 1))
        h = Harness(self, row(), dict(mode="off"))
        h.pass_(1000)
        self.assertFalse((Path(h.dir.name) / "reaper-last.json").exists())

    def test_reaper_last_write_failure_still_exits_zero(self):
        h = Harness(self, row(), dict(SETTINGS, mode="observe"))
        (Path(h.dir.name) / "reaper-last.json").mkdir()  # os.replace onto a directory fails
        self.assertEqual(h.pass_(1000), "")

    def test_one_ps_listing_per_pass_and_exit_zero(self):
        h = Harness(self, row())
        h.pass_(1000)
        self.assertEqual(len(h.calls), 1)
        self.assertEqual(rb.main(run=lambda *a, **k: (_ for _ in ()).throw(OSError()), settings=SETTINGS,
                                 state_dir=h.dir.name), 0)


if __name__ == "__main__":
    unittest.main()
