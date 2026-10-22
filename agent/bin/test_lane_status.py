import contextlib, importlib.machinery, importlib.util, io, os, tempfile, time, unittest

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lane-status")
loader = importlib.machinery.SourceFileLoader("lane_status", P)
ls = importlib.util.module_from_spec(importlib.util.spec_from_loader("lane_status", loader))
loader.exec_module(ls)

NOW = 1_800_000_000.0


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.inbox = os.path.join(self.tmp.name, "inbox")
        os.makedirs(self.inbox)
        self.sd = os.path.join(self.tmp.name, "st")
        env = {"LANE_STATUS_DIR": self.sd, "INBOX_DIR": self.inbox}
        old = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        self.addCleanup(lambda: [os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v) for k, v in old.items()])

    def run_ls(self, *args, now=NOW):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = ls.main(list(args), now=now)
        return rc, out.getvalue(), err.getvalue()

    def test_default_dirs(self):
        del os.environ["LANE_STATUS_DIR"]
        self.assertEqual(ls.status_dir(), os.path.join(self.inbox, "status"))
        del os.environ["INBOX_DIR"]
        self.assertTrue(ls.status_dir().endswith(".pi/agent/lane-status"))

    def test_set_get_clear_suppressed(self):
        rc, out, _ = self.run_ls("set", "A1", "waiting-on", "PR #5", "--until", "+90m")
        self.assertEqual(rc, 0)
        self.assertEqual(ls.read_line("A1"), f'waiting-on "PR #5" until {ls.iso(NOW + 5400)}')
        self.assertEqual(self.run_ls("suppressed", "A1")[0], 0)
        self.assertEqual(self.run_ls("get", "A1")[0], 0)
        rc, out, _ = self.run_ls("suppressed", "A1", now=NOW + 6000)
        self.assertEqual((rc, out.strip()), (1, "expired"))
        self.assertIn("(expired)", self.run_ls("list", now=NOW + 6000)[1])
        self.run_ls("clear", "A1")
        self.assertEqual(self.run_ls("get", "A1")[0], 1)
        rc, out, _ = self.run_ls("suppressed", "A1")
        self.assertEqual((rc, out), (1, ""))
        self.assertEqual(self.run_ls("clear", "A1")[0], 0)

    def test_barred_iso_and_working(self):
        self.assertEqual(self.run_ls("set", "B", "barred-by", 'order "x"', "--until", "2027-01-01T00:00:00Z", now=1_700_000_000.0)[0], 0)
        self.assertEqual(ls.read_line("B"), "barred-by \"order 'x'\" until 2027-01-01T00:00:00Z")
        self.assertEqual(self.run_ls("suppressed", "B", now=1_700_000_000.0)[0], 0)
        self.run_ls("set", "B", "working")
        self.assertTrue(ls.read_line("B").startswith("working since "))
        self.assertEqual(self.run_ls("suppressed", "B")[0], 1)
        self.assertEqual(sorted(os.listdir(self.sd)), ["B.status"])  # no temp leftovers

    def test_validation(self):
        for bad in ("a", "1A", "A" * 17, "A_B", ""):
            self.assertEqual(self.run_ls("get", bad)[0], 2, bad)
        self.assertEqual(self.run_ls("set", "A", "waiting-on", "x")[0], 2)
        self.assertEqual(self.run_ls("set", "A", "waiting-on", "--until", "+1h")[0], 2)
        self.assertEqual(self.run_ls("set", "A", "waiting-on", "x", "--until", "soon")[0], 2)
        self.assertEqual(self.run_ls("set", "A", "working", "--until", "+1h")[0], 2)
        self.assertEqual(self.run_ls("close", "A", "--reassign-to", "A")[0], 2)
        self.assertEqual(self.run_ls("close", "A", "--reassign-to", "bad")[0], 2)
        self.assertFalse(os.path.exists(self.sd))

    def test_list(self):
        self.assertEqual(self.run_ls("list"), (0, "", ""))
        self.run_ls("set", "B", "working")
        self.run_ls("set", "A", "waiting-on", "d", "--until", "+1h")
        open(os.path.join(self.sd, "junk.status"), "w").close()
        lines = self.run_ls("list")[1].splitlines()
        self.assertEqual([l.split(":")[0] for l in lines], ["A", "B"])

    def touch(self, name, t, text="x"):
        p = os.path.join(self.inbox, name)
        with open(p, "w") as f:
            f.write(text)
        os.utime(p, (t, t))

    def test_close_posts_message_with_unread(self):
        self.touch("A1-inbox.marker", NOW - 100, "")
        self.touch("L0-to-A1-old.md", NOW - 200)
        self.touch("L0-to-A1-new.md", NOW - 50)
        self.touch("X-to-A1.md", NOW - 40)
        self.touch("L0-to-A10-other.md", NOW - 50)
        self.touch("L0-to-B-other.md", NOW - 50)
        before = sorted(os.listdir(self.inbox))
        rc, out, _ = self.run_ls("close", "A1", "--reassign-to", "B", "--reason", "done here")
        self.assertEqual(rc, 0)
        self.assertTrue(ls.read_line("A1").startswith("closed reassigned-to B at "))
        self.assertEqual(self.run_ls("suppressed", "A1")[0], 1)
        new = [f for f in os.listdir(self.inbox) if f not in before]
        self.assertEqual(len(new), 1)
        self.assertRegex(new[0], r"^ALL-lane-closed-A1-\d{4}\.md$")
        body = open(os.path.join(self.inbox, new[0])).read()
        self.assertIn("Reassigned to B", body)
        self.assertIn("- L0-to-A1-new.md", body)
        self.assertIn("- X-to-A1.md", body)
        for n in ("old", "A10", "to-B"):
            self.assertNotIn(n, body.split("Unread")[1])
        self.assertEqual(open(os.path.join(self.inbox, "L0-to-A1-new.md")).read(), "x")

    def test_close_no_marker_and_no_inbox(self):
        self.assertEqual(self.run_ls("close", "A1", "--reassign-to", "B")[0], 0)
        body = open(os.path.join(self.inbox, [f for f in os.listdir(self.inbox) if f.startswith("ALL-")][0])).read()
        self.assertIn("marker does not exist", body)
        del os.environ["INBOX_DIR"]
        rc, _, err = self.run_ls("close", "C1", "--reassign-to", "B")
        self.assertEqual(rc, 0)
        self.assertIn("INBOX_DIR not set", err)
        self.assertTrue(os.path.exists(os.path.join(self.sd, "C1.status")))

    def test_help(self):
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as c:
            ls.main(["--help"])
        self.assertEqual(c.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
