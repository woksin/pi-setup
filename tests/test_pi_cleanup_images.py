"""Dev-image age-out in pi-cleanup: hostile cases keep the image (fail closed), removal never forces."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest
from unittest.mock import patch

from test_pi_cleanup import cleanup

DAY = 86400


def stamp(days):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - days * DAY))


class Docker:
    """Fake docker/git. images: (id, tags, created_days, last_tag_days|raw string, digests)."""

    def __init__(self, images, containers=(), grep=(0, '', ''), inspect_rc=0):
        self.images, self.containers, self.grep = images, list(containers), grep
        self.calls, self.inspect_rc = [], inspect_rc
        self.ids = {tag: image[0] for image in images for tag in image[1]}

    def inspect_line(self, image):
        iid, tags, created, last, digests = image
        last = last if isinstance(last, str) else stamp(last)
        return f"{iid}|{stamp(created)}|{json.dumps(tags)}|100|{json.dumps(digests)}|{json.dumps(last)}"

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        if cmd[:3] == ['docker', 'image', 'ls']:
            return 0, ''.join(i[0] + '\n' for i in self.images), ''
        if cmd[:2] == ['docker', 'ps']:
            return 0, ''.join(c[0] + '\n' for c in self.containers), ''
        if cmd[:2] == ['docker', 'inspect']:
            return 0, ''.join(f"{c[1]}|{c[2]}\n" for c in self.containers), ''
        if cmd[:3] == ['docker', 'image', 'inspect'] and cmd[3] == '-f' and cmd[4] == '{{.Id}}':
            return (0, self.ids.get(cmd[5], '') + '\n', '') if self.inspect_rc == 0 else (1, '', 'No such image')
        if cmd[:3] == ['docker', 'image', 'inspect']:
            return 0, ''.join(self.inspect_line(i) + '\n' for i in self.images), ''
        if cmd[:2] == ['docker', 'rmi']:
            return 0, 'Untagged', ''
        if cmd[:2] == ['git', 'grep']:
            return self.grep
        raise AssertionError(cmd)

    def rmis(self):
        return [c for c in self.calls if c[:2] == ['docker', 'rmi']]


class DevImageTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(tmp, ignore_errors=True))
        self.state = tmp
        env = patch.dict(os.environ, DOCKER_GUARDIAN_STATE=str(tmp))
        env.start()
        self.addCleanup(env.stop)
        self.checkout = type('C', (), {'path': str(tmp), 'exists': True})()

    def plan(self, docker, pins=None, dev=2, checkouts=True, refs=None):
        if pins is not None:
            (self.state / 'pinned.txt').write_text(pins)
        if refs is None:
            with patch.object(cleanup, 'run', side_effect=docker):
                refs, error = cleanup.dockerfile_refs([self.checkout] if checkouts else [])
            refs = None if error else refs
        with patch.object(cleanup, 'run', side_effect=docker):
            return cleanup.plan_rmi(7, None, dev, refs)

    def ids(self, items):
        return [i['id'] for i in items]

    def image(self, tag='cratis/chronicle:19.114.0-development', created=30, last=3, iid='sha256:a', digests=()):
        return (iid, tag if isinstance(tag, list) else [tag], created, last, list(digests))

    def test_a_unused_dev_tag_older_than_two_days_is_a_candidate(self):
        cands, kept, err = self.plan(Docker([self.image(created=3)]))
        self.assertIsNone(err)
        self.assertEqual(self.ids(cands), ['sha256:a'])
        self.assertTrue(cands[0]['dev'])

    def test_b_one_day_old_tag_is_kept(self):
        cands, kept, _ = self.plan(Docker([self.image(created=1, last=1)]))
        self.assertEqual((cands, kept), ([], []))

    def test_c_release_version_is_not_a_dev_candidate(self):
        cands, _, _ = self.plan(Docker([self.image('cratis/stage:4.210.2', created=3, last=3)]))
        self.assertEqual(cands, [])  # three days old: the 7-day general rule does not apply either

    def test_d_pinned_tag_is_kept(self):
        cands, kept, _ = self.plan(Docker([self.image('cratis/chronicle:l72-1265-baseline')]), 'cratis/chronicle:l72-*\n')
        self.assertEqual(cands, [])
        self.assertEqual(kept[0]['reason'], 'pinned: cratis/chronicle:l72-*')

    def test_e_used_by_id_or_by_name_is_absent(self):
        for container in (('c1', 'sha256:a', 'other'), ('c1', 'sha256:zzz', 'cratis/chronicle:19.114.0-development')):
            with self.subTest(container=container):
                cands, kept, _ = self.plan(Docker([self.image()], [container]))
                self.assertEqual((cands, kept), ([], []))

    def test_f_referenced_by_a_dockerfile_is_kept(self):
        docker = Docker([self.image('cratis/chronicle:19.112.1-development')],
                        grep=(0, 'cratis/chronicle:19.112.1-development\n', ''))
        cands, kept, _ = self.plan(docker)
        self.assertEqual(cands, [])
        self.assertEqual(kept[0]['reason'], 'referenced by Dockerfile/compose')

    def test_f2_registry_prefix_does_not_hide_a_reference(self):
        docker = Docker([self.image('cratis/chronicle:19.112.1-development')],
                        grep=(0, 'docker.io/cratis/chronicle:19.112.1-development\nghcr.io/cratis/x:1-dev\n', ''))
        self.assertEqual(self.plan(docker)[0], [])

    def test_g_failed_reference_scan_means_no_dev_candidates_but_general_rule_runs(self):
        for rc in (124, 128):
            with self.subTest(rc=rc):
                docker = Docker([self.image(created=3), self.image('mongo:7', created=30, last=30, iid='sha256:m')],
                                grep=(rc, '', 'boom'))
                with patch.object(cleanup, 'run', side_effect=docker):
                    refs, error = cleanup.dockerfile_refs([self.checkout])
                self.assertIn('repo reference scan failed', error)
                cands, _, _ = self.plan(docker, refs=None)
                self.assertEqual(self.ids(cands), ['sha256:m'])  # general 7-day rule only

    def test_g2_plan_docker_notes_a_failed_scan_and_never_removes_dev_images(self):
        ctx = cleanup.Ctx(cleanup.parse_args([]))
        ctx.docker_up = True
        ctx.checkouts = [self.checkout]
        docker = Docker([self.image(created=3)], grep=(128, '', 'fatal'))
        with patch.object(cleanup, 'run', side_effect=lambda cmd, **k: (0, '', '') if cmd[:2] == ['docker', 'system'] else docker(cmd, **k)):
            plan = cleanup.plan_docker(ctx)
        self.assertEqual(plan['rmi'], [])
        self.assertEqual(plan['notes'], [n for n in plan['notes'] if n.startswith('dev image age-out skipped: repo reference scan failed')])
        self.assertTrue(plan['notes'])

    def test_h_no_known_checkouts_skips_the_dev_rule_with_a_note(self):
        refs, error = cleanup.dockerfile_refs([])
        self.assertEqual(error, 'no checkouts known')
        ctx = cleanup.Ctx(cleanup.parse_args(['--only', 'docker']))
        ctx.docker_up = True
        docker = Docker([self.image(created=3)])
        with patch.object(cleanup, 'run', side_effect=lambda cmd, **k: (0, '', '') if cmd[:2] == ['docker', 'system'] else docker(cmd, **k)):
            plan = cleanup.plan_docker(ctx)
        self.assertEqual(plan['rmi'], [])
        self.assertEqual(plan['notes'], ['dev image age-out skipped: no checkouts known'])

    def test_i_old_created_but_recent_tag_is_kept(self):
        self.assertEqual(self.plan(Docker([self.image(created=400, last=1)]))[0], [])

    def test_j_zero_last_tag_time_falls_back_to_created(self):
        zero = '0001-01-01T00:00:00Z'
        self.assertEqual(self.ids(self.plan(Docker([self.image(created=3, last=zero)]))[0]), ['sha256:a'])
        self.assertEqual(self.plan(Docker([self.image(created=1, last=zero)]))[0], [])

    def test_k_multi_tag_image_is_one_candidate_and_apply_untags_each_ref_without_force(self):
        tags = ['cratis/chronicle:local-development', 'cratis/chronicle:latest-development']
        docker = Docker([self.image(tags, created=9, last=3)])
        cands, kept, _ = self.plan(docker)
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0]['refs'], tags)
        with patch.object(cleanup, 'run', side_effect=docker):
            cleanup.remove_image(cands[0])
        self.assertEqual(docker.rmis(), [['docker', 'rmi', t] for t in tags])
        self.assertEqual(cands[0]['result'], 'removed')
        self.assertFalse([c for c in docker.calls if '-f' in c[:3] or '--force' in c])

    def test_l_multi_tag_with_a_release_tag_stays_kept_by_the_general_rule(self):
        docker = Docker([self.image(['cratis/chronicle:19.1.0', 'cratis/chronicle:local-development'], created=30, last=30)])
        cands, kept, _ = self.plan(docker)
        self.assertEqual(cands, [])
        self.assertEqual(len(kept), 1)
        self.assertIn('tags', kept[0]['reason'])

    def test_m_foreign_images_are_not_touched_by_the_dev_rule(self):
        self.assertEqual(self.plan(Docker([self.image('mongo:dev', created=3, last=3)]))[0], [])

    def test_n_ghcr_images_qualify(self):
        cands, _, _ = self.plan(Docker([self.image('ghcr.io/cratis/ante:main-abc', created=3)]))
        self.assertEqual(len(cands), 1)

    def test_o_apply_skips_a_ref_whose_id_changed_or_vanished(self):
        item = {'id': 'sha256:a', 'tags': ['cratis/x:dev'], 'refs': ['cratis/x:dev'], 'dev': True}
        for docker in (Docker([('sha256:other', ['cratis/x:dev'], 1, 1, [])]), Docker([], inspect_rc=1)):
            with self.subTest(ids=docker.ids):
                item.pop('result', None)
                with patch.object(cleanup, 'run', side_effect=docker):
                    cleanup.remove_image(item)
                self.assertEqual(docker.rmis(), [])
                self.assertTrue(item['result'].startswith('skipped'))
                self.assertFalse(item.get('failed'))

    def test_p_unreadable_pin_file_fails_closed_with_the_dev_rule_on(self):
        docker = Docker([self.image(created=3)])
        with patch.object(cleanup, 'run', side_effect=docker), patch('builtins.open', side_effect=PermissionError('denied')):
            cands, kept, err = cleanup.plan_rmi(7, None, 2, set())
        self.assertEqual((cands, kept), ([], []))
        self.assertIn('cannot read docker pin file', err)
        self.assertEqual(docker.calls, [])

    def test_q_docker_errors_mean_no_candidates(self):
        for failing in (['docker', 'ps'], ['docker', 'inspect'], ['docker', 'image', 'ls']):
            with self.subTest(failing=failing):
                docker = Docker([self.image(created=3)], containers=[('c1', 'sha256:zzz', 'x')])
                real = docker.__call__
                def run(cmd, **k):
                    return (1, '', 'daemon error') if cmd[:len(failing)] == failing else real(cmd, **k)
                with patch.object(cleanup, 'run', side_effect=run):
                    cands, kept, err = cleanup.plan_rmi(7, None, 2, set())
                self.assertEqual(cands, [])
                self.assertTrue(err)

    def test_r_apply_recompute_never_forces_and_skips_when_a_container_uses_the_image(self):
        ctx = cleanup.Ctx(cleanup.parse_args([]))
        ctx.checkouts = [self.checkout]
        docker = Docker([self.image(created=3)], containers=[('c1', 'sha256:a', 'x')])
        d = {'prunes': [], 'rmi': [], 'rmi_kept': [], 'error': None}
        with patch.object(cleanup, 'run', side_effect=docker):
            cleanup.apply_docker(ctx, d)
        self.assertEqual(docker.rmis(), [])

    def test_s_apply_removes_unused_dev_image_after_recompute(self):
        ctx = cleanup.Ctx(cleanup.parse_args([]))
        ctx.checkouts = [self.checkout]
        docker = Docker([self.image(created=3)])
        d = {'prunes': [], 'rmi': [], 'rmi_kept': [], 'error': None}
        with patch.object(cleanup, 'run', side_effect=docker):
            cleanup.apply_docker(ctx, d)
        self.assertEqual(docker.rmis(), [['docker', 'rmi', 'cratis/chronicle:19.114.0-development']])

    def test_dev_flag_default_and_validation(self):
        self.assertEqual(cleanup.parse_args([]).dev_image_age_days, 2)
        self.assertEqual(cleanup.parse_args(['--dev-image-age-days', '0.5']).dev_image_age_days, 0.5)


if __name__ == '__main__':
    unittest.main()
