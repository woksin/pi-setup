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

    def test_new_workers_below_target_and_outside_phase_are_selected(self):
        listing = """\
  201 0 1 dotnet exec /sdk/MSBuild.dll /nologo
  202 5 1 dotnet exec /sdk/testhost.dll --port 123
  203 0 1 /sdk/vstest.console.exe test.dll
  204 10 1 /sdk/testhost --port 123
  205 15 1 dotnet exec /sdk/MSBuild.dll
  206 0 1 echo testhost vstest.console MSBuild.dll
  207 0 1 grep testhost file
  208 0 1 dotnet run --project testhost.csproj
  209 0 1 dotnet exec /sdk/vstest.console.dll test.dll
  210 0 1 dotnet exec --runtimeconfig /sdk/testhost.runtimeconfig.json --depsfile /sdk/testhost.deps.json /sdk/testhost.dll
  211 0 1 dotnet exec echo.dll /sdk/testhost.dll
  212 0 0 /sdk/testhost
"""
        self.assertEqual(list(rb.candidates(listing)), [(201, 0), (202, 5), (203, 0), (209, 0), (210, 0), (212, 0)])

    def test_new_workers_under_phase_ancestor_are_left_alone(self):
        listing = """\
  301 0 1 python3 /home/me/.pi/agent/bin/pi-phase run --kind test -- dotnet test
  302 0 301 dotnet test
  303 0 302 dotnet exec /sdk/testhost.dll
  304 0 302 dotnet exec /sdk/MSBuild.dll
  305 0 302 /sdk/vstest.console
  306 0 302 /sdk/VBCSCompiler -pipename:shared
  307 0 1 /sdk/testhost
"""
        self.assertEqual(list(rb.candidates(listing)), [(306, 0), (307, 0)])

    def test_framework_and_python3_phase_ancestors_with_ps_labels(self):
        for python in ("/opt/homebrew/Cellar/python@3.x/Frameworks/Python.framework/Versions/3.x/Resources/Python.app/Contents/MacOS/Python",
                       "python3"):
            for label in ('"it\'s"', "it's"):
                with self.subTest(python=python, label=label):
                    args = f"{python} /Users/x/.pi/agent/pi-phase/pi_phase.py run --kind test --label {label} -- dotnet test"
                    self.assertTrue(rb.is_phase(args))
                    listing = f"301 0 1 {args}\n302 0 301 dotnet test\n303 0 302 dotnet exec /sdk/testhost.dll\n"
                    self.assertEqual(list(rb.candidates(listing)), [])

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
