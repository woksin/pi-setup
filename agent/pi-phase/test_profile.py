"""--profile iterate|full (#81 step 10): argument injection, ledger record and gate-key separation."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import unittest.mock

import pi_phase

# A stand-in `dotnet` that behaves like a build with an analyzer warning treated as an error unless
# the analyzers are switched off through the injected arguments.
STUB = """#!/bin/sh
printf '%s\\n' "$@" > "$SEEN"
for argument in "$@"; do
  if [ "$argument" = "-p:RunAnalyzers=false" ]; then exit 0; fi
done
echo "Program.cs(1,1): error CA1822: Member can be static [Test.csproj]"
exit 1
"""


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(os.path.realpath(self.tmp.name))
        self.stub = self.root / "dotnet"
        self.stub.write_text(STUB)
        self.stub.chmod(0o700)
        self.seen = self.root / "seen"
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps(dict(heavy_slots=1, integration_slots=1, container_test_detection="off",
                                               cold_worktree_hint=False, msbuild_max_cpu=0, phase_nice=0)))
        self.state = self.root / "state"
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)
        environment = dict(SEEN=str(self.seen))
        self.patch = unittest.mock.patch.dict(os.environ, environment)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def run_phase(self, *flags, kind="build", command=None):
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(io.StringIO()):
            code = pi_phase.main(["run", "--kind", kind, "--label", "profile", "--policy", "direct", "--rerun",
                                  "--timeout", "20", *flags, "--", *(command or [str(self.stub), "build", "X.csproj"])],
                                 state=self.state, configuration=self.config)
        return code, output.getvalue()

    def records(self):
        return [json.loads(line) for path in (self.state / "ledger").glob("*.jsonl")
                for line in path.read_text().splitlines()]

    def test_iterate_passes_while_the_same_full_build_fails_on_an_analyzer_warning(self):
        self.assertEqual(self.run_phase("--profile", "iterate")[0], 0)
        self.assertEqual(self.seen.read_text().split(),
                         ["build", "X.csproj", "-p:RunAnalyzers=false", "-p:EnforceCodeStyleInBuild=false"])
        self.assertEqual(self.run_phase()[0], 1)  # default is full
        self.assertEqual(self.seen.read_text().split(), ["build", "X.csproj"])
        self.assertEqual(self.run_phase("--profile", "full")[0], 1)
        self.assertEqual([r["profile"] for r in self.records()], ["iterate", "full", "full"])

    def test_injection_goes_before_the_runsettings_separator_and_respects_user_properties(self):
        self.assertEqual(pi_phase.apply_profile(["dotnet", "test", "--", "RunConfiguration.X=1"], "iterate", "test"),
                         ["dotnet", "test", "-p:RunAnalyzers=false", "-p:EnforceCodeStyleInBuild=false",
                          "--", "RunConfiguration.X=1"])
        self.assertEqual(pi_phase.apply_profile(["env", "A=1", "dotnet", "build", "-p:RunAnalyzers=true"], "iterate", "build"),
                         ["env", "A=1", "dotnet", "build", "-p:RunAnalyzers=true", "-p:EnforceCodeStyleInBuild=false"])

    def test_nothing_changes_for_full_ci_shells_and_other_tools(self):
        for command, kind, profile in ((["dotnet", "build"], "build", "full"), (["dotnet", "build"], "ci", "iterate"),
                                       (["bash", "-c", "dotnet build"], "build", "iterate"),
                                       (["dotnet", "run"], "build", "iterate"), (["yarn", "build"], "build", "iterate")):
            with self.subTest(command=command, kind=kind, profile=profile), redirect_stdout(io.StringIO()):
                self.assertEqual(pi_phase.apply_profile(command, profile, kind), command)

    def test_argv_hash_is_the_original_argv(self):
        self.run_phase("--profile", "iterate")
        import hashlib
        expected = hashlib.sha256(os.fsencode("\0".join([str(self.stub), "build", "X.csproj"]))).hexdigest()
        self.assertEqual(self.records()[0]["argvHash"], expected)


if __name__ == "__main__":
    unittest.main()
