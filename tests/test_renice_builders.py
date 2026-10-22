import importlib.machinery
import importlib.util
import os
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader("renice_builders", str(ROOT / "agent" / "bin" / "renice-builders"))
spec = importlib.util.spec_from_loader("renice_builders", loader)
rb = importlib.util.module_from_spec(spec)
loader.exec_module(rb)

LISTING = """\
  101   0 /usr/local/share/dotnet/sdk/10.0.401/Roslyn/bincore/VBCSCompiler -pipename:abc
  102  10 /usr/local/share/dotnet/sdk/10.0.401/Roslyn/bincore/VBCSCompiler -pipename:def
  103   0 /usr/local/share/dotnet/dotnet /usr/local/share/dotnet/sdk/10.0.401/MSBuild.dll /noautoresponse /nologo /nodemode:1 /nodeReuse:true
  104   0 dotnet run --project Api/App.csproj
  105   0 /usr/local/share/dotnet/dotnet /usr/local/share/dotnet/sdk/10.0.401/MSBuild.dll build.proj
  106   5 /usr/local/share/dotnet/sdk/10.0.401/Roslyn/bincore/VBCSCompiler -pipename:ghi
  107  15 /usr/local/share/dotnet/sdk/10.0.401/Roslyn/bincore/VBCSCompiler -pipename:jkl
garbage line
"""


class ReniceBuildersTests(unittest.TestCase):
    def test_candidates_select_only_build_servers_below_target(self):
        self.assertEqual(list(rb.candidates(LISTING)), [(101, 0), (103, 0), (106, 5)])

    def test_main_lowers_priority_and_never_raises(self):
        calls = []
        fake_run = lambda *a, **k: SimpleNamespace(stdout=LISTING)
        rb.main(run=fake_run, setpriority=lambda which, pid, n: calls.append((pid, n)))
        self.assertEqual(calls, [(101, 10), (103, 10), (106, 10)])
        self.assertNotIn(107, [pid for pid, _ in calls])

    def test_failures_are_tolerated(self):
        def failing_run(*a, **k):
            raise subprocess.TimeoutExpired("ps", 5)
        self.assertEqual(rb.main(run=failing_run, setpriority=lambda *a: None), 0)

        def denied(which, pid, n):
            raise PermissionError("not ours")
        self.assertEqual(rb.main(run=lambda *a, **k: SimpleNamespace(stdout=LISTING), setpriority=denied), 0)

    def test_real_process_is_lowered(self):
        proc = subprocess.Popen(["sleep", "30"])
        try:
            listing = f"{proc.pid} 0 /tmp/x/VBCSCompiler -pipename:test\n"
            rb.main(run=lambda *a, **k: SimpleNamespace(stdout=listing))
            self.assertEqual(os.getpriority(os.PRIO_PROCESS, proc.pid), 10)
        finally:
            proc.kill()
            proc.wait()


if __name__ == "__main__":
    unittest.main()
