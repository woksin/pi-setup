import importlib.machinery, importlib.util, os, tempfile, unittest

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "disk-growth")
loader = importlib.machinery.SourceFileLoader("disk_growth", P)
dg = importlib.util.module_from_spec(importlib.util.spec_from_loader("disk_growth", loader))
loader.exec_module(dg)


class PostNotice(unittest.TestCase):
    def test_passive_broadcast_plus_l0_wake_and_no_all_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            dg.post_notice("disk is growing", [tmp], 1_800_000_000.0)
            names = sorted(os.listdir(tmp))
            self.assertEqual(len(names), 2, names)
            self.assertRegex(names[0], r"^BCAST-disk-growth-\d{4}\.md$")
            self.assertRegex(names[1], r"^PISETUP-to-L0-disk-growth-\d{4}\.md$")
            for name in names:
                with open(os.path.join(tmp, name)) as f:
                    self.assertEqual(f.read(), "disk is growing")


if __name__ == "__main__":
    unittest.main()
